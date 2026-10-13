// Homepage. The demo is a FIXED, scripted conversation played in the browser:
// it calls no API (OpenAI, Supabase, Twilio or anything else), so it costs
// nothing to run however often it's played. The page's security policy blocks
// outgoing connections entirely to keep it that way. Every business in it is
// fictional ("Acme").
/* global createOrb */
(() => {
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Line icons from the page's sprite (index.html).
const ic = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"></use></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 120) : ms));

// ---- Hero orb ----
const heroCanvas = $('#hero-orb');
const heroOrb = heroCanvas && typeof createOrb === 'function' ? createOrb(heroCanvas) : null;
if (heroOrb) setInterval(() => heroOrb.pulse(1), 2600);

// ---- Scripts ----
// a = agent text, l = lead text, q = [question key, answer] ticks a box,
// e = 'interested' | 'booked' marks an anchor.
const SCRIPTS = {
  solar: {
    label: 'Solar', bot: 'Sarah', company: 'Acme Solar', lead: 'Michelle', service: '6.6kW solar system',
    qs: [['owner', 'Owns the home?'], ['bill', 'Quarterly power bill'], ['battery', 'Battery too?']],
    steps: [
      { a: "Hi Michelle, it's Sarah from Acme Solar. Is this the same Michelle who was looking into solar panels recently? Reply STOP to opt out." },
      { l: "Yes that's me! We put it off over winter", e: 'interested' },
      { a: 'No worries at all. Quick one so the team can prepare: do you own the home the panels would go on?' },
      { l: 'Yep we own it', q: ['owner', 'Yes'] },
      { a: "Perfect. Roughly what's your quarterly power bill these days?" },
      { l: "About $900, it's getting silly", q: ['bill', '~$900'] },
      { a: 'That helps. Are you interested in a battery as well, or just panels?' },
      { l: 'Probably both', q: ['battery', 'Yes, both'] },
      { a: 'Great. One of our consultants can walk you through options and pricing. Would Thursday at 2:30pm or Friday at 10am suit for a quick call?' },
      { l: 'Thursday works' },
      { a: "Done! You're booked for Thursday at 2:30pm and the team will call you on this number. Chat then, Michelle.", e: 'booked' },
    ],
  },
  roofing: {
    label: 'Roofing', bot: 'Jess', company: 'Acme Roofing', lead: 'Dave', service: 'roof restoration',
    qs: [['type', 'Repair or re-roof?'], ['leak', 'Leaking now?'], ['suburb', 'Suburb']],
    steps: [
      { a: "Hi Dave, it's Jess from Acme Roofing. Is this the same Dave who asked about a roof restoration recently? Reply STOP to opt out." },
      { l: 'Yeah mate still need it done', e: 'interested' },
      { a: 'Good to hear. Is it a repair, a restoration or a full re-roof you need?' },
      { l: 'Restoration I think, tiles are pretty tired', q: ['type', 'Restoration'] },
      { a: 'Got it. Is it leaking at the moment?' },
      { l: 'A bit in the back room when it buckets down', q: ['leak', 'Yes, minor'] },
      { a: 'Okay, worth getting on to. What suburb is the property in?' },
      { l: 'Penrith', q: ['suburb', 'Penrith'] },
      { a: 'Thanks Dave. Our estimator can give you a call to book an inspection. Would tomorrow at 11am or Wednesday at 3pm work?' },
      { l: 'Tomorrow 11 is good' },
      { a: "Locked in for tomorrow at 11am. They'll call you on this number. Cheers Dave!", e: 'booked' },
    ],
  },
  dental: {
    label: 'Dental', bot: 'Chloe', company: 'Acme Dental', lead: 'Priya', service: 'teeth whitening',
    qs: [['treatment', 'Treatment'], ['pain', 'In pain?'], ['fund', 'Health fund extras?']],
    steps: [
      { a: "Hi Priya, it's Chloe from Acme Dental. Is this the same Priya who was asking about teeth whitening recently? Reply STOP to opt out." },
      { l: 'Hi yes! Still thinking about it', e: 'interested' },
      { a: "Lovely. Is it whitening you're after, or were there any other treatments you wanted to ask about?" },
      { l: 'Just whitening for now', q: ['treatment', 'Whitening'] },
      { a: 'No problem. Any pain or sensitivity at the moment?' },
      { l: 'Nope all good', q: ['pain', 'No'] },
      { a: 'Great. Do you have private health cover with extras?' },
      { l: 'Yes, with extras', q: ['fund', 'Yes'] },
      { a: 'Thanks Priya. Our team can call to go through options and book you in. Would Monday at 12:30pm or Tuesday at 4pm suit?' },
      { l: 'Tuesday 4 please' },
      { a: "You're booked for a call on Tuesday at 4pm. Speak soon, Priya!", e: 'booked' },
    ],
  },
  mortgages: {
    label: 'Mortgages', bot: 'Emma', company: 'Acme Home Loans', lead: 'James', service: 'a home loan',
    qs: [['purpose', 'Purpose'], ['timeframe', 'Timeframe'], ['work', 'Employment']],
    steps: [
      { a: "Hi James, it's Emma from Acme Home Loans. You reached out about a home loan a while ago. Is that still on the cards? Reply STOP to opt out." },
      { l: 'Yeah we are looking again now actually', e: 'interested' },
      { a: 'Great timing. Is it for buying a home, refinancing, or an investment property?' },
      { l: 'Buying our first place', q: ['purpose', 'First home'] },
      { a: 'Exciting! When are you hoping to have finance sorted?' },
      { l: 'Next 2-3 months. What rate could we get?', q: ['timeframe', '2-3 months'] },
      { a: "I can't advise on rates by text, but one of our brokers can go through that properly with you. Are you PAYG or self-employed?" },
      { l: 'Both PAYG', q: ['work', 'PAYG'] },
      { a: 'Perfect. Would Thursday at 6pm or Saturday at 10am work for a call with a broker?' },
      { l: 'Saturday 10' },
      { a: "Booked in for Saturday at 10am. A broker will call you on this number. Talk then, James!", e: 'booked' },
    ],
  },
  'car-finance': {
    label: 'Car finance', bot: 'Mia', company: 'Acme Car Finance', lead: 'Tom', service: 'car finance',
    qs: [['vehicle', 'Found the car?'], ['amount', 'Amount'], ['work', 'Employment']],
    steps: [
      { a: "Hey Tom, Mia from Acme Car Finance here. Still on the hunt for a car? Reply STOP to opt out." },
      { l: 'Yep still looking', e: 'interested' },
      { a: 'Nice. Have you found the car yet, or still shopping around?' },
      { l: 'Found a 2021 Ranger I like', q: ['vehicle', 'Yes, 2021 Ranger'] },
      { a: 'Good choice. Roughly how much are you looking to finance?' },
      { l: 'Around 45k', q: ['amount', '~$45k'] },
      { a: 'And are you working full time, part time or self-employed?' },
      { l: 'Full time', q: ['work', 'Full time'] },
      { a: 'Thanks Tom. A finance specialist can call to go through your options. Today at 5:30pm or tomorrow at 9am?' },
      { l: 'Today works' },
      { a: "Done, you're booked for today at 5:30pm. They'll call you on this number.", e: 'booked' },
    ],
  },
};

// ---- Demo player ----
const demoEl = $('#demo');
if (!demoEl) return;
const thread = $('#d-thread', demoEl);
const stateEl = $('#d-state', demoEl);
const demoCanvas = $('#demo-orb');
const demoOrb = demoCanvas && typeof createOrb === 'function' ? createOrb(demoCanvas) : null;
let current = 'solar', run = 0, played = false;

function setState(busy, text) {
  stateEl.classList.toggle('busy', busy);
  stateEl.querySelector('span').textContent = text;
  demoOrb?.set(busy ? 'busy' : 'idle');
}

function add(html) {
  thread.insertAdjacentHTML('beforeend', html);
  thread.scrollTop = thread.scrollHeight;
}

function reset(key) {
  const s = SCRIPTS[key];
  $('#d-name', demoEl).textContent = s.bot;
  $('#d-lead', demoEl).innerHTML = `<b>${esc(s.lead)} (example lead)</b>Enquired about ${esc(s.service)}, never went ahead.`;
  $('#d-head', demoEl).innerHTML = `<b>${esc(s.lead)}</b> · ${esc(s.company)} <span style="margin-left:auto" class="muted">Fictional business</span>`;
  $('#d-qual', demoEl).innerHTML = s.qs.map(([k, label]) => `<li data-k="${k}"><span class="tick"></span><span>${esc(label)}<span class="a">-</span></span></li>`).join('');
  demoEl.querySelectorAll('.anchor').forEach((a) => a.classList.remove('done'));
  thread.innerHTML = '';
  setState(false, 'Standing by');
}

async function play(key) {
  const my = ++run;
  current = key;
  document.querySelectorAll('#demo .tab').forEach((t) => t.classList.toggle('on', t.dataset.k === key));
  reset(key);
  const s = SCRIPTS[key];
  await sleep(500);
  for (const step of s.steps) {
    if (my !== run) return; // another niche was picked
    if (step.a) {
      setState(true, `Writing to ${s.lead}…`);
      add('<div class="typing" data-t><i></i><i></i><i></i></div>');
      await sleep(Math.min(2200, 900 + step.a.length * 8));
      if (my !== run) return;
      thread.querySelector('[data-t]')?.remove();
      add(`<div class="who out">${esc(s.bot)} · AI</div><div class="msg out">${esc(step.a)}</div>`);
      demoOrb?.pulse(2);
      setState(false, 'Waiting for reply');
    } else {
      await sleep(900);
      add('<div class="typing lead" data-t><i></i><i></i><i></i></div>');
      await sleep(Math.min(1800, 600 + step.l.length * 12));
      if (my !== run) return;
      thread.querySelector('[data-t]')?.remove();
      add(`<div class="who">${esc(s.lead)}</div><div class="msg in">${esc(step.l)}</div>`);
    }
    if (step.q) {
      const li = demoEl.querySelector(`#d-qual [data-k="${step.q[0]}"]`);
      if (li) { li.classList.add('done'); li.querySelector('.tick').innerHTML = ic('check'); li.querySelector('.a').textContent = step.q[1]; }
    }
    if (step.e === 'interested') {
      await sleep(300);
      demoEl.querySelector('[data-anchor=interested]').classList.add('done');
      add(`<div class="evt">${ic('check')}Anchor 1 · Positive reply</div>`);
    }
    if (step.e === 'booked') {
      await sleep(300);
      demoEl.querySelector('[data-anchor=booked]').classList.add('done');
      add(`<div class="evt">${ic('cal')}Anchor 2 · Callback booked</div>`);
      demoOrb?.set('booked');
      stateEl.querySelector('span').textContent = 'Callback booked';
    }
    await sleep(350);
  }
}

demoEl.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) play(tab.dataset.k);
  if (e.target.closest('[data-replay]')) play(current);
});

// Start when the demo scrolls into view, once.
reset(current);
new IntersectionObserver((entries, obs) => {
  if (entries.some((x) => x.isIntersecting) && !played) { played = true; obs.disconnect(); play(current); }
}, { threshold: 0.35 }).observe(demoEl);

$('#year') && ($('#year').textContent = new Date().getFullYear());
})();
