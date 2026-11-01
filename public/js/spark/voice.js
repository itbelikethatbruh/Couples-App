/* Couples App · 15-second voice notes
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * iPhone Safari records audio/mp4 (AAC); Chrome on Android records
 * audio/webm (Opus). Both play back on both phones on current OS versions.
 * Files go to the private "voice-notes" bucket under {couple}/{user}/.
 */
import { toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, icon, pressable, clear, haptic, timeAgo } from '../ui.js';
import { onTable, onResync } from '../realtime.js';
import { uploadTo, signedUrl } from '../media.js';
import { myId, nameOf, section, disposer } from './common.js';

const MAX_MS = 15_000;
const BUCKET = 'voice-notes';

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

export function mount(host) {
  const dispose = disposer();
  const recorderHost = h('div.voice-recorder');
  const list = h('div.voice-list');
  host.append(section('voice-card', 'Voice notes', recorderHost, list));

  let notes = [];
  let player = null;
  let playingId = null;

  // ---- recorder state machine: idle → recording → review ----
  let stream = null;
  let rec = null;
  let chunks = [];
  let startedAt = 0;
  let tick = 0;
  let pending = null;   // { blob, ms, mime, url }

  function renderRecorder(mode = 'idle', elapsed = 0) {
    clear(recorderHost);
    if (mode === 'review' && pending) {
      const audio = h('audio', { src: pending.url, preload: 'auto' });
      const play = pressable(h('button.btn.btn-glass', { type: 'button' }, '▶ Preview'));
      play.addEventListener('click', () => { audio.currentTime = 0; audio.play(); });
      const send = pressable(h('button.btn.btn-primary', { type: 'button' }, icon('send', { size: 16 }), ' Send'));
      const discard = pressable(h('button.btn.btn-ghost', { type: 'button' }, 'Discard'));
      send.addEventListener('click', () => upload(send));
      discard.addEventListener('click', () => { URL.revokeObjectURL(pending.url); pending = null; renderRecorder(); });
      recorderHost.append(h('div.voice-review',
        h('span.voice-len', `${(pending.ms / 1000).toFixed(1)}s`), audio, play, send, discard));
      return;
    }
    const pct = Math.min(1, elapsed / MAX_MS);
    const C = 2 * Math.PI * 34;
    const ring = h('span.voice-ring', { html:
      `<svg viewBox="0 0 76 76" width="76" height="76" aria-hidden="true">
        <circle cx="38" cy="38" r="34" class="track"/>
        <circle cx="38" cy="38" r="34" class="bar" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}"/>
      </svg>` });
    const btn = pressable(h('button.voice-btn' + (mode === 'recording' ? '.recording' : ''),
      { type: 'button', 'aria-label': mode === 'recording' ? 'Stop recording' : 'Record a voice note' },
      ring, h('span.voice-dot')));
    btn.addEventListener('click', () => (mode === 'recording' ? stop() : start()));
    recorderHost.append(btn, h('div.voice-hint',
      mode === 'recording'
        ? h('strong', `${(elapsed / 1000).toFixed(1)}s / 15s`)
        : h('span.muted', 'Tap to record up to 15 seconds')));
  }

  async function start() {
    const mime = pickMime();
    if (mime === null || !navigator.mediaDevices?.getUserMedia) {
      toast('Voice recording is not supported in this browser', { tone: 'error' });
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast('Microphone access was blocked', { tone: 'error' });
      return;
    }
    chunks = [];
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64_000 } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = finish;
    rec.start(250);
    startedAt = performance.now();
    haptic(12);
    const loop = () => {
      const el = performance.now() - startedAt;
      if (el >= MAX_MS) { stop(); return; }
      renderRecorder('recording', el);
      tick = requestAnimationFrame(loop);
    };
    loop();
  }

  function stop() {
    cancelAnimationFrame(tick);
    if (rec && rec.state !== 'inactive') rec.stop();
  }

  function finish() {
    const ms = Math.min(MAX_MS, Math.round(performance.now() - startedAt));
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const mime = (rec?.mimeType || chunks[0]?.type || 'audio/webm').split(';')[0];
    rec = null;
    if (ms < 400 || !chunks.length) { toast('Too short'); renderRecorder(); return; }
    const blob = new Blob(chunks, { type: mime });
    pending = { blob, ms, mime, url: URL.createObjectURL(blob) };
    haptic(8);
    renderRecorder('review');
  }

  async function upload(btn) {
    btn.disabled = true;
    try {
      const ext = pending.mime.includes('mp4') ? 'm4a' : pending.mime.includes('ogg') ? 'ogg' : 'webm';
      const path = await uploadTo(BUCKET, `${Date.now()}.${ext}`, pending.blob, pending.mime);
      const row = unwrap(await supabase.from('voice_notes')
        .insert({ storage_path: path, duration_ms: Math.max(300, pending.ms), mime_type: pending.mime })
        .select().single());
      URL.revokeObjectURL(pending.url);
      pending = null;
      upsertNote(row);
      renderRecorder();
      toast('Voice note sent 🎙️', { tone: 'love' });
    } catch (err) {
      toast(err.message, { tone: 'error' });
      btn.disabled = false;
    }
  }

  // ---- list ----
  function upsertNote(row) {
    notes = [row, ...notes.filter((n) => n.id !== row.id)]
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8);
    renderList();
  }

  function renderList() {
    clear(list);
    if (!notes.length) { list.append(h('p.muted.small', 'No voice notes yet. Leave the first one.')); return; }
    for (const n of notes) {
      const mine = n.created_by === myId();
      const unheard = !mine && !n.listened_at;
      const btn = pressable(h('button.voice-play' + (playingId === n.id ? '.playing' : ''),
        { type: 'button', 'aria-label': playingId === n.id ? 'Pause' : 'Play' }, playingId === n.id ? '❚❚' : '▶'));
      btn.addEventListener('click', () => play(n));
      list.append(h('div.voice-item' + (unheard ? '.unheard' : ''),
        btn,
        h('div.voice-meta',
          h('strong', mine ? 'You' : nameOf(n.created_by)),
          h('span.muted.small', `${(n.duration_ms / 1000).toFixed(0)}s · ${timeAgo(n.created_at)}`)),
        unheard ? h('span.badge-new', 'New') : null));
    }
  }

  async function play(n) {
    if (playingId === n.id && player) { player.pause(); playingId = null; renderList(); return; }
    player?.pause();
    try {
      const url = await signedUrl(BUCKET, n.storage_path);
      player = new Audio(url);
      playingId = n.id;
      player.onended = () => { playingId = null; renderList(); };
      await player.play();
      renderList();
      if (n.created_by !== myId() && !n.listened_at) {
        const listened_at = new Date().toISOString();
        n.listened_at = listened_at;
        supabase.from('voice_notes').update({ listened_at }).eq('id', n.id).then(() => {}, () => {});
      }
    } catch (err) {
      playingId = null;
      toast(err.message || 'Could not play', { tone: 'error' });
      renderList();
    }
  }

  async function load() {
    try {
      notes = unwrap(await supabase.from('voice_notes').select('*').order('created_at', { ascending: false }).limit(8));
      renderList();
    } catch (err) { console.warn('[voice]', err); }
  }

  dispose(onTable('voice_notes', (row, _o, type) => {
    if (type === 'DELETE') { notes = notes.filter((n) => n.id !== _o?.id); renderList(); return; }
    upsertNote(row);
    if (type === 'INSERT' && row.created_by !== myId()) {
      toast(`🎙️ ${nameOf(row.created_by)} left you a voice note`, { tone: 'love' });
      haptic([15, 40, 15]);
    }
  }));
  dispose(onResync(load));
  dispose(() => { stop(); stream?.getTracks().forEach((t) => t.stop()); player?.pause(); });

  renderRecorder();
  load();
  return dispose.run;
}
