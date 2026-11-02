// Us · home-screen widget for Scriptable (iPhone)
// Copyright (c) 2026. All Rights Reserved. See LICENSE.
//
// Setup (about one minute):
//   1. Install "Scriptable" from the App Store (free).
//   2. In the Us app: Discover → iPhone setup → Copy widget script.
//   3. Scriptable → + → paste → name it "Us".
//   4. Long-press the Home Screen → + → Scriptable → pick a size →
//      tap the widget → Script: Us.
//
// The copied script already contains your private token. Don't share it:
// it can add things to your space and read the numbers shown below.
// Revoke it any time in Discover → iPhone setup.

const SUPABASE_URL = '__SUPABASE_URL__';
const ANON_KEY = '__ANON_KEY__';          // public key, safe to ship
const TOKEN = '__TOKEN__';                // your private token
const APP_URL = '__APP_URL__';

const ROSE = new Color('#ff2d78');
const VIOLET = new Color('#9b5cff');
const INK = new Color('#f5f3ff');
const MUTED = new Color('#f5f3ff', 0.62);

async function load() {
  const req = new Request(`${SUPABASE_URL}/rest/v1/rpc/widget_summary`);
  req.method = 'POST';
  req.headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };
  req.body = JSON.stringify({ p_token: TOKEN });
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  if (req.response && req.response.statusCode >= 400) throw new Error(data.message || 'Could not load');
  return data;
}

function countdownLine(next) {
  if (!next) return 'Add a date in the Vault';
  const days = next.days;
  const when = days === 0 ? 'today 🎉' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return `${next.title} ${when}`;
}

function stat(stack, value, label) {
  const s = stack.addStack();
  s.layoutVertically();
  const v = s.addText(String(value));
  v.font = Font.heavyRoundedSystemFont(22);
  v.textColor = INK;
  const l = s.addText(label);
  l.font = Font.mediumSystemFont(10);
  l.textColor = MUTED;
}

async function build() {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [new Color('#16081f'), new Color('#2a0c2e'), new Color('#0b0a1a')];
  g.locations = [0, 0.55, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;
  w.setPadding(14, 14, 14, 14);
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  let d;
  try {
    d = await load();
  } catch (err) {
    const t = w.addText('Us');
    t.font = Font.heavyRoundedSystemFont(18);
    t.textColor = ROSE;
    w.addSpacer(6);
    const e = w.addText(String(err.message || err).includes('revoked') ? 'Token revoked. Copy a new script from the app.' : 'Offline. Will retry.');
    e.font = Font.mediumSystemFont(12);
    e.textColor = MUTED;
    return w;
  }

  const head = w.addStack();
  head.centerAlignContent();
  const heart = head.addText('💞');
  heart.font = Font.systemFont(16);
  head.addSpacer(6);
  const names = head.addText(d.partner ? `${d.me} & ${d.partner}` : d.me || 'Us');
  names.font = Font.heavyRoundedSystemFont(14);
  names.textColor = INK;
  names.lineLimit = 1;

  w.addSpacer(8);
  const next = w.addText(countdownLine(d.next_date));
  next.font = Font.boldRoundedSystemFont(config.widgetFamily === 'small' ? 13 : 15);
  next.textColor = ROSE;
  next.lineLimit = 2;

  w.addSpacer();
  const row = w.addStack();
  stat(row, d.unwatched_tiktoks, 'new TikToks');
  row.addSpacer();
  stat(row, d.open_items, 'to-dos');
  if (config.widgetFamily !== 'small') {
    row.addSpacer();
    stat(row, d.bills_due_week, 'bills this week');
  }

  w.addSpacer(4);
  const foot = w.addText(`Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  foot.font = Font.mediumSystemFont(9);
  foot.textColor = VIOLET;
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
