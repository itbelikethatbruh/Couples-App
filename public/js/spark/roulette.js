/* Couples App · Date Night Roulette
 * Copyright (c) 2026. All Rights Reserved. See LICENSE.
 *
 * A 3D-tilted wheel drawn on canvas. The winner is chosen with
 * crypto.getRandomValues (weighted), then the wheel spins to land on it.
 * The result is broadcast so both phones see the same spin live.
 */
import { toast } from '../store.js';
import { supabase, unwrap } from '../supabase.js';
import { h, pressable, clear, haptic } from '../ui.js';
import { motionAllowed } from '../fx.js';
import { onTable, onBroadcast, onResync, broadcast } from '../realtime.js';
import { formSheet, celebrate } from '../sheet.js';
import { nameOf, section, disposer } from './common.js';

const COLORS = ['#ff2d78', '#7a5cff', '#3d8bff', '#00c2a8', '#ffb547', '#ff5e3a', '#c13cff', '#5b5bff'];

export function mount(host) {
  const dispose = disposer();
  const canvas = h('canvas.wheel-canvas', { width: 600, height: 600, role: 'img', 'aria-label': 'Date night wheel' });
  const wheel = h('div.wheel', h('div.wheel-rotor', canvas), h('div.wheel-pointer', { 'aria-hidden': 'true' }), h('div.wheel-hub', { 'aria-hidden': 'true' }, '♥'));
  const spin = pressable(h('button.btn.btn-primary', { type: 'button' }, '🎲 Spin'));
  const add = pressable(h('button.btn.btn-ghost', { type: 'button' }, '+ Idea'));
  const manage = h('div.idea-chips');
  host.append(section('roulette-card', 'Date night roulette', wheel, h('div.btn-row.center', spin, add), manage));

  let ideas = [];
  let angle = 0;          // radians, current rotation
  let spinning = false;
  const rotor = wheel.querySelector('.wheel-rotor');

  function draw() {
    const ctx = canvas.getContext('2d');
    const n = ideas.length;
    const r = 290;
    ctx.clearRect(0, 0, 600, 600);
    ctx.save();
    ctx.translate(300, 300);
    if (!n) {
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      return;
    }
    const slice = (Math.PI * 2) / n;
    ideas.forEach((idea, i) => {
      const a0 = i * slice - Math.PI / 2;
      const grad = ctx.createRadialGradient(0, 0, 40, 0, 0, r);
      const c = COLORS[i % COLORS.length];
      grad.addColorStop(0, shade(c, -35));
      grad.addColorStop(1, c);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, a0, a0 + slice); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.save();
      ctx.rotate(a0 + slice / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 6;
      ctx.font = `600 ${n > 10 ? 20 : 24}px -apple-system, Roboto, system-ui, sans-serif`;
      const label = `${idea.title.length > 18 ? idea.title.slice(0, 17) + '…' : idea.title} ${idea.emoji}`;
      ctx.fillText(label, r - 22, 0);
      ctx.restore();
    });
    // glossy rim
    const rim = ctx.createLinearGradient(0, -r, 0, r);
    rim.addColorStop(0, 'rgba(255,255,255,.55)'); rim.addColorStop(.5, 'rgba(255,255,255,.05)'); rim.addColorStop(1, 'rgba(255,255,255,.25)');
    ctx.strokeStyle = rim; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(0, 0, r - 4, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function setAngle(a) {
    angle = a;
    rotor.style.transform = `rotate(${a}rad)`;
  }

  function pickIndex() {
    const total = ideas.reduce((s, i) => s + i.weight, 0);
    const rand = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * total;
    let acc = 0;
    for (let i = 0; i < ideas.length; i++) { acc += ideas[i].weight; if (rand < acc) return i; }
    return ideas.length - 1;
  }

  /** Spin to land slice `index` under the top pointer. */
  function animateTo(index, turns, onDone) {
    const n = ideas.length;
    const slice = (Math.PI * 2) / n;
    const jitter = (Math.random() - 0.5) * slice * 0.6;
    const targetMod = -(index * slice + slice / 2) + jitter;
    const base = angle - (angle % (Math.PI * 2));
    const target = base + turns * Math.PI * 2 + ((targetMod % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const start = angle;
    const dur = motionAllowed() ? 4200 : 0;
    const t0 = performance.now();
    let lastTick = Math.floor(start / slice);
    const step = (now) => {
      const p = dur ? Math.min(1, (now - t0) / dur) : 1;
      const e = 1 - Math.pow(1 - p, 4);       // ease-out quart
      const a = start + (target - start) * e;
      setAngle(a);
      const tickIdx = Math.floor(a / slice);
      if (tickIdx !== lastTick) { lastTick = tickIdx; haptic(3); }
      if (p < 1) requestAnimationFrame(step);
      else onDone();
    };
    requestAnimationFrame(step);
  }

  function run(index, by) {
    if (spinning || !ideas[index]) return;
    spinning = true;
    spin.disabled = true;
    wheel.classList.add('spinning');
    animateTo(index, 6, () => {
      spinning = false;
      spin.disabled = false;
      wheel.classList.remove('spinning');
      const idea = ideas[index];
      haptic([20, 60, 20]);
      celebrate({
        emoji: idea.emoji,
        title: idea.title,
        body: by ? `${nameOf(by)} spun the wheel. Tonight's date is decided.` : 'Tonight’s date is decided.',
        actions: [{ label: '📅 Lock it in on our calendar', primary: true, onClick: () => lockIn(idea) }]
      });
    });
  }

  spin.addEventListener('click', () => {
    if (ideas.length < 2) { toast('Add at least two ideas'); return; }
    const index = pickIndex();
    broadcast('roulette:spin', { idea_id: ideas[index].id });
    run(index, null);
  });
  add.addEventListener('click', addIdea);

  function renderChips() {
    clear(manage);
    for (const i of ideas) {
      const chip = h('span.chip.chip-sm', `${i.emoji} ${i.title}`);
      const x = h('button.chip-x', { type: 'button', 'aria-label': `Remove ${i.title}` }, '×');
      x.addEventListener('click', async () => {
        const { error } = await supabase.from('date_ideas').update({ active: false }).eq('id', i.id);
        if (error) toast(error.message, { tone: 'error' });
      });
      chip.append(x);
      manage.append(chip);
    }
  }

  async function load() {
    try {
      await supabase.rpc('ensure_couple_defaults');
      ideas = unwrap(await supabase.from('date_ideas').select('*').eq('active', true).order('created_at')).slice(0, 16);
    } catch (err) { console.warn('[roulette]', err); }
    draw();
    renderChips();
  }

  async function addIdea() {
    await formSheet('Add a date idea', [
      { name: 'title', label: 'Idea', required: true, maxlength: 120, placeholder: 'Rooftop drinks' },
      { name: 'emoji', label: 'Emoji', maxlength: 8, value: '✨' },
      { name: 'weight', label: 'How much do you want it? (1–10)', type: 'number', value: 1, min: 1, max: 10, inputmode: 'numeric' }
    ], {
      submitLabel: 'Add to wheel',
      onSubmit: async (v) => {
        unwrap(await supabase.from('date_ideas').insert({
          title: v.title, emoji: v.emoji || '✨', weight: Math.max(1, Math.min(10, Math.round(Number(v.weight) || 1)))
        }));
      }
    });
  }

  dispose(onBroadcast('roulette:spin', (p) => {
    const idx = ideas.findIndex((i) => i.id === p.idea_id);
    if (idx >= 0) run(idx, p.from);
  }));
  dispose(onTable('date_ideas', load));
  dispose(onResync(load));
  load();
  return dispose.run;
}

async function lockIn(idea) {
  const start = new Date();
  start.setHours(19, 30, 0, 0);
  if (start < new Date()) start.setDate(start.getDate() + 1);
  const { error } = await supabase.from('calendar_events').insert({
    title: `Date night: ${idea.title}`, starts_at: start.toISOString(), source_type: 'date_idea', source_id: idea.id
  });
  toast(error ? error.message : 'Locked in on your calendar', { tone: error ? 'error' : 'ok' });
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + amt));
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}
