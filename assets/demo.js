// Demo booking page: details, then a time, then booked. Talks only to the
// two public routes on the reactivation edge function.
(() => {
'use strict';

const API = 'https://vcantdssoketpxaybtwh.supabase.co/functions/v1/reactivation/public';
// Cloudflare Turnstile (anti-spam): Reactivate's own widget. The site key is
// public by design; its secret is the CF_TURNSTILE_SECRET edge function
// secret, and the two must belong to the same widget or every booking fails
// the check.
const TURNSTILE_SITE_KEY = '0x4AAAAAABj4xsGpuNPXeW_7';

const $ = (s) => document.querySelector(s);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Brisbane';
let details = null, slots = [], chosen = null, day = null, cfToken = '', booked = null;

async function call(path, body) {
  const r = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
  return j;
}

function step(n) {
  [1, 2, 3].forEach((i) => { $(`#step${i}`).hidden = i !== n; });
  document.querySelectorAll('.steps li').forEach((li) => {
    const s = +li.dataset.s;
    li.classList.toggle('on', s === n);
    li.classList.toggle('done', s < n);
  });
  $('#book').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const dayLabel = (iso) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `<span>${p.weekday}</span><b>${p.day}</b><span>${p.month}</span>`;
};
const timeLabel = (iso) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const fullLabel = (iso) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));

function renderDays() {
  const byDay = {};
  slots.forEach((s) => { (byDay[dayKey(s)] = byDay[dayKey(s)] || []).push(s); });
  const keys = Object.keys(byDay);
  if (!keys.length) {
    $('#days').innerHTML = '';
    $('#times').innerHTML = '<p class="muted">No times are open right now. Email <a href="mailto:contact@quoteleads.com.au">contact@quoteleads.com.au</a> and we\'ll find one.</p>';
    return;
  }
  if (!day || !byDay[day]) day = keys[0];
  $('#days').innerHTML = keys.map((k) => `<button type="button" class="day ${k === day ? 'on' : ''}" data-day="${k}">${dayLabel(byDay[k][0])}</button>`).join('');
  $('#times').innerHTML = byDay[day].map((s) => `<button type="button" class="time ${s === chosen ? 'on' : ''}" data-slot="${s}">${timeLabel(s)}</button>`).join('');
  $('#confirm').disabled = !chosen;
}

async function loadSlots() {
  $('#times').innerHTML = '<p class="muted">Loading times…</p>';
  try {
    const r = await call('demo-slots');
    slots = r.slots || [];
    if (chosen && !slots.includes(chosen)) chosen = null;
    renderDays();
  } catch (e) {
    $('#times').innerHTML = `<p class="form-err">${e.message}</p>`;
  }
}

function mountTurnstile() {
  if (window.turnstile || !TURNSTILE_SITE_KEY) return;
  window.onRxTurnstile = () => {
    try {
      window.turnstile.render('#turnstile', {
        sitekey: TURNSTILE_SITE_KEY, theme: 'dark',
        callback: (t) => { cfToken = t; },
        'expired-callback': () => { cfToken = ''; },
        'error-callback': () => { $('#turnstile').hidden = true; },
      });
    } catch { $('#turnstile').hidden = true; }
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onRxTurnstile';
  s.async = true;
  s.onerror = () => { $('#turnstile').hidden = true; };
  document.head.appendChild(s);
}

$('#step1').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const v = Object.fromEntries(new FormData(f).entries());
  const err = (m) => { $('#err1').textContent = m; };
  if (!v.name || v.name.trim().length < 2) return err('Please enter your name.');
  if (!v.business?.trim()) return err('Please enter your business name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email || '')) return err('Please enter a valid email.');
  if ((v.phone || '').replace(/\D/g, '').length < 8) return err('Please enter your mobile number.');
  if (!v.industry) return err('Please choose your industry.');
  if (!v.lead_count) return err('Please choose roughly how many old leads you have.');
  if (!f.consent.checked) return err('Please tick the box so we can contact you about the demo.');
  err('');
  details = { ...v, consent: true };
  $('#tz-note').textContent = `Times are shown in your timezone (${tz.replace(/_/g, ' ')}).`;
  step(2);
  loadSlots();
  mountTurnstile();
});

$('#back1').addEventListener('click', () => step(1));
$('#days').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (b) { day = b.dataset.day; renderDays(); } });
$('#times').addEventListener('click', (e) => { const b = e.target.closest('[data-slot]'); if (b) { chosen = b.dataset.slot; renderDays(); } });

$('#confirm').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Booking…';
  $('#err2').textContent = '';
  try {
    booked = await call('demo-book', { ...details, slot_start: chosen, tz, cf_token: cfToken });
    $('#done-when').textContent = fullLabel(booked.slot_start || chosen);
    $('#done-email').textContent = details.email;
    step(3);
  } catch (err) {
    $('#err2').textContent = err.message;
    if (err.status === 409) { chosen = null; loadSlots(); }
    if (window.turnstile) { try { window.turnstile.reset('#turnstile'); cfToken = ''; } catch { /* ignore */ } }
  } finally {
    btn.textContent = 'Book my demo';
    btn.disabled = !chosen;
  }
});

// A calendar file made in the browser, so "Add to calendar" works even
// before the confirmation email arrives.
$('#ics').addEventListener('click', () => {
  if (!booked) return;
  const f = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//QuoteLeads//Reactivate//EN', 'BEGIN:VEVENT',
    `UID:${f(booked.slot_start)}-${Math.random().toString(36).slice(2)}@reactivate.quoteleads.com.au`, `DTSTAMP:${f(new Date().toISOString())}`,
    `DTSTART:${f(booked.slot_start)}`, `DTEND:${f(booked.slot_end)}`, 'SUMMARY:Reactivate demo with QuoteLeads',
    'DESCRIPTION:Your Reactivate demo. Questions? contact@quoteleads.com.au', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'reactivate-demo.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#year').textContent = new Date().getFullYear();
})();
