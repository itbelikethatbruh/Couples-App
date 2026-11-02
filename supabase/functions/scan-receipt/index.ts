// Couples App · scan-receipt Edge Function
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// POST { receipt_id }  (Authorization: the signed-in user's JWT)
//
// 1. Reads the receipts row and its photo AS the caller (RLS applies).
// 2. Sends the photo to Claude and asks for structured JSON.
// 3. Writes merchant / date / total / category / line items back to the row.
//
// The app then shows the result in a review sheet; nothing is booked as an
// expense until a person confirms it.
//
// Secrets:  ANTHROPIC_API_KEY (required)
//           RECEIPT_MODEL     (optional, defaults to claude-opus-5-5)
import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';
import { serve, json, userClient, HttpError, toBase64 } from '../_shared/http.ts';

const MODEL = Deno.env.get('RECEIPT_MODEL') || 'claude-opus-5-5';
const DAILY_LIMIT = 40;               // scans per couple per day; keeps a stolen session from running up the bill
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const CATEGORIES = [
  'groceries', 'dining', 'household', 'transport', 'gas', 'utilities', 'health',
  'entertainment', 'shopping', 'travel', 'gifts', 'pets', 'kids', 'other'
] as const;

// Structured outputs accept anyOf (not type arrays) for nullable fields.
const nullable = (t: string, description?: string) =>
  ({ anyOf: [{ type: t }, { type: 'null' }], ...(description ? { description } : {}) });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_receipt', 'merchant', 'purchased_on', 'currency', 'subtotal', 'tax', 'tip', 'total', 'category', 'bucket', 'line_items'],
  properties: {
    is_receipt: { type: 'boolean', description: 'False if the image is not a receipt or invoice.' },
    merchant: nullable('string'),
    purchased_on: nullable('string', 'Purchase date as YYYY-MM-DD, or null if not printed.'),
    currency: { type: 'string', description: 'ISO 4217 code, e.g. USD.' },
    subtotal: nullable('number'),
    tax: nullable('number'),
    tip: nullable('number'),
    total: nullable('number', 'The final amount charged, in currency units (e.g. 23.45).'),
    category: { type: 'string', enum: [...CATEGORIES] },
    bucket: { type: 'string', enum: ['needs', 'wants', 'savings'], description: '50/30/20 bucket: essentials are needs, discretionary spending is wants.' },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'quantity', 'amount'],
        properties: {
          name: { type: 'string' },
          quantity: nullable('number'),
          amount: nullable('number', 'Line total in currency units.')
        }
      }
    }
  }
};

const PROMPT = `Read this receipt and fill in the JSON fields.
- Copy amounts exactly as printed. "total" is the final amount paid, including tax and tip.
- Use null for anything that is not printed or not legible. Do not guess numbers.
- Dates: convert to YYYY-MM-DD. If the year is missing, use null.
- Keep line item names short and readable (expand obvious abbreviations).
- If the image is not a receipt or invoice, set is_receipt to false and leave the rest null or empty.`;

type Extracted = {
  is_receipt: boolean;
  merchant: string | null;
  purchased_on: string | null;
  currency: string;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  category: string;
  bucket: 'needs' | 'wants' | 'savings';
  line_items: { name: string; quantity: number | null; amount: number | null }[];
};

const toCents = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;

const validDate = (s: string | null) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  return year >= 2000 && year <= new Date().getUTCFullYear() + 1 ? s : null;
};

serve(async (req) => {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new HttpError(503, 'Receipt scanning is not set up yet (missing ANTHROPIC_API_KEY).');

  const { db } = await userClient(req);
  const body = await req.json().catch(() => ({}));
  const receiptId = typeof body?.receipt_id === 'string' ? body.receipt_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(receiptId)) throw new HttpError(400, 'receipt_id is required');

  const { data: receipt, error } = await db.from('receipts').select('*').eq('id', receiptId).maybeSingle();
  if (error) throw new HttpError(400, error.message);
  if (!receipt) throw new HttpError(404, 'Receipt not found');

  // Per-couple daily cap (counts scans that reached the AI today).
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from('receipts').select('id', { count: 'exact', head: true })
    .not('ai_raw', 'is', null).gte('updated_at', since);
  if ((count ?? 0) >= DAILY_LIMIT) throw new HttpError(429, 'Daily scan limit reached. Enter this one by hand.');

  await db.from('receipts').update({ status: 'processing', error: null }).eq('id', receiptId);

  const fail = async (message: string, status = 422) => {
    await db.from('receipts').update({ status: 'error', error: message }).eq('id', receiptId);
    return json({ error: message }, status);
  };

  const { data: file, error: dlError } = await db.storage.from('receipts').download(receipt.storage_path);
  if (dlError || !file) return fail('Could not read the receipt photo.', 404);
  if (file.size > 8 * 1024 * 1024) return fail('That file is too large to scan (8 MB max).', 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = (file.type || '').toLowerCase();
  const data = toBase64(bytes);
  const source = type === 'application/pdf'
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
    : IMAGE_TYPES.has(type)
      ? { type: 'image' as const, source: { type: 'base64' as const, media_type: type as 'image/jpeg', data } }
      : null;
  if (!source) return fail('Use a JPEG, PNG or PDF receipt.', 415);

  const client = new Anthropic({ apiKey });
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: [source, { type: 'text', text: PROMPT }] }]
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return fail('The scanner is busy. Try again in a minute.', 429);
    if (err instanceof Anthropic.AuthenticationError) return fail('The scanner API key is invalid.', 503);
    if (err instanceof Anthropic.APIError) return fail(`The scanner failed (${err.status ?? 'network'}).`, 502);
    throw err;
  }

  if (response.stop_reason === 'refusal') return fail('The scanner could not read this image.');
  if (response.stop_reason === 'max_tokens') return fail('This receipt is too long to read in one go.');

  // deno-lint-ignore no-explicit-any
  const text = (response.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out: Extracted;
  try { out = JSON.parse(text); } catch { return fail('The scanner returned something unreadable. Try again.'); }
  if (!out.is_receipt) return fail('That does not look like a receipt.');

  const lineItems = (out.line_items || []).slice(0, 200).map((li) => ({
    name: String(li.name || '').slice(0, 120),
    quantity: typeof li.quantity === 'number' ? li.quantity : null,
    amount_cents: toCents(li.amount)
  }));

  const patch = {
    status: 'done',
    error: null,
    merchant: out.merchant ? out.merchant.slice(0, 120) : null,
    purchased_on: validDate(out.purchased_on),
    category: CATEGORIES.includes(out.category as typeof CATEGORIES[number]) ? out.category : 'other',
    total_cents: toCents(out.total),
    line_items: lineItems,
    ai_raw: { model: response.model, currency: out.currency, subtotal: out.subtotal, tax: out.tax, tip: out.tip, bucket: out.bucket }
  };
  const { data: saved, error: upError } = await db.from('receipts').update(patch).eq('id', receiptId).select('*').single();
  if (upError) throw new HttpError(400, upError.message);
  return json({ receipt: saved });
});
