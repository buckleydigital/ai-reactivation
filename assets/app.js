/* Reactivate - the app. Plain JS, no build step: GitHub Pages serves it as is.
 *
 * Reads go straight to Supabase (row level security keeps each client to
 * their own rows). Anything with a side effect - sending a text, importing a
 * list, launching a campaign, the demo - goes through the `reactivation` edge
 * function, which checks the caller and logs it on the lead's timeline.
 */
/* global supabase, Papa, createOrb */
(() => {
'use strict';

const CFG = window.RX_CONFIG;
const sb = supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
const FN = `${CFG.supabaseUrl}/functions/v1/reactivation/api`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (l) => ((l.first_name || '?')[0] + ((l.last_name || '')[0] || '')).toUpperCase();
const fullName = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone || 'Unknown';
const fmtPhone = (p) => String(p || '').replace(/^\+61(\d)(\d{2})(\d{3})(\d{3})$/, '0$1$2 $3 $4');

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtWhen = (ts) => ts ? new Date(ts).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
function fmtTz(ts, tz) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat('en-AU', { timeZone: tz || 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
  } catch { return fmtWhen(ts); }
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
}

async function api(action, payload = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Please sign in again');
  const r = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: CFG.supabaseKey },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

// Runs an async action from a button, showing it busy and any error as a toast.
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message || String(e), 'err'); }
  finally { if (btn) btn.disabled = false; }
}

const STATUS = {
  new: ['Not sent', 'mute'], queued: ['Queued', 'mute'], sending: ['Sending', 'mute'],
  contacted: ['Awaiting reply', 'info'], replied: ['Replied', 'hud'], engaged: ['Engaged', 'hud'],
  qualified: ['Qualified', 'violet'], booked: ['Callback booked', 'good'], not_interested: ['Not interested', 'mute'],
  wrong_person: ['Wrong person', 'mute'], disqualified: ['Disqualified', 'mute'], opted_out: ['Opted out', 'bad'], failed: ['Failed', 'bad'],
};
const statusPill = (s) => { const [l, t] = STATUS[s] || [s, 'mute']; return `<span class="pill ${t}">${esc(l)}</span>`; };

const FILTERS = [
  ['all', 'All', null],
  ['hot', 'Replied', ['replied', 'engaged', 'qualified']],
  ['booked', 'Booked', ['booked']],
  ['waiting', 'Awaiting', ['contacted']],
  ['pending', 'Not sent', ['new', 'queued', 'sending']],
  ['closed', 'Closed', ['not_interested', 'wrong_person', 'disqualified', 'opted_out', 'failed']],
];

const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
const TIMEZONES = ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Perth', 'Australia/Hobart', 'Pacific/Auckland', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const S = {
  user: null, profile: null, isAdmin: false,
  clients: [], presets: [], campaigns: [], stats: [],
  leads: [], leadLimit: 200,
  lead: null, messages: [], events: [], calls: [],
  view: 'inbox', clientFilter: 'all', campaignFilter: '', statusFilter: 'all', search: '',
  demo: false, channel: null, orb: null,
};
const clientById = (id) => S.clients.find((c) => c.id === id);
const campaignById = (id) => S.campaigns.find((c) => c.id === id);
const presetBySlug = (s) => S.presets.find((p) => p.slug === s);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const show = (id) => { ['boot', 'login', 'setpw', 'app'].forEach((x) => { $(`#${x}`).hidden = x !== id; }); };
// An invite or reset link lands here with a token in the hash. Supabase signs
// the user in from it; they still need to choose a password.
const arrivedFrom = /type=(invite|recovery)/.exec(location.hash)?.[1] || null;

sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') show('setpw');
  if (event === 'SIGNED_OUT') location.reload();
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  $('#login-msg').textContent = '';
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-password').value });
  btn.disabled = false;
  if (error) { $('#login-msg').textContent = error.message; return; }
  start();
});

$('#setpw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: $('#setpw-password').value });
  if (error) { $('#setpw-msg').textContent = error.message; return; }
  history.replaceState(null, '', location.pathname);
  start();
});

async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { show('login'); return; }
  if (arrivedFrom && !start.pwDone) { start.pwDone = true; show('setpw'); return; }
  S.user = session.user;
  const { data: profile } = await sb.from('profiles').select('*').eq('id', S.user.id).maybeSingle();
  if (!profile || (profile.role !== 'admin' && !profile.client_id)) {
    show('login');
    $('#login-msg').textContent = 'Your account is not linked to a business yet. Ask your account manager to set it up.';
    await sb.auth.signOut({ scope: 'local' });
    return;
  }
  S.profile = profile;
  S.isAdmin = profile.role === 'admin';
  document.body.classList.toggle('is-admin', S.isAdmin);
  show('app');
  S.orb = S.orb || createOrb($('#orb'));
  $('#avatar').textContent = (profile.full_name || profile.email || '?').trim()[0].toUpperCase();
  $('#menu-head').innerHTML = `${esc(profile.full_name || '')}<br>${esc(profile.email || '')}<br><span class="pill ${S.isAdmin ? 'violet' : 'hud'}" style="margin-top:6px">${S.isAdmin ? 'Admin' : 'Client'}</span>`;
  await loadReference();
  renderChips();
  subscribe();
  setView(location.hash.replace('#', '') || 'inbox');
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadReference() {
  const [c, p, k, st] = await Promise.all([
    sb.from('clients').select('*').order('name'),
    sb.from('niche_presets').select('*').order('sort'),
    sb.from('campaigns').select('*').order('created_at', { ascending: false }),
    sb.from('campaign_stats').select('*'),
  ]);
  S.clients = c.data || [];
  S.presets = p.data || [];
  S.campaigns = k.data || [];
  S.stats = st.data || [];
  if (!S.isAdmin) $('#client-name').textContent = clientById(S.profile.client_id)?.name || '';
  renderClientFilter();
  renderCampaignFilter();
}

const visibleClients = () => S.clients.filter((c) => !!c.is_demo === S.demo && (S.clientFilter === 'all' || c.id === S.clientFilter));

async function loadLeads() {
  let q = sb.from('leads')
    .select('id,client_id,campaign_id,first_name,last_name,phone,status,ai_enabled,ai_state,last_message_at,last_inbound_at,replied_at,interested_at,booked_at,callback_at,reply_due_at,service,is_demo,created_at')
    .eq('is_demo', S.demo)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(S.leadLimit);
  if (S.clientFilter !== 'all') q = q.eq('client_id', S.clientFilter);
  if (S.campaignFilter) q = q.eq('campaign_id', S.campaignFilter);
  const f = FILTERS.find((x) => x[0] === S.statusFilter);
  if (f?.[2]) q = q.in('status', f[2]);
  const term = S.search.replace(/[,()%*]/g, ' ').trim();
  if (term) {
    const digits = term.replace(/\D/g, '');
    const ors = [`first_name.ilike.%${term}%`, `last_name.ilike.%${term}%`];
    if (digits.length >= 3) ors.push(`phone.ilike.%${digits.replace(/^0/, '')}%`);
    q = q.or(ors.join(','));
  }
  const { data, error } = await q;
  if (error) { toast(error.message, 'err'); return; }
  S.leads = data || [];
  renderLeadList();
  renderAgent();
}

async function refreshStats() {
  const { data } = await sb.from('campaign_stats').select('*');
  S.stats = data || [];
  renderAgent();
  if (S.view === 'campaigns') renderCampaigns();
}
let statsTimer = 0;
const refreshStatsSoon = () => { clearTimeout(statsTimer); statsTimer = setTimeout(refreshStats, 2500); };

async function openLead(id, { tab = true } = {}) {
  const [l, m, e, c] = await Promise.all([
    sb.from('leads').select('*').eq('id', id).maybeSingle(),
    sb.from('messages').select('*').eq('lead_id', id).order('created_at').limit(500),
    sb.from('lead_events').select('*').eq('lead_id', id).order('created_at').limit(500),
    sb.from('calls').select('*').eq('lead_id', id).order('started_at', { ascending: false }),
  ]);
  if (!l.data) { toast('That lead is no longer available', 'err'); return; }
  S.lead = l.data; S.messages = m.data || []; S.events = e.data || []; S.calls = c.data || [];
  renderLeadList();
  renderChat({ scroll: true });
  renderInsights();
  renderAgent();
  if (tab) setTab('chat');
}

// ---------------------------------------------------------------------------
// Realtime: replies, the agent thinking, bookings - all arrive live.
// ---------------------------------------------------------------------------
function subscribe() {
  if (S.channel) sb.removeChannel(S.channel);
  S.channel = sb.channel('rx-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, onLeadChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, onMessageChange)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lead_events' }, onEvent)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'calls' }, onCall)
    .subscribe();
}

function leadMatchesView(l) {
  if (!!l.is_demo !== S.demo) return false;
  if (S.clientFilter !== 'all' && l.client_id !== S.clientFilter) return false;
  if (S.campaignFilter && l.campaign_id !== S.campaignFilter) return false;
  const f = FILTERS.find((x) => x[0] === S.statusFilter);
  return !f?.[2] || f[2].includes(l.status);
}

function onLeadChange({ eventType, new: row, old }) {
  if (eventType === 'DELETE') {
    S.leads = S.leads.filter((l) => l.id !== old.id);
    renderLeadList(); return;
  }
  const i = S.leads.findIndex((l) => l.id === row.id);
  if (i >= 0) S.leads[i] = { ...S.leads[i], ...row };
  else if (leadMatchesView(row) && !S.search) S.leads.unshift(row);
  S.leads.sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
  if (S.lead?.id === row.id) {
    const wasBooked = !!S.lead.callback_at;
    S.lead = { ...S.lead, ...row };
    renderChatHead(); renderTyping(); renderInsights(); renderComposer();
    if (!wasBooked && row.callback_at) S.orb?.pulse(3);
  }
  renderLeadList();
  renderAgent();
  refreshStatsSoon();
}

function onMessageChange({ eventType, new: row }) {
  if (!S.lead || row?.lead_id !== S.lead.id) return;
  const i = S.messages.findIndex((m) => m.id === row.id);
  if (eventType === 'INSERT' && i < 0) {
    S.messages.push(row);
    if (row.author === 'ai') S.orb?.pulse(2);
    renderChat({ scroll: true });
  } else if (eventType === 'UPDATE' && i >= 0) {
    S.messages[i] = row;
    renderChat();
  } else if (eventType === 'DELETE') {
    openLead(S.lead.id, { tab: false });
  }
}

function onEvent({ new: row }) {
  const l = S.leads.find((x) => x.id === row.lead_id);
  if (l && row.type === 'callback_booked') toast(`📅 Callback booked: ${fullName(l)}, ${row.data?.local || ''}`, 'ok');
  if (l && row.type === 'lead_interested') toast(`🔥 ${fullName(l)} is interested`, 'ok');
  if (l && row.type === 'lead_replied' && S.lead?.id !== row.lead_id) toast(`💬 ${fullName(l)} replied`);
  if (!S.lead || row.lead_id !== S.lead.id) return;
  if (!S.events.some((e) => e.id === row.id)) S.events.push(row);
  renderChat({ scroll: true });
}

function onCall({ new: row }) {
  if (!S.lead || row?.lead_id !== S.lead.id) return;
  const i = S.calls.findIndex((c) => c.id === row.id);
  if (i >= 0) S.calls[i] = row; else S.calls.unshift(row);
  renderInsights();
}

// ---------------------------------------------------------------------------
// Views & tabs
// ---------------------------------------------------------------------------
function setView(v) {
  // Back from Stripe: credits and cards arrive by webhook a moment later.
  if (v === 'billing-done') { v = 'billing'; toast('Thanks, payment details received. It can take a few seconds to show here.', 'ok'); setTimeout(() => S.view === 'billing' && renderBilling(), 4000); }
  if (!['inbox', 'campaigns', 'clients', 'users', 'dnc', 'billing'].includes(v)) v = 'inbox';
  if (!S.isAdmin && ['clients', 'users', 'dnc'].includes(v)) v = 'inbox';
  S.view = v;
  history.replaceState(null, '', `#${v}`);
  $$('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  ['inbox', 'campaigns', 'clients', 'users', 'dnc', 'billing'].forEach((x) => { $(`#view-${x}`).hidden = x !== v; });
  document.body.classList.toggle('view-inbox', v === 'inbox');
  if (v === 'inbox') { loadLeads(); if (!S.lead) { renderChat(); renderInsights(); } }
  if (v === 'campaigns') renderCampaigns();
  if (v === 'clients') renderClients();
  if (v === 'users') renderUsers();
  if (v === 'dnc') renderDnc();
  if (v === 'billing') renderBilling();
}

function setTab(t) {
  $('#view-inbox').dataset.tab = t;
  $$('#mobile-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
}

function renderClientFilter() {
  const list = S.clients.filter((c) => !!c.is_demo === S.demo);
  if (S.clientFilter !== 'all' && !list.some((c) => c.id === S.clientFilter)) S.clientFilter = 'all';
  $('#client-filter').innerHTML = `<option value="all">${S.demo ? 'All demos' : 'All clients'}</option>` +
    list.map((c) => `<option value="${c.id}" ${c.id === S.clientFilter ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function renderCampaignFilter() {
  const ids = new Set(visibleClients().map((c) => c.id));
  const list = S.campaigns.filter((c) => ids.has(c.client_id));
  if (S.campaignFilter && !list.some((c) => c.id === S.campaignFilter)) S.campaignFilter = '';
  $('#campaign-filter').innerHTML = '<option value="">All campaigns</option>' +
    list.map((c) => `<option value="${c.id}" ${c.id === S.campaignFilter ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function renderChips() {
  $('#status-chips').innerHTML = FILTERS.map(([k, label]) =>
    `<button class="chip ${k === S.statusFilter ? 'on' : ''}" data-act="filter" data-k="${k}">${label}</button>`).join('');
}

// ---------------------------------------------------------------------------
// Left: the agent and the lead list
// ---------------------------------------------------------------------------
function renderAgent() {
  const thinking = S.leads.filter((l) => l.ai_state === 'thinking');
  const onCall = S.leads.filter((l) => l.ai_state === 'on_call');
  const sel = S.lead;
  let state = 'idle', label = 'Standing by';
  if (sel?.ai_state === 'on_call' || (!sel && onCall.length)) { state = 'speaking'; label = `On a call with ${(sel || onCall[0]).first_name || 'a lead'}`; }
  else if (sel?.ai_state === 'thinking') { state = 'busy'; label = `Writing to ${sel.first_name || 'lead'}…`; }
  else if (onCall.length) { state = 'speaking'; label = `On a call with ${onCall[0].first_name || 'a lead'}`; }
  else if (thinking.length) { state = 'busy'; label = thinking.length > 1 ? `Writing ${thinking.length} replies…` : `Writing to ${thinking[0].first_name || 'a lead'}…`; }
  else if (sel && !sel.ai_enabled) label = 'Paused for this lead';
  else if (sel && dueIn(sel) > 0) label = `Replying to ${sel.first_name || 'lead'} shortly`;
  S.orb?.set(state);
  document.body.dataset.agent = state;
  const st = $('#agent-state');
  st.dataset.state = state;
  st.querySelector('span').textContent = label;

  const camp = sel ? campaignById(sel.campaign_id) : (S.campaignFilter ? campaignById(S.campaignFilter) : null);
  $('#agent-name').textContent = camp?.agent?.bot_name ? `${camp.agent.bot_name}` : 'AI Agent';

  const ids = new Set(visibleClients().map((c) => c.id));
  const rows = S.stats.filter((r) => ids.has(r.client_id) && (!S.campaignFilter || r.campaign_id === S.campaignFilter));
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const contacted = sum('contacted'), replied = sum('replied'), interested = sum('interested'), booked = sum('booked');
  const pct = (a) => (contacted ? ` title="${Math.round(a / contacted * 100)}% of leads texted"` : '');
  $('#agent-stats').innerHTML = `
    <div class="stat"><b>${contacted}</b><span>Texted</span></div>
    <div class="stat"${pct(replied)}><b>${replied}</b><span>Replied</span></div>
    <div class="stat hud"${pct(interested)}><b>${interested}</b><span>Interested</span></div>
    <div class="stat good"${pct(booked)}><b>${booked}</b><span>Booked</span></div>`;
}

function renderLeadList() {
  const el = $('#lead-list');
  if (!S.leads.length) {
    el.innerHTML = `<div class="empty">${S.demo
      ? 'No demo conversations yet.<br><button class="btn small" data-act="demo-new" style="margin-top:10px">Start a demo</button>'
      : S.search || S.statusFilter !== 'all' ? 'No leads match.' : 'No leads yet. Upload a CSV from Campaigns.'}</div>`;
    return;
  }
  el.innerHTML = S.leads.map((l) => {
    const showClient = S.isAdmin && S.clientFilter === 'all' && !S.demo;
    const sub = [showClient ? clientById(l.client_id)?.name : null, l.service || fmtPhone(l.phone)].filter(Boolean).join(' · ');
    const unread = l.last_inbound_at && (!l.last_message_at || l.last_inbound_at >= l.last_message_at) && l.status !== 'opted_out';
    return `<button class="lead-row ${S.lead?.id === l.id ? 'on' : ''}" data-act="open" data-id="${l.id}">
      <span class="lead-av ${l.ai_state}">${esc(initials(l))}</span>
      <span class="lead-main"><div class="lead-name">${unread ? '<span style="color:var(--hud)">● </span>' : ''}${esc(fullName(l))}</div><div class="lead-sub">${esc(sub)}</div></span>
      <span class="lead-side">${statusPill(l.status)}<span>${ago(l.last_message_at || l.created_at)}</span></span>
    </button>`;
  }).join('') + (S.leads.length >= S.leadLimit ? '<div class="more-row"><button class="btn small" data-act="more">Load more</button></div>' : '');
}

// ---------------------------------------------------------------------------
// Middle: the conversation
// ---------------------------------------------------------------------------
function renderChat({ scroll = false } = {}) {
  const el = $('#chat');
  if (!S.lead) {
    el.innerHTML = `<div class="chat-empty"><div><h3>Pick a conversation</h3><p>Replies and bookings appear here live as the agent works.</p>
      ${S.isAdmin && S.demo ? '<button class="btn primary" data-act="demo-new">Start a demo</button>' : ''}</div></div>`;
    return;
  }
  const prevThread = $('#thread');
  const atBottom = !prevThread || prevThread.scrollHeight - prevThread.scrollTop - prevThread.clientHeight < 80;
  if (!$('#chat-head')) {
    el.innerHTML = `<div class="chat-head" id="chat-head"></div><div class="thread" id="thread"></div><div class="composer" id="composer"></div>`;
  }
  renderChatHead();
  renderThread();
  renderComposer();
  const t = $('#thread');
  if (scroll || atBottom) t.scrollTop = t.scrollHeight;
}

function renderChatHead() {
  const l = S.lead;
  if (!l || !$('#chat-head')) return;
  const camp = campaignById(l.campaign_id);
  $('#chat-head').innerHTML = `
    <button class="btn small ghost back-btn" data-act="tab" data-tab="list" aria-label="Back">‹</button>
    <span class="lead-av ${l.ai_state}">${esc(initials(l))}</span>
    <div class="chat-title"><b>${esc(fullName(l))} ${l.is_demo ? '<span class="pill warm">Demo</span>' : ''}</b>
      <span>${esc(l.is_demo ? 'Demo lead' : fmtPhone(l.phone))}${camp ? ` · ${esc(camp.name)}` : ''}</span></div>
    <div class="chat-head-actions">
      <button class="ai-switch ${l.ai_enabled ? 'on' : ''}" data-act="toggle-ai" ${l.status === 'opted_out' ? 'disabled' : ''} title="${l.ai_enabled ? 'The AI is replying to this lead' : 'The AI is paused for this lead'}"><span class="knob"></span>AI ${l.ai_enabled ? 'on' : 'off'}</button>
      <button class="btn small ghost ins-toggle" data-act="insights">Insights</button>
    </div>`;
}

const EVENT_LABEL = {
  lead_replied: (e) => ['', 'Lead replied' + (e.data?.channel === 'voice' ? ' (called in)' : '')],
  lead_interested: (e) => ['anchor', '✓ Anchor 1 · Positive reply' + (e.data?.why && e.data.why !== 'positive reply' ? ` (${e.data.why})` : '')],
  callback_booked: (e) => ['anchor', `📅 Anchor 2 · Callback ${e.data?.rescheduled ? 'moved to' : 'booked for'} ${e.data?.local || fmtWhen(e.data?.at)}`],
  opted_out: (e) => ['bad', `Opted out (${e.data?.how === 'keyword' ? 'replied STOP' : e.data?.how || 'asked'}): will never be messaged again`],
  opted_back_in: (e) => ['', `Taken off the do-not-contact list${e.data?.by ? ` by ${e.data.by}` : ''}`],
  ai_paused: (e) => ['', `AI paused${e.data?.by ? ` by ${e.data.by}` : ''}`],
  ai_resumed: (e) => ['', `AI resumed${e.data?.by ? ` by ${e.data.by}` : ''}`],
  status_changed: (e) => ['', `Status: ${(STATUS[e.data?.to] || [e.data?.to])[0]}`],
  call_started: () => ['', '☎ Inbound call answered by the agent'],
  call_ended: () => ['', '☎ Call ended'],
  callback_cleared: () => ['', 'Callback cleared'],
  ai_error: (e) => ['bad', `AI error: ${e.data?.message || ''}`],
};

function renderThread() {
  const items = [
    ...S.messages.map((m) => ({ t: m.created_at, m })),
    ...S.events.filter((e) => EVENT_LABEL[e.type]).filter((e) => S.isAdmin || e.type !== 'ai_error').map((e) => ({ t: e.created_at, e })),
  ].sort((a, b) => new Date(a.t) - new Date(b.t));
  let lastDay = '';
  const html = items.map((it) => {
    let out = '';
    const day = fmtDay(it.t);
    if (day !== lastDay) { out += `<div class="day">${esc(day)}</div>`; lastDay = day; }
    if (it.e) {
      const [cls, label] = EVENT_LABEL[it.e.type](it.e);
      return out + `<div class="event ${cls}">${esc(label)}</div>`;
    }
    const m = it.m;
    if (m.channel === 'note') {
      return out + `<div class="msg note"><div class="bubble">📝 ${esc(m.body)}</div><div class="meta">Note · ${esc(m.status || '')} · ${fmtTime(m.created_at)}</div></div>`;
    }
    const inbound = m.direction === 'inbound';
    const who = inbound ? (S.lead.first_name || 'Lead') : m.author === 'human' ? 'Team' : m.author === 'system' ? 'Auto' : (campaignById(S.lead.campaign_id)?.agent?.bot_name || 'AI') + ' · AI';
    const failed = m.status === 'failed' || m.status === 'undelivered';
    const tick = inbound ? '' : failed ? `<span style="color:var(--bad)">${esc(m.error || 'Not delivered')}</span>`
      : m.status === 'delivered' ? '✓✓' : m.status === 'sent' ? '✓' : '';
    return out + `<div class="msg ${inbound ? 'in' : 'out'} ${m.author} ${m.channel === 'voice' ? 'voice' : ''} ${failed ? 'failed' : ''}">
      <div class="bubble">${esc(m.body)}</div>
      <div class="meta"><span class="who">${esc(who)}</span><span>${fmtTime(m.created_at)}</span>${tick ? `<span>${tick}</span>` : ''}</div></div>`;
  }).join('');
  $('#thread').innerHTML = html || '<div class="empty">No messages yet. The handraiser goes out when the campaign is launched.</div>';
  renderTyping();
}

// Seconds until the agent answers the lead's latest text (real SMS waits a
// random 30-60s so it reads like a person; demos answer at once).
function dueIn(l) {
  if (!l?.reply_due_at || !l.ai_enabled || l.ai_state !== 'idle') return 0;
  return Math.max(0, Math.round((new Date(l.reply_due_at) - Date.now()) / 1000));
}

function renderTyping() {
  const t = $('#thread');
  if (!t) return;
  t.querySelector('.typing')?.remove();
  t.querySelector('.due')?.remove();
  if (S.lead?.ai_state === 'thinking') {
    t.insertAdjacentHTML('beforeend', '<div class="typing" title="The agent is writing"><i></i><i></i><i></i></div>');
    t.scrollTop = t.scrollHeight;
  } else if (dueIn(S.lead) > 2) {
    const bot = campaignById(S.lead.campaign_id)?.agent?.bot_name || 'The agent';
    t.insertAdjacentHTML('beforeend', `<div class="due">${esc(bot)} replies in about <b>${dueIn(S.lead)}s</b>. Pause the AI to answer yourself.</div>`);
    t.scrollTop = t.scrollHeight;
  }
}
// Tick the countdown without re-rendering the whole thread.
setInterval(() => {
  const el = document.querySelector('#thread .due b');
  if (!el) return;
  const n = dueIn(S.lead);
  if (n > 2) el.textContent = `${n}s`; else renderTyping();
}, 1000);

function renderComposer() {
  const el = $('#composer');
  if (!el || !S.lead) return;
  const l = S.lead;
  // Only rebuild when what the composer offers changes, so a live update
  // (the agent starting to think, say) never steals focus mid-sentence.
  const key = [l.id, l.is_demo, l.status === 'opted_out', l.ai_enabled, !!S.composeNote].join('|');
  if (el.dataset.key === key) return;
  const draft = el.dataset.key?.startsWith(l.id + '|') ? ($('#compose-text')?.value || '') : '';
  el.dataset.key = key;
  if (l.is_demo) {
    el.innerHTML = `<div class="composer-row"><textarea id="compose-text" rows="1" placeholder="Reply as ${esc(l.first_name || 'the lead')}…"></textarea>
      <button class="btn primary" data-act="send">Send</button></div>
      <div class="composer-hint"><span>You're playing the lead. The agent replies through OpenAI exactly as it would by SMS.</span></div>`;
  } else if (l.status === 'opted_out') {
    el.innerHTML = '<div class="composer-hint"><span>This lead opted out. Nothing more can be sent to them.</span></div>';
    return;
  } else {
    el.innerHTML = `<div class="composer-row"><textarea id="compose-text" rows="1" placeholder="${S.composeNote ? 'Add a private note…' : `Text ${esc(l.first_name || 'the lead')} as a team member…`}"></textarea>
      <button class="btn primary" data-act="send">${S.composeNote ? 'Add note' : 'Send'}</button></div>
      <div class="composer-hint"><span>${S.composeNote ? 'Notes are only visible in this app.' : l.ai_enabled ? 'Sending as a team member pauses the AI for this lead.' : 'The AI is paused: only your messages go out.'}</span>
      <label><input type="checkbox" data-act="note-mode" ${S.composeNote ? 'checked' : ''}> Private note</label></div>`;
  }
  const ta = $('#compose-text');
  ta.value = draft;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(max-width: 860px)').matches) { e.preventDefault(); $('[data-act=send]').click(); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
}

// ---------------------------------------------------------------------------
// Right: insights and actions
// ---------------------------------------------------------------------------
function renderInsights() {
  const el = $('#insights');
  const l = S.lead;
  if (!l) {
    el.innerHTML = `<div class="ins"><div><h4>Insights &amp; actions</h4><div class="card muted small">Select a lead to see where the conversation stands, what the agent has learned, and what to do next.</div></div>
      <div class="card small muted">Everyone texts and calls through the shared number <b class="mono">${esc(CFG.sharedNumber)}</b>. Replies are matched to the right client by the lead's phone number.</div></div>`;
    return;
  }
  const camp = campaignById(l.campaign_id);
  const client = clientById(l.client_id);
  const tz = client?.timezone || 'Australia/Sydney';
  const qs = camp?.agent?.qualification_questions || [];
  const q = l.qualification || {};
  const extraKeys = Object.keys(q).filter((k) => !qs.some((x) => x.key === k));
  const extra = Object.entries(l.extra || {}).filter(([, v]) => v !== '' && v != null);

  el.innerHTML = `<div class="ins">
    <div>
      <h4>Anchors</h4>
      <div class="anchors">
        <div class="anchor ${l.interested_at ? 'done' : ''}"><div class="n">01</div><b>${l.interested_at ? 'Positive reply' : l.replied_at ? 'Replied, not interested yet' : 'Awaiting reply'}</b><small>${l.interested_at ? fmtWhen(l.interested_at) : l.replied_at ? `Replied ${fmtWhen(l.replied_at)}` : l.contacted_at ? `Texted ${ago(l.contacted_at)} ago` : 'Not texted yet'}</small></div>
        <div class="anchor ${l.callback_at ? 'done' : ''}"><div class="n">02</div><b>${l.callback_at ? 'Callback booked' : 'No callback yet'}</b><small>${l.callback_at ? esc(fmtTz(l.callback_at, tz)) : 'The agent books this'}</small></div>
      </div>
    </div>

    ${l.callback_at ? `<div class="card"><h4>Callback</h4><div class="callback-big">${esc(fmtTz(l.callback_at, tz))}</div>
      <div class="small muted">${esc(tz)}${l.callback_notes ? ` · ${esc(l.callback_notes)}` : ''}</div>
      <div class="small" style="margin-top:6px">${client?.name ? `${esc(client.name)} calls ` : 'Call '}<a href="tel:${esc(l.phone)}">${esc(fmtPhone(l.phone))}</a></div></div>` : ''}

    <div class="card">
      <h4>Where it stands</h4>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${statusPill(l.status)}
        ${l.intent ? `<span class="pill">${esc(l.intent.replace('_', ' '))}</span>` : ''}
        ${l.sentiment ? `<span class="pill ${l.sentiment === 'positive' ? 'good' : l.sentiment === 'negative' ? 'bad' : ''}">${esc(l.sentiment)}</span>` : ''}</div>
      <div class="summary">${l.summary ? esc(l.summary) : '<span class="muted">The agent writes a summary once the lead replies.</span>'}</div>
      ${l.next_action ? `<div class="next">→ ${esc(l.next_action)}</div>` : ''}
      ${l.error ? `<div class="small" style="color:var(--bad);margin-top:6px">${esc(l.error)}</div>` : ''}
    </div>

    <div class="card">
      <h4 style="display:flex;align-items:center">Qualification${S.isAdmin && camp ? '<button class="link small" data-act="questions-edit" style="margin-left:auto;font-family:var(--sans);letter-spacing:0;text-transform:none">Edit questions</button>' : ''}</h4>
      ${qs.length || extraKeys.length ? `<ul class="qual">${qs.map((x) => `<li class="${q[x.key] ? 'done' : ''}"><span class="tick">${q[x.key] ? '✓' : ''}</span>
        <span><span class="q">${esc(x.question)}</span>${x.required ? '<span class="req">required</span>' : ''}<br><span class="a">${q[x.key] ? esc(q[x.key]) : '-'}</span></span></li>`).join('')}
        ${extraKeys.map((k) => `<li class="done"><span class="tick">✓</span><span><span class="q">${esc(k)}</span><br><span class="a">${esc(q[k])}</span></span></li>`).join('')}</ul>`
        : '<div class="small muted">No qualifying questions on this campaign.</div>'}
    </div>

    <div class="card">
      <h4>Actions</h4>
      <div class="actions">
        <button class="btn ${l.ai_enabled ? '' : 'good'}" data-act="toggle-ai" ${l.status === 'opted_out' ? 'disabled' : ''}>${l.ai_enabled ? '⏸ Pause AI' : '▶ Resume AI'}</button>
        <button class="btn" data-act="refresh-insights">↻ Re-read chat</button>
        <button class="btn" data-act="book-open">${l.callback_at ? 'Change callback' : '📅 Book callback'}</button>
        ${l.callback_at ? '<button class="btn" data-act="clear-callback">Clear callback</button>' : ''}
        <select data-act="set-status" aria-label="Mark as" style="grid-column:span ${l.callback_at ? 2 : 1}">
          <option value="">Mark as…</option>
          <option value="engaged">Engaged</option><option value="qualified">Qualified</option>
          <option value="not_interested">Not interested</option><option value="wrong_person">Wrong person</option>
          <option value="disqualified">Disqualified</option>
        </select>
        ${l.is_demo && S.isAdmin ? '<button class="btn" data-act="demo-reset">Restart demo</button><button class="btn danger" data-act="demo-delete">Delete demo</button>' : ''}
      </div>
      <form class="inline-form" id="book-form" hidden>
        <label>Callback time (${esc(tz)})<input type="datetime-local" id="book-time" required></label>
        <label>Notes<input id="book-notes" placeholder="Optional"></label>
        <button class="btn good" type="submit">Save callback</button>
      </form>
    </div>

    ${S.calls.length ? `<div class="card"><h4>Calls</h4>${S.calls.map((c) => `<div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)">
      <b>${esc(fmtWhen(c.started_at))}</b> · ${esc(c.status)}${c.ended_at && c.answered_at ? ` · ${Math.max(1, Math.round((new Date(c.ended_at) - new Date(c.answered_at)) / 60000))} min` : ''}
      ${c.summary ? `<div class="muted">${esc(c.summary)}</div>` : ''}</div>`).join('')}</div>` : ''}

    <div class="card">
      <h4>Lead</h4>
      <dl class="kv">
        <dt>Phone</dt><dd>${l.is_demo ? 'Demo' : `<a href="tel:${esc(l.phone)}">${esc(fmtPhone(l.phone))}</a>`}</dd>
        ${l.email ? `<dt>Email</dt><dd><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></dd>` : ''}
        ${l.service ? `<dt>Enquiry</dt><dd>${esc(l.service)}</dd>` : ''}
        ${l.enquired_at ? `<dt>Enquired</dt><dd>${esc(new Date(l.enquired_at).toLocaleDateString('en-AU'))}</dd>` : ''}
        ${l.source ? `<dt>Source</dt><dd>${esc(l.source)}</dd>` : ''}
        ${S.isAdmin && client ? `<dt>Client</dt><dd>${esc(client.name)}</dd>` : ''}
        ${camp ? `<dt>Campaign</dt><dd>${esc(camp.name)}</dd>` : ''}
        ${l.notes ? `<dt>Notes</dt><dd>${esc(l.notes)}</dd>` : ''}
        ${extra.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      </dl>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
function renderCampaigns() {
  const ids = new Set(visibleClients().map((c) => c.id));
  const list = S.campaigns.filter((c) => ids.has(c.client_id));
  const el = $('#view-campaigns');
  el.innerHTML = `<div class="page-head"><h2>${S.demo ? 'Demo campaigns' : 'Campaigns'}</h2><span class="grow"></span>
    ${S.isAdmin && !S.demo ? '<button class="btn primary" data-act="campaign-new">+ New campaign</button>' : ''}</div>
    ${list.length ? `<div class="grid-cards">${list.map(campaignCard).join('')}</div>`
      : `<div class="empty card">${S.isAdmin ? (S.clients.some((c) => !c.is_demo) ? 'No campaigns yet. Create one, then upload a CSV of leads.' : 'Add a client first (Clients tab), then create a campaign for them.') : 'No campaigns yet.'}</div>`}`;
}

function campaignCard(c) {
  const st = S.stats.find((s) => s.campaign_id === c.id) || {};
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  const client = clientById(c.client_id);
  const stTone = { draft: 'mute', active: 'good', paused: 'warm', completed: 'hud' }[c.status];
  return `<div class="card camp">
    <div class="camp-head"><div style="flex:1;min-width:0"><h3>${esc(c.name)}</h3>
      <div class="camp-sub">${S.isAdmin ? `${esc(client?.name || '')} · ` : ''}${esc(presetBySlug(c.niche)?.name || 'Custom')} · ${esc(c.agent?.bot_name || '')}</div></div>
      <span class="pill ${stTone}">${esc(c.status)}</span></div>
    <div class="funnel">
      <div class="stat"><b>${st.total || 0}</b><span>Leads</span></div>
      <div class="stat"><b>${st.pending || 0}</b><span>To send</span></div>
      <div class="stat"><b>${st.contacted || 0}</b><span>Texted</span></div>
      <div class="stat"><b>${st.replied || 0}</b><span>Replied</span></div>
      <div class="stat hud"><b>${st.interested || 0}</b><span>Interested</span></div>
      <div class="stat good"><b>${st.booked || 0}</b><span>Booked</span></div>
    </div>
    <div class="small muted">Reply rate ${pct(st.replied, st.contacted)}% · Interest rate ${pct(st.interested, st.contacted)}% · ${pct(st.booked, st.interested)}% of interested booked${st.opted_out ? ` · ${st.opted_out} opted out` : ''}${st.failed ? ` · ${st.failed} failed` : ''}</div>
    <div class="bar"><i style="width:${pct(st.contacted, st.total)}%"></i></div>
    <div class="row-btns">
      <button class="btn small" data-act="campaign-leads" data-id="${c.id}">View leads</button>
      ${S.isAdmin && client?.is_demo ? `
        <button class="btn small" data-act="campaign-edit" data-id="${c.id}">Edit script</button>
        <button class="btn small danger" data-act="demo-delete-campaign" data-id="${c.id}">Delete demo</button>` : ''}
      ${S.isAdmin && !client?.is_demo ? `
        <button class="btn small" data-act="campaign-edit" data-id="${c.id}">Edit script</button>
        <button class="btn small" data-act="campaign-upload" data-id="${c.id}">Upload CSV</button>
        ${c.status === 'active' ? `<button class="btn small" data-act="campaign-pause" data-id="${c.id}">Pause</button>`
          : `<button class="btn small good" data-act="campaign-launch" data-id="${c.id}">${c.status === 'paused' ? 'Resume' : 'Launch'}</button>`}` : ''}
    </div></div>`;
}

function modal(title, body, foot, { wide = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="x" data-act="close-modal" aria-label="Close">×</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div></div>`;
  root.querySelector('.modal-bg').addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) closeModal(); });
  return root.querySelector('.modal');
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };

function fillTemplate(t, vars) {
  return t.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)).replace(/\s+/g, ' ').trim();
}

function campaignEditor(c) {
  const isNew = !c;
  const demoClient = c && clientById(c.client_id)?.is_demo ? clientById(c.client_id) : null;
  // A demo campaign stays in the Demo client; it can't be moved to a real one.
  const realClients = demoClient ? [demoClient] : S.clients.filter((x) => !x.is_demo);
  c = c || {
    client_id: S.clientFilter !== 'all' ? S.clientFilter : realClients[0]?.id, name: '', niche: S.presets[0]?.slug,
    agent: { ...(S.presets[0]?.config || {}) }, send_window: { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00' }, send_per_minute: 6,
  };
  const a = c.agent || {};
  const w = c.send_window || {};
  const m = modal(isNew ? 'New campaign' : `Edit: ${c.name}`, `
    <div class="fields">
      <label>Client<select id="ce-client" ${demoClient ? 'disabled' : ''}>${realClients.map((x) => `<option value="${x.id}" ${x.id === c.client_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>Campaign name<input id="ce-name" value="${esc(c.name)}" placeholder="e.g. Dead leads Jan-Jun"></label>
      <label class="full">Niche preset<select id="ce-niche">${S.presets.map((p) => `<option value="${p.slug}" ${p.slug === c.niche ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <span class="small muted">Changing this replaces the script below with that niche's starting script.</span></label>
    </div>
    <div class="section-title">The agent</div>
    <div class="fields">
      <label>Agent name<input id="ce-bot" value="${esc(a.bot_name || '')}"></label>
      <label>Business name (as the lead knows it)<input id="ce-company" value="${esc(a.company_name || '')}" placeholder="Defaults to the client's name"></label>
      <label>Service (used when a lead has none)<input id="ce-service" value="${esc(a.service || '')}"></label>
      <label>Voice for inbound calls<select id="ce-voice">${VOICES.map((v) => `<option ${v === (a.voice || 'marin') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="full">Tone<textarea id="ce-tone" rows="2">${esc(a.tone || '')}</textarea></label>
    </div>
    <div class="section-title">Handraiser</div>
    <div class="fields">
      <label class="full">Messages, one per line. Leads are split evenly between them. Placeholders: {first_name} {bot_name} {company} {service}
        <textarea id="ce-templates" rows="4">${esc((a.handraiser_templates || []).join('\n'))}</textarea></label>
      <label>Style<select id="ce-mode"><option value="template" ${a.handraiser_mode !== 'ai' ? 'selected' : ''}>Send exactly as written</option><option value="ai" ${a.handraiser_mode === 'ai' ? 'selected' : ''}>AI varies the wording per lead</option></select></label>
      <label>Opt-out line (required by law)<input id="ce-optout" value="${esc(a.opt_out_text ?? 'Reply STOP to opt out.')}"></label>
      <div class="full"><div class="small muted" style="margin-bottom:6px">Preview for a lead called Alex:</div><div class="preview" id="ce-preview"></div></div>
    </div>
    <div class="section-title">Qualification</div>
    <div id="ce-questions" style="display:grid;gap:6px"></div>
    <button class="btn small" type="button" data-act="ce-add-q" style="justify-self:start">+ Add question</button>
    <div class="fields">
      <label class="full">Disqualifiers, one per line<textarea id="ce-disq" rows="2">${esc((a.disqualifiers || []).join('\n'))}</textarea></label>
      <label class="full">Compliance rules the agent must follow<textarea id="ce-compliance" rows="3">${esc(a.compliance_notes || '')}</textarea></label>
      <label class="full">Extra instructions (offers, FAQs, anything the agent should know)<textarea id="ce-extra" rows="3">${esc(a.extra_instructions || '')}</textarea></label>
    </div>
    <div class="section-title">Sending</div>
    <div class="fields">
      <div class="full"><label>Days handraisers may go out (client's timezone)</label><div class="days" id="ce-days">${DAY_LABELS.map((d, i) => `<label><input type="checkbox" value="${i + 1}" ${(w.days || []).includes(i + 1) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
      <label>From<input type="time" id="ce-start" value="${esc(w.start || '09:00')}"></label>
      <label>Until<input type="time" id="ce-end" value="${esc(w.end || '19:00')}"></label>
      <label>Texts per minute<input type="number" id="ce-rate" min="1" max="60" value="${c.send_per_minute || 6}"></label>
    </div>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="ce-save">${isNew ? 'Create campaign' : 'Save'}</button>`, { wide: true });

  const qWrap = $('#ce-questions', m);
  const addQ = (q = { key: '', question: '', required: false }) => {
    const row = document.createElement('div');
    row.className = 'qrow';
    row.innerHTML = `<input data-q="key" placeholder="key" value="${esc(q.key)}"><input data-q="question" placeholder="Question" value="${esc(q.question)}">
      <label class="small"><input type="checkbox" data-q="required" ${q.required ? 'checked' : ''}> required</label><button class="btn small ghost" type="button" title="Remove">×</button>`;
    row.querySelector('button').onclick = () => row.remove();
    qWrap.appendChild(row);
  };
  (a.qualification_questions || []).forEach(addQ);
  m.querySelector('[data-act=ce-add-q]').onclick = () => addQ();

  const preview = () => {
    const client = clientById($('#ce-client', m).value);
    const tpl = $('#ce-templates', m).value.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    let text = fillTemplate(tpl, { first_name: 'Alex', lead_name: 'Alex', bot_name: $('#ce-bot', m).value || 'Sarah', company: $('#ce-company', m).value || client?.name || 'Company', company_name: $('#ce-company', m).value || client?.name || 'Company', service: $('#ce-service', m).value || 'your enquiry' });
    const opt = $('#ce-optout', m).value.trim();
    if (opt && !/\bstop\b/i.test(text)) text += ` ${opt}`;
    $('#ce-preview', m).textContent = (text || '(add a message)') + ($('#ce-mode', m).value === 'ai' ? '\n\n(the AI rewords this slightly for each lead)' : '');
    $('#ce-preview', m).title = `${text.length} characters`;
  };
  m.addEventListener('input', preview);
  preview();

  $('#ce-niche', m).addEventListener('change', (e) => {
    const p = presetBySlug(e.target.value);
    if (!p) return;
    const cfg = p.config;
    $('#ce-bot', m).value = cfg.bot_name || '';
    $('#ce-service', m).value = cfg.service || '';
    $('#ce-tone', m).value = cfg.tone || '';
    $('#ce-templates', m).value = (cfg.handraiser_templates || []).join('\n');
    $('#ce-mode', m).value = cfg.handraiser_mode || 'template';
    $('#ce-optout', m).value = cfg.opt_out_text || 'Reply STOP to opt out.';
    $('#ce-disq', m).value = (cfg.disqualifiers || []).join('\n');
    $('#ce-compliance', m).value = cfg.compliance_notes || '';
    $('#ce-extra', m).value = cfg.extra_instructions || '';
    $('#ce-voice', m).value = cfg.voice || 'marin';
    qWrap.innerHTML = '';
    (cfg.qualification_questions || []).forEach(addQ);
    preview();
  });

  $('#ce-save', m).onclick = (e) => busy(e.target, async () => {
    const lines = (id) => $(id, m).value.split('\n').map((s) => s.trim()).filter(Boolean);
    const questions = $$('.qrow', qWrap).map((r) => ({
      key: r.querySelector('[data-q=key]').value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, ''),
      question: r.querySelector('[data-q=question]').value.trim(),
      required: r.querySelector('[data-q=required]').checked,
    })).filter((q) => q.key && q.question);
    const row = {
      client_id: $('#ce-client', m).value,
      name: $('#ce-name', m).value.trim(),
      niche: $('#ce-niche', m).value,
      agent: {
        ...(c.agent || {}),
        bot_name: $('#ce-bot', m).value.trim(), company_name: $('#ce-company', m).value.trim(), service: $('#ce-service', m).value.trim(),
        tone: $('#ce-tone', m).value.trim(), voice: $('#ce-voice', m).value,
        handraiser_templates: lines('#ce-templates'), handraiser_mode: $('#ce-mode', m).value, opt_out_text: $('#ce-optout', m).value.trim(),
        qualification_questions: questions, disqualifiers: lines('#ce-disq'),
        compliance_notes: $('#ce-compliance', m).value.trim(), extra_instructions: $('#ce-extra', m).value.trim(),
      },
      send_window: { days: $$('#ce-days input:checked', m).map((x) => +x.value), start: $('#ce-start', m).value || '09:00', end: $('#ce-end', m).value || '19:00' },
      send_per_minute: Math.max(1, Math.min(60, +$('#ce-rate', m).value || 6)),
      updated_at: new Date().toISOString(),
    };
    if (!row.client_id) throw new Error('Add a client first');
    if (!row.name) throw new Error('Give the campaign a name');
    if (!row.agent.handraiser_templates.length) throw new Error('Add at least one handraiser message');
    if (!row.agent.opt_out_text) throw new Error('Keep an opt-out line: it is a legal requirement for marketing texts');
    const res = isNew ? await sb.from('campaigns').insert(row).select().single() : await sb.from('campaigns').update(row).eq('id', c.id).select().single();
    if (res.error) throw res.error;
    closeModal();
    toast(isNew ? 'Campaign created. Next: upload a CSV.' : 'Saved', 'ok');
    await loadReference();
    renderCampaigns();
    if (isNew) uploadModal(res.data);
  });
}

// Just the qualifying questions, opened from a conversation. Add, reword,
// remove (down to one or two, or none) and reorder; the agent uses the new
// list from its next reply.
function questionsEditor(c) {
  if (!c) return;
  const m = modal(`Qualifying questions: ${c.name}`, `
    <div class="note-box">The agent asks these one at a time, in this order, before offering a callback. Keep it to the few that matter: remove any you don't need, or remove them all and the agent goes straight to booking. Required answers decide when a lead counts as qualified.</div>
    <div id="qe-list" style="display:grid;gap:6px"></div>
    <button class="btn small" type="button" id="qe-add" style="justify-self:start">+ Add question</button>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="qe-save">Save questions</button>`);
  const list = $('#qe-list', m);
  const addRow = (q = { key: '', question: '', required: false }) => {
    const row = document.createElement('div');
    row.className = 'qrow';
    row.style.gridTemplateColumns = 'auto 1fr auto auto';
    row.innerHTML = `<span style="display:grid;gap:2px"><button class="btn small ghost" type="button" data-mv="-1" title="Move up">▲</button><button class="btn small ghost" type="button" data-mv="1" title="Move down">▼</button></span>
      <input data-q="question" placeholder="e.g. Do you own the home?" value="${esc(q.question)}"><input type="hidden" data-q="key" value="${esc(q.key)}">
      <label class="small"><input type="checkbox" data-q="required" ${q.required ? 'checked' : ''}> required</label>
      <button class="btn small ghost" type="button" data-rm title="Remove">×</button>`;
    row.querySelector('[data-rm]').onclick = () => row.remove();
    row.querySelectorAll('[data-mv]').forEach((b) => { b.onclick = () => {
      const sib = b.dataset.mv === '-1' ? row.previousElementSibling : row.nextElementSibling;
      if (sib) b.dataset.mv === '-1' ? list.insertBefore(row, sib) : list.insertBefore(sib, row);
    }; });
    list.appendChild(row);
  };
  (c.agent?.qualification_questions || []).forEach(addRow);
  $('#qe-add', m).onclick = () => { addRow(); list.lastElementChild.querySelector('[data-q=question]').focus(); };
  $('#qe-save', m).onclick = (e) => busy(e.target, async () => {
    const used = new Set();
    const questions = $$('.qrow', list).map((r) => {
      const question = r.querySelector('[data-q=question]').value.trim();
      // Keep a question's key when it's reworded, so answers already given
      // stay attached. New questions get one made from their wording.
      let key = r.querySelector('[data-q=key]').value.trim() ||
        question.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').split('_').slice(0, 4).join('_') || 'q';
      while (used.has(key)) key += '_2';
      used.add(key);
      return { key, question, required: r.querySelector('[data-q=required]').checked };
    }).filter((q) => q.question);
    const { error } = await sb.from('campaigns').update({ agent: { ...(c.agent || {}), qualification_questions: questions }, updated_at: new Date().toISOString() }).eq('id', c.id);
    if (error) throw error;
    closeModal();
    toast(`Saved ${questions.length} question${questions.length === 1 ? '' : 's'}. The agent uses them from its next reply.`, 'ok');
    await loadReference();
    renderInsights();
  });
}

// ---- CSV upload ----
const FIELDS = [
  ['phone', 'Phone *', /(phone|mobile|cell|^number$|contact.?(no|number))/i],
  ['first_name', 'First name', /^(first|given|fname)(.?name)?$/i],
  ['last_name', 'Last name', /^(last|surname|lname|family)(.?name)?$/i],
  ['full_name', 'Full name (split automatically)', /^(name|full.?name|contact|customer|lead.?name)$/i],
  ['email', 'Email', /e-?mail/i],
  ['service', 'Service / enquiry', /(service|product|interest|enquiry|inquiry|interested|job)/i],
  ['enquired_at', 'Enquiry date', /(date|created|enquired|submitted)/i],
  ['source', 'Source', /(source|channel|utm)/i],
  ['notes', 'Notes', /(note|comment|message|description)/i],
];

function uploadModal(c) {
  const m = modal(`Upload leads: ${c.name}`, `
    <div class="note-box">Upload a CSV with at least a phone number column. Australian mobiles in any format work (0412 345 678, +61412345678). Duplicates, opted-out numbers and people already in this client's list are skipped automatically.</div>
    <label>CSV file<input type="file" id="up-file" accept=".csv,text/csv"></label>
    <div id="up-map"></div>
    <label style="display:flex;gap:10px;align-items:flex-start;color:var(--ink);font-size:13px;line-height:1.5"><input type="checkbox" id="up-consent" style="margin-top:3px">
      <span>I confirm every lead in this file enquired with ${esc(clientById(c.client_id)?.name || 'this business')} and has agreed to be contacted by them. <span class="muted">(Recorded with your name and the time.)</span></span></label>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="up-go" disabled>Import</button>`, { wide: true });
  let parsed = null;

  $('#up-file', m).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim(),
      complete: (res) => {
        parsed = res;
        const headers = res.meta.fields || [];
        const used = new Set();
        const guess = {};
        FIELDS.forEach(([k, , re]) => {
          const h = headers.find((x) => !used.has(x) && re.test(x));
          if (h) { guess[k] = h; used.add(h); }
        });
        if (guess.full_name && (guess.first_name || guess.last_name)) delete guess.full_name;
        $('#up-map', m).innerHTML = `<div class="section-title">Match the columns · ${res.data.length} rows</div>
          <div class="map-grid">${FIELDS.map(([k, label]) => `<label>${label}<select data-f="${k}"><option value="">-</option>${headers.map((h) => `<option ${guess[k] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}</div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:4px"><input type="checkbox" id="up-extra" checked> Keep the other columns as extra details the agent can see</label>
          <div id="up-preview" class="small muted"></div>`;
        const update = () => {
          const map = Object.fromEntries($$('[data-f]', m).map((s) => [s.dataset.f, s.value]));
          const rows = mapRows(parsed, map, $('#up-extra', m).checked);
          const valid = rows.filter((r) => /^(\+?\d{8,15})$/.test(String(r.phone || '').replace(/[^\d+]/g, ''))).length;
          $('#up-preview', m).innerHTML = `${valid} of ${rows.length} rows have a usable phone number.` +
            (rows[0] ? `<br>First row: ${esc([rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ') || '(no name)')}, ${esc(rows[0].phone || '(no phone)')}${rows[0].service ? `, ${esc(rows[0].service)}` : ''}` : '');
          $('#up-go', m).disabled = !map.phone || !valid || !$('#up-consent', m).checked;
        };
        m.addEventListener('change', update);
        update();
      },
      error: (err) => toast(err.message, 'err'),
    });
  });

  $('#up-go', m).onclick = (e) => busy(e.target, async () => {
    const map = Object.fromEntries($$('[data-f]', m).map((s) => [s.dataset.f, s.value]));
    const rows = mapRows(parsed, map, $('#up-extra', m).checked);
    const total = { inserted: 0, already_existed: 0, invalid: 0, duplicates_in_file: 0, opted_out: 0 };
    for (let i = 0; i < rows.length; i += 2000) {
      e.target.textContent = `Importing ${Math.min(i + 2000, rows.length)} / ${rows.length}…`;
      const r = await api('import_leads', { campaign_id: c.id, rows: rows.slice(i, i + 2000), consent: $('#up-consent', m).checked });
      Object.keys(total).forEach((k) => { total[k] += r[k] || 0; });
    }
    closeModal();
    modal('Import finished', `<dl class="kv">
      <dt>Added</dt><dd><b>${total.inserted}</b></dd>
      <dt>Already in this client's list</dt><dd>${total.already_existed}</dd>
      <dt>Duplicates in the file</dt><dd>${total.duplicates_in_file}</dd>
      <dt>No usable phone</dt><dd>${total.invalid}</dd>
      <dt>Previously opted out (won't be texted)</dt><dd>${total.opted_out}</dd></dl>
      <div class="note-box">${c.status === 'active' ? 'The campaign is live, so the new leads are queued and will be texted during the sending window.' : 'Launch the campaign when you are ready and the handraisers start going out during the sending window.'}</div>`,
    '<button class="btn primary" data-act="close-modal">Done</button>');
    refreshStats();
  });
}

function mapRows(parsed, map, keepExtra) {
  const usedCols = new Set(Object.values(map).filter(Boolean));
  return parsed.data.map((src) => {
    const get = (k) => (map[k] ? String(src[map[k]] ?? '').trim() : '');
    const r = { phone: get('phone'), first_name: get('first_name'), last_name: get('last_name'), email: get('email'), service: get('service'), enquired_at: get('enquired_at'), source: get('source'), notes: get('notes') };
    if (!r.first_name && map.full_name) {
      const parts = get('full_name').split(/\s+/).filter(Boolean);
      r.first_name = parts.shift() || '';
      r.last_name = r.last_name || parts.join(' ');
    }
    if (r.first_name) r.first_name = r.first_name[0].toUpperCase() + r.first_name.slice(1);
    if (keepExtra) {
      r.extra = {};
      Object.keys(src).forEach((k) => { if (!usedCols.has(k) && String(src[k] ?? '').trim()) r.extra[k] = String(src[k]).trim().slice(0, 300); });
    }
    return r;
  });
}

// ---------------------------------------------------------------------------
// Clients (admin)
// ---------------------------------------------------------------------------
function renderClients() {
  const list = S.clients.filter((c) => !c.is_demo);
  $('#view-clients').innerHTML = `<div class="page-head"><h2>Clients</h2><span class="grow"></span><button class="btn primary" data-act="client-new">+ New client</button></div>
    ${list.length ? `<div class="card table-wrap"><table class="tbl"><thead><tr><th>Client</th><th>Callback hours</th><th>Alerts to</th><th>Leads</th><th>Booked</th><th></th></tr></thead><tbody>
    ${list.map((c) => {
      const rows = S.stats.filter((s) => s.client_id === c.id);
      const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
      const bh = c.business_hours || {};
      return `<tr><td><b>${esc(c.name)}</b>${c.active ? '' : ' <span class="pill mute">inactive</span>'}<div class="small muted">${esc(c.timezone)}</div></td>
        <td class="small">${esc((bh.days || []).map((d) => DAY_LABELS[d - 1]).join(' '))}<br>${esc(bh.start || '')}-${esc(bh.end || '')}</td>
        <td class="small">${esc(c.notify_phone || '')}<br>${esc(c.notify_email || '')}</td>
        <td>${sum('total')}</td><td>${sum('booked')}</td>
        <td><button class="btn small" data-act="client-edit" data-id="${c.id}">Edit</button></td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="card empty">No clients yet. Add the first business you are reactivating leads for.</div>'}`;
}

function clientEditor(c) {
  const isNew = !c;
  c = c || { name: '', timezone: 'Australia/Sydney', business_hours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }, active: true };
  const bh = c.business_hours || {};
  const m = modal(isNew ? 'New client' : `Edit: ${c.name}`, `
    <div class="fields">
      <label class="full">Business name<input id="cl-name" value="${esc(c.name)}"></label>
      <label>Timezone<select id="cl-tz">${[...new Set([c.timezone, ...TIMEZONES])].map((t) => `<option ${t === c.timezone ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label style="display:flex;gap:8px;align-items:center;margin-top:20px"><input type="checkbox" id="cl-active" ${c.active ? 'checked' : ''}> Active</label>
    </div>
    <div class="section-title">When the business can call leads back</div>
    <div class="fields">
      <div class="full"><div class="days" id="cl-days">${DAY_LABELS.map((d, i) => `<label><input type="checkbox" value="${i + 1}" ${(bh.days || []).includes(i + 1) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
      <label>From<input type="time" id="cl-start" value="${esc(bh.start || '09:00')}"></label>
      <label>Until<input type="time" id="cl-end" value="${esc(bh.end || '17:00')}"></label>
    </div>
    <div class="section-title">Callback alerts</div>
    <div class="fields">
      <label>Mobile (SMS alert)<input id="cl-phone" value="${esc(c.notify_phone || '')}" placeholder="04xx xxx xxx"></label>
      <label>Email (comma-separate several)<input id="cl-email" value="${esc(c.notify_email || '')}"></label>
    </div>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="cl-save">${isNew ? 'Create client' : 'Save'}</button>`);
  $('#cl-save', m).onclick = (e) => busy(e.target, async () => {
    const row = {
      name: $('#cl-name', m).value.trim(), timezone: $('#cl-tz', m).value, active: $('#cl-active', m).checked,
      business_hours: { days: $$('#cl-days input:checked', m).map((x) => +x.value), start: $('#cl-start', m).value || '09:00', end: $('#cl-end', m).value || '17:00' },
      notify_phone: $('#cl-phone', m).value.trim() || null, notify_email: $('#cl-email', m).value.trim() || null,
    };
    if (!row.name) throw new Error('Enter the business name');
    if (!row.business_hours.days.length) throw new Error('Pick at least one callback day');
    const res = isNew ? await sb.from('clients').insert(row) : await sb.from('clients').update(row).eq('id', c.id);
    if (res.error) throw res.error;
    closeModal();
    toast('Saved', 'ok');
    await loadReference();
    renderClients();
  });
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------
async function renderUsers() {
  const { data: users, error } = await sb.from('profiles').select('*').order('created_at');
  if (error) { toast(error.message, 'err'); return; }
  const real = S.clients.filter((c) => !c.is_demo);
  $('#view-users').innerHTML = `<div class="page-head"><h2>Users</h2><span class="grow"></span><button class="btn primary" data-act="user-invite">+ Add user</button></div>
    <div class="note-box" style="margin-bottom:14px">Client users only ever see their own business: its leads, conversations and campaigns. Admins see everything and manage campaigns.</div>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>User</th><th>Role</th><th>Client</th><th></th></tr></thead><tbody>
    ${(users || []).map((u) => `<tr><td><b>${esc(u.full_name || '')}</b><div class="small muted">${esc(u.email || '')}</div></td>
      <td><select data-act="user-role" data-id="${u.id}" ${u.id === S.user.id ? 'disabled' : ''}><option value="client" ${u.role === 'client' ? 'selected' : ''}>Client</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
      <td><select data-act="user-client" data-id="${u.id}" ${u.role === 'admin' ? 'disabled' : ''}><option value="">No access</option>${real.map((c) => `<option value="${c.id}" ${c.id === u.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></td>
      <td>${u.id === S.user.id ? '<span class="small muted">You</span>' : `<button class="btn small danger" data-act="user-delete" data-id="${u.id}">Remove</button>`}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function inviteModal() {
  const real = S.clients.filter((c) => !c.is_demo);
  const m = modal('Add a user', `
    <div class="fields">
      <label>Name<input id="iv-name"></label>
      <label>Email<input type="email" id="iv-email"></label>
      <label>Role<select id="iv-role"><option value="client">Client: sees one business</option><option value="admin">Admin: sees everything</option></select></label>
      <label>Client<select id="iv-client">${real.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label class="full">Password (optional)<input id="iv-pw" type="text" minlength="8" placeholder="Leave blank to email them an invite link instead"></label>
    </div>
    <div class="note-box">Invite emails come from Supabase. Its built-in email sender only allows a few emails an hour, so set a password here (and send it to them yourself) or set up custom SMTP in Supabase.</div>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="iv-go">Add user</button>`);
  $('#iv-role', m).onchange = (e) => { $('#iv-client', m).disabled = e.target.value === 'admin'; };
  $('#iv-go', m).onclick = (e) => busy(e.target, async () => {
    await api('invite_user', {
      email: $('#iv-email', m).value, full_name: $('#iv-name', m).value, role: $('#iv-role', m).value,
      client_id: $('#iv-client', m).value, password: $('#iv-pw', m).value || undefined,
    });
    closeModal();
    toast('User added', 'ok');
    renderUsers();
  });
}

// ---------------------------------------------------------------------------
// Do Not Contact (admin)
// One list for the shared number: nobody on it is texted, for any client.
// ---------------------------------------------------------------------------
const DNC_HOW = {
  keyword: 'Replied STOP', asked: 'Asked by text', 'asked on a call': 'Asked on a call',
  manual: 'Added by hand', import: 'Uploaded list',
};
S.dncSearch = '';

async function loadDnc(limit = 500) {
  let q = sb.from('opt_outs').select('*', { count: 'exact' }).order('created_at', { ascending: false }).limit(limit);
  const digits = S.dncSearch.replace(/\D/g, '').replace(/^0/, '');
  if (digits) q = q.ilike('phone', `%${digits}%`);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: data || [], count: count ?? (data || []).length };
}

async function renderDnc() {
  const el = $('#view-dnc');
  let res;
  try { res = await loadDnc(); } catch (e) { toast(e.message, 'err'); return; }
  const who = (r) => r.client_id ? esc(clientById(r.client_id)?.name || 'A client') : '<span class="muted">All clients</span>';
  el.innerHTML = `<div class="page-head"><h2>Do not contact</h2><span class="pill bad">${res.count} number${res.count === 1 ? '' : 's'}</span><span class="grow"></span>
      <button class="btn" data-act="dnc-export">Download CSV</button>
      <button class="btn" data-act="dnc-upload">Upload list</button>
      <button class="btn primary" data-act="dnc-add">+ Add numbers</button></div>
    <div class="note-box" style="margin-bottom:14px">Nobody on this list is ever texted from ${esc(CFG.sharedNumber)}, for any client. They are skipped when lists are uploaded, and the AI won't answer them. Anyone who replies STOP, or asks not to be contacted, is added automatically.</div>
    <input type="search" id="dnc-search" placeholder="Search by number" value="${esc(S.dncSearch)}" style="max-width:320px;margin-bottom:12px">
    ${res.rows.length ? `<div class="card table-wrap"><table class="tbl"><thead><tr><th>Number</th><th>How</th><th>Opted out from</th><th>When</th><th>Note</th><th></th></tr></thead><tbody>
      ${res.rows.map((r) => `<tr><td class="mono">${esc(fmtPhone(r.phone))}</td>
        <td>${esc(DNC_HOW[r.reason] || r.reason || 'Opted out')}${r.added_by ? `<div class="small muted">${esc(r.added_by)}</div>` : ''}</td>
        <td>${who(r)}</td><td class="small">${esc(fmtWhen(r.created_at))}</td><td class="small">${esc(r.note || '')}</td>
        <td><button class="btn small ghost" data-act="dnc-remove" data-phone="${esc(r.phone)}">Remove</button></td></tr>`).join('')}
      </tbody></table></div>${res.count > res.rows.length ? `<div class="small muted" style="margin-top:8px">Showing the latest ${res.rows.length}. Search for a number, or download the CSV for everything.</div>` : ''}`
      : `<div class="card empty">${S.dncSearch ? 'No numbers match.' : 'The list is empty.'}</div>`}`;
  const search = $('#dnc-search');
  search.addEventListener('input', () => {
    clearTimeout(renderDnc.t);
    renderDnc.t = setTimeout(async () => { S.dncSearch = search.value; await renderDnc(); const s = $('#dnc-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 350);
  });
}

function dncClientSelect(id) {
  return `<label>Opted out from (optional)<select id="${id}"><option value="">Not tied to one client</option>${S.clients.filter((c) => !c.is_demo).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>`;
}

async function dncSubmit(btn, phones, clientId, note, reason) {
  const total = { added: 0, already_listed: 0, invalid: 0, leads_stopped: 0 };
  for (let i = 0; i < phones.length; i += 5000) {
    if (phones.length > 5000) btn.textContent = `Adding ${Math.min(i + 5000, phones.length)} / ${phones.length}…`;
    const r = await api('dnc_add', { phones: phones.slice(i, i + 5000), client_id: clientId || null, note, reason });
    Object.keys(total).forEach((k) => { total[k] += r[k] || 0; });
  }
  closeModal();
  modal('Do-not-contact list updated', `<dl class="kv">
    <dt>Added</dt><dd><b>${total.added}</b></dd>
    <dt>Already on the list</dt><dd>${total.already_listed}</dd>
    <dt>Not a valid number</dt><dd>${total.invalid}</dd>
    <dt>Leads stopped</dt><dd>${total.leads_stopped}</dd></dl>
    ${total.leads_stopped ? '<div class="note-box">Those leads are marked opted out. Nothing queued will go to them and the AI won\'t reply.</div>' : ''}`,
  '<button class="btn primary" data-act="close-modal">Done</button>');
  renderDnc();
}

function dncAddModal() {
  const m = modal('Add to do-not-contact', `
    <label>Numbers (one per line, or separated by commas)<textarea id="dnc-numbers" rows="6" placeholder="0412 345 678&#10;+61498765432"></textarea></label>
    <div class="fields">${dncClientSelect('dnc-client')}<label>Note (optional)<input id="dnc-note" placeholder="e.g. Asked by phone not to be contacted"></label></div>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="dnc-go">Add to list</button>`);
  $('#dnc-go', m).onclick = (e) => busy(e.target, async () => {
    const phones = $('#dnc-numbers', m).value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!phones.length) throw new Error('Enter at least one number');
    await dncSubmit(e.target, phones, $('#dnc-client', m).value, $('#dnc-note', m).value.trim(), 'manual');
  });
}

function dncUploadModal() {
  const m = modal('Upload a do-not-contact list', `
    <div class="note-box">A CSV with a phone number column, e.g. a client's own do-not-call list. Australian numbers in any format work.</div>
    <label>CSV file<input type="file" id="dnc-file" accept=".csv,text/csv"></label>
    <div id="dnc-map"></div>
    <div class="fields">${dncClientSelect('dnc-uclient')}<label>Note (optional)<input id="dnc-unote" placeholder="e.g. Client's DNC list, Oct 2026"></label></div>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="dnc-ugo" disabled>Add to list</button>`);
  let parsed = null;
  $('#dnc-file', m).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim(),
      complete: (res) => {
        parsed = res;
        const headers = res.meta.fields || [];
        const guess = headers.find((h) => FIELDS[0][2].test(h)) || headers[0];
        $('#dnc-map', m).innerHTML = `<label>Phone column · ${res.data.length} rows<select id="dnc-col">${headers.map((h) => `<option ${h === guess ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
        $('#dnc-ugo', m).disabled = !headers.length;
      },
      error: (err) => toast(err.message, 'err'),
    });
  });
  $('#dnc-ugo', m).onclick = (e) => busy(e.target, async () => {
    const col = $('#dnc-col', m).value;
    const phones = parsed.data.map((r) => String(r[col] ?? '').trim()).filter(Boolean);
    if (!phones.length) throw new Error('That column has no numbers');
    await dncSubmit(e.target, phones, $('#dnc-uclient', m).value, $('#dnc-unote', m).value.trim(), 'import');
  });
}

// Removing is the one dangerous action here: texting someone who opted out
// breaches the Spam Act. So it needs the number typed back and a reason.
function dncRemoveModal(phone) {
  const shown = fmtPhone(phone);
  const m = modal('Remove from do-not-contact?', `
    <div class="note-box" style="border-color:rgba(255,93,108,.5);color:#ffd0d5">Only do this if <b>${esc(shown)}</b> has asked to hear from you again. Messaging someone who opted out is a breach of the Spam Act. Their leads come back with the AI switched <b>off</b>; turn it on per lead if you want the agent to reply.</div>
    <label>Why are they coming off the list?<input id="dnc-rm-reason" placeholder="e.g. Called on 14 Oct and asked for a quote"></label>
    <label>Type the number to confirm<input id="dnc-rm-confirm" placeholder="${esc(shown)}" autocomplete="off"></label>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn danger" id="dnc-rm-go" disabled>Remove from list</button>`);
  const check = () => {
    const typed = $('#dnc-rm-confirm', m).value.replace(/\D/g, '').replace(/^0/, '').replace(/^61/, '');
    const want = phone.replace(/\D/g, '').replace(/^61/, '');
    $('#dnc-rm-go', m).disabled = !(typed === want && $('#dnc-rm-reason', m).value.trim().length >= 3);
  };
  m.addEventListener('input', check);
  $('#dnc-rm-go', m).onclick = (e) => busy(e.target, async () => {
    const r = await api('dnc_remove', { phone, reason: $('#dnc-rm-reason', m).value.trim() });
    closeModal();
    toast(`Removed. ${r.leads_restored} lead${r.leads_restored === 1 ? '' : 's'} restored with the AI off.`, 'ok');
    renderDnc();
  });
}

async function dncExport(btn) {
  const { data, error } = await sb.from('opt_outs').select('*').order('created_at', { ascending: false }).limit(100000);
  if (error) throw error;
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['phone', 'how', 'client', 'added_by', 'note', 'opted_out_at'].join(',')]
    .concat((data || []).map((r) => [r.phone, DNC_HOW[r.reason] || r.reason, clientById(r.client_id)?.name || '', r.added_by, r.note, r.created_at].map(cell).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `do-not-contact-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Billing
// Admin, all clients: an overview. One client (or a client user): their mode,
// balance or bookings, usage this month, and the actions that go with them.
// ---------------------------------------------------------------------------
const money = (cents) => `$${((cents || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MODE_LABEL = { per_booking: 'Pay per booking', credits: 'Prepaid credits', invoice: 'Invoiced' };
const CHARGE_TONE = { pending: 'info', disputed: 'warm', waived: 'mute', charging: 'info', charged: 'good', failed: 'bad' };
const CREDIT_PACKS = [1000, 5000, 10000, 25000];
const DISPUTE_HOURS = 48;

function monthKey() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-01`;
}

function usageTotals(rows) {
  const t = { sms_out: 0, sms_in: 0, call_minutes: 0, booking: 0, credits: 0 };
  for (const r of rows) { t[r.kind] = (t[r.kind] || 0) + r.quantity; t.credits += r.credits || 0; }
  return t;
}
const estCost = (t) => (t.sms_out + t.sms_in) * CFG.costs.smsSegmentCents + t.call_minutes * CFG.costs.callMinuteCents;

async function renderBilling() {
  const el = $('#view-billing');
  const id = S.isAdmin ? (S.clientFilter !== 'all' && !S.demo ? S.clientFilter : null) : S.profile.client_id;
  if (!id) return renderBillingOverview(el);
  const { data: client } = await sb.from('clients').select('*').eq('id', id).maybeSingle();
  if (!client) { el.innerHTML = '<div class="card empty">Client not found.</div>'; return; }
  const [usage, ledger, charges] = await Promise.all([
    sb.from('usage_monthly').select('*').eq('client_id', id).eq('month', monthKey()),
    sb.from('credit_ledger').select('*').eq('client_id', id).order('created_at', { ascending: false }).limit(30),
    sb.from('booking_charges').select('*').eq('client_id', id).order('booked_at', { ascending: false }).limit(100),
  ]);
  const t = usageTotals(usage.data || []);
  const ch = charges.data || [];
  const monthStart = new Date(monthKey() + 'T00:00:00+10:00');
  const monthCharges = ch.filter((c) => new Date(c.booked_at) >= monthStart && c.status !== 'waived');
  const revenue = client.billing_mode === 'per_booking' ? monthCharges.reduce((a, c) => a + c.amount_cents, 0)
    : client.billing_mode === 'credits' ? (ledger.data || []).filter((l) => l.reason === 'purchase' && new Date(l.created_at) >= monthStart).reduce((a, l) => a + (l.amount_cents || 0), 0) : 0;

  let main = '';
  if (client.billing_mode === 'credits') {
    const low = client.credit_balance <= 0;
    main = `<div class="card"><h4>Credit balance</h4>
      <div style="font-size:34px;font-weight:700;color:${low ? 'var(--bad)' : 'var(--good)'}">${(client.credit_balance || 0).toLocaleString('en-AU')}</div>
      <div class="small muted">1 credit per SMS segment sent or received · ${client.credits_per_call_minute} credits per call minute${low ? '<br><b style="color:var(--bad)">New handraisers are paused until you top up.</b> Conversations already going carry on for a little while.' : ''}</div>
      ${client.price_per_1000_credits_cents > 0 ? `<div class="row-btns" style="margin-top:12px">${CREDIT_PACKS.map((n) => `<button class="btn ${n === 5000 ? 'primary' : ''}" data-act="buy-credits" data-n="${n}" data-client="${client.id}">${n.toLocaleString('en-AU')} credits · ${money(client.price_per_1000_credits_cents * n / 1000)}</button>`).join('')}</div>
        <div class="small muted" style="margin-top:6px">Paid securely by card through Stripe. Nothing is saved for next time.</div>` : '<div class="small muted" style="margin-top:8px">Credit price not set yet.</div>'}
    </div>
    <div class="card table-wrap"><h4>Credit history</h4>${(ledger.data || []).length ? `<table class="tbl"><thead><tr><th>When</th><th>Change</th><th>Balance</th><th>Details</th></tr></thead><tbody>
      ${(ledger.data || []).map((l) => `<tr><td class="small">${esc(fmtWhen(l.created_at))}</td><td style="color:${l.delta > 0 ? 'var(--good)' : 'var(--bad)'}">${l.delta > 0 ? '+' : ''}${l.delta.toLocaleString('en-AU')}</td><td>${l.balance_after.toLocaleString('en-AU')}</td>
        <td class="small">${esc(l.reason === 'purchase' ? `Purchase ${l.amount_cents != null ? money(l.amount_cents) : ''}` : l.reason === 'adjustment' ? `Adjusted${l.created_by ? ` by ${l.created_by}` : ''}` : l.reason)}${l.note ? ` · ${esc(l.note)}` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<div class="small muted">No purchases yet. Usage is itemised below.</div>'}</div>`;
  } else if (client.billing_mode === 'per_booking') {
    const cap = client.monthly_booking_cap;
    main = `<div class="card"><h4>Card on file</h4>
      ${client.stripe_payment_method_id ? `<div style="font-size:18px;font-weight:600">${esc((client.card_brand || 'Card').replace(/^./, (x) => x.toUpperCase()))} •••• ${esc(client.card_last4 || '')}</div>`
        : '<div style="color:var(--bad);font-weight:600">No card yet. New handraisers won\'t go out until one is added.</div>'}
      <div class="small muted" style="margin:6px 0 10px">${money(client.price_per_booking_cents)} per booked callback, charged weekly. Bookings can be disputed within ${DISPUTE_HOURS} hours.${cap != null ? ` Monthly cap: ${monthCharges.length} of ${cap} used; bookings over the cap are free.` : ''}</div>
      <div class="row-btns"><button class="btn primary" data-act="card-setup" data-client="${client.id}">${client.stripe_payment_method_id ? 'Update card' : 'Add a card'}</button>
      ${S.isAdmin ? `<button class="btn" data-act="charge-now" data-client="${client.id}">Charge due bookings now</button>` : ''}</div>
    </div>
    <div class="card table-wrap"><h4>Booked callbacks</h4>${ch.length ? `<table class="tbl"><thead><tr><th>Lead</th><th>Booked</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${ch.map((c) => {
        const canDispute = c.status === 'pending' && (S.isAdmin || Date.now() - new Date(c.booked_at) < DISPUTE_HOURS * 3600e3);
        const btns = [
          canDispute ? `<button class="btn small" data-act="dispute" data-id="${c.id}">Dispute</button>` : '',
          S.isAdmin && ['pending', 'disputed', 'failed'].includes(c.status) ? `<button class="btn small" data-act="resolve" data-id="${c.id}" data-d="waive">Waive</button>` : '',
          S.isAdmin && c.status === 'disputed' ? `<button class="btn small" data-act="resolve" data-id="${c.id}" data-d="uphold">Uphold</button>` : '',
        ].join(' ');
        const note = c.status === 'disputed' ? `Disputed: ${c.dispute_reason || ''}` : c.status === 'failed' ? c.error : c.resolution_note;
        return `<tr><td>${c.lead_id ? `<button class="link" data-act="open-lead" data-id="${c.lead_id}">${esc(c.lead_name || 'Lead')}</button>` : esc(c.lead_name || 'Lead')}</td>
          <td class="small">${esc(fmtWhen(c.booked_at))}</td><td>${money(c.amount_cents)}</td>
          <td><span class="pill ${CHARGE_TONE[c.status]}">${esc(c.status)}</span>${note ? `<div class="small muted">${esc(note)}</div>` : ''}</td><td class="row-btns">${btns}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="small muted">No bookings yet.</div>'}</div>`;
  } else {
    main = '<div class="card"><h4>Billing</h4><div class="small muted">This account is invoiced directly. Usage is recorded below for reference.</div></div>';
  }

  const usageCard = `<div class="card"><h4>This month's usage</h4>
    <div class="funnel" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat"><b>${t.sms_out.toLocaleString('en-AU')}</b><span>SMS sent</span></div>
      <div class="stat"><b>${t.sms_in.toLocaleString('en-AU')}</b><span>SMS received</span></div>
      <div class="stat"><b>${t.call_minutes}</b><span>Call mins</span></div>
      <div class="stat good"><b>${t.booking}</b><span>Booked</span></div></div>
    <div class="small muted" style="margin-top:8px">SMS counted in segments (160 characters each, 70 with emoji).${client.billing_mode === 'credits' ? ` ${t.credits.toLocaleString('en-AU')} credits used.` : ''}</div>
    ${S.isAdmin ? `<div class="note-box" style="margin-top:10px">Admin only. Revenue this month <b>${money(revenue)}</b> · estimated cost <b>${money(estCost(t))}</b> · margin <b>${money(revenue - estCost(t))}</b><br><span class="muted">Cost is an estimate from config.js (${CFG.costs.smsSegmentCents}c per segment, ${CFG.costs.callMinuteCents}c per call minute) plus OpenAI, which isn't counted.</span></div>` : ''}
  </div>`;

  const settings = S.isAdmin ? `<div class="card"><h4>Billing settings (admin)</h4>
    <div class="fields">
      <label>Mode<select id="bs-mode">${Object.entries(MODE_LABEL).map(([k, v]) => `<option value="${k}" ${k === client.billing_mode ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Billing email (receipts)<input id="bs-email" value="${esc(client.billing_email || '')}" placeholder="${esc(client.notify_email || '')}"></label>
      <label>Price per booking ($)<input id="bs-booking" type="number" min="0" step="0.01" value="${(client.price_per_booking_cents / 100).toFixed(2)}"></label>
      <label>Monthly booking cap (blank = none)<input id="bs-cap" type="number" min="0" value="${client.monthly_booking_cap ?? ''}"></label>
      <label>Price per 1,000 credits ($)<input id="bs-credits" type="number" min="0" step="0.01" value="${(client.price_per_1000_credits_cents / 100).toFixed(2)}"></label>
      <label>Credits per call minute<input id="bs-minute" type="number" min="0" value="${client.credits_per_call_minute}"></label>
      <label>Overdraft for live conversations (credits)<input id="bs-overdraft" type="number" min="0" value="${client.credit_overdraft}"></label>
    </div>
    <div class="row-btns" style="margin-top:10px"><button class="btn primary" data-act="billing-save" data-client="${client.id}">Save settings</button></div>
    ${client.billing_mode === 'credits' ? `<div class="inline-form" style="grid-template-columns:120px 1fr auto;align-items:end;margin-top:14px">
      <label>Adjust credits<input id="bs-adj" type="number" placeholder="+500 or -200"></label><label>Note<input id="bs-adj-note" placeholder="e.g. Goodwill credit"></label>
      <button class="btn" data-act="credits-adjust" data-client="${client.id}">Apply</button></div>` : ''}
  </div>` : '';

  el.innerHTML = `<div class="page-head"><h2>Billing${S.isAdmin ? `: ${esc(client.name)}` : ''}</h2><span class="pill hud">${esc(MODE_LABEL[client.billing_mode])}</span><span class="grow"></span>
      ${S.isAdmin ? '<button class="btn small" data-act="billing-all">All clients</button>' : ''}<button class="btn small" data-act="billing-refresh">↻ Refresh</button></div>
    <div style="display:grid;gap:14px;max-width:980px">${main}${usageCard}${settings}</div>`;
}

async function renderBillingOverview(el) {
  const real = S.clients.filter((c) => !c.is_demo);
  const [{ data: clients }, { data: usage }, { data: pending }] = await Promise.all([
    sb.from('clients').select('*').eq('is_demo', false).order('name'),
    sb.from('usage_monthly').select('*').eq('month', monthKey()),
    sb.from('booking_charges').select('client_id, amount_cents, status').in('status', ['pending', 'disputed', 'failed']),
  ]);
  const rows = (clients || real).map((c) => {
    const t = usageTotals((usage || []).filter((u) => u.client_id === c.id));
    const open = (pending || []).filter((p) => p.client_id === c.id);
    const state = c.billing_mode === 'credits' ? `${(c.credit_balance || 0).toLocaleString('en-AU')} credits`
      : c.billing_mode === 'per_booking' ? `${c.stripe_payment_method_id ? `${esc(c.card_brand || 'card')} •••• ${esc(c.card_last4 || '')}` : '<span style="color:var(--bad)">No card</span>'}${open.length ? ` · ${open.length} due ${money(open.reduce((a, p) => a + p.amount_cents, 0))}` : ''}${open.some((p) => p.status === 'failed') ? ' · <span style="color:var(--bad)">failed charge</span>' : ''}${open.some((p) => p.status === 'disputed') ? ' · <span style="color:var(--warm)">dispute</span>' : ''}`
      : '-';
    return `<tr><td><button class="link" data-act="billing-client" data-id="${c.id}">${esc(c.name)}</button></td><td>${esc(MODE_LABEL[c.billing_mode] || c.billing_mode)}</td><td class="small">${state}</td>
      <td>${(t.sms_out + t.sms_in).toLocaleString('en-AU')}</td><td>${t.call_minutes}</td><td>${t.booking}</td><td class="small">${money(estCost(t))}</td></tr>`;
  });
  el.innerHTML = `<div class="page-head"><h2>Billing</h2><span class="grow"></span><button class="btn small" data-act="billing-refresh">↻ Refresh</button></div>
    <div class="note-box" style="margin-bottom:14px">Pick a client to set their billing mode and prices, buy or adjust credits, or deal with booking charges. Booking charges run every Monday morning for bookings older than ${DISPUTE_HOURS} hours.</div>
    ${rows.length ? `<div class="card table-wrap"><table class="tbl"><thead><tr><th>Client</th><th>Mode</th><th>Status</th><th>SMS this month</th><th>Call mins</th><th>Booked</th><th>Est. cost</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : '<div class="card empty">No clients yet.</div>'}`;
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------
function demoModal() {
  const m = modal('Start a demo', `
    <div class="note-box">Shows a prospect exactly how the agent works, with no texts sent. You type the lead's replies and the agent answers live through OpenAI, qualifies, and books the callback, just as it would by SMS.</div>
    <div class="fields">
      <label>Niche<select id="dm-niche">${S.presets.map((p) => `<option value="${p.slug}">${esc(p.name)}</option>`).join('')}</select></label>
      <label>Prospect's business name<input id="dm-company" placeholder="e.g. Sunshine Solar"></label>
      <label>Agent name<input id="dm-bot" placeholder="${esc(S.presets[0]?.config?.bot_name || 'Sarah')}"></label>
      <label>Lead's first name<input id="dm-first" value="Alex"></label>
      <label class="full">What the lead enquired about<input id="dm-service" placeholder="${esc(S.presets[0]?.config?.service || '')}"></label>
    </div>`,
  `<button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="dm-go">Start demo</button>`);
  $('#dm-niche', m).onchange = (e) => {
    const p = presetBySlug(e.target.value);
    $('#dm-bot', m).placeholder = p?.config?.bot_name || '';
    $('#dm-service', m).placeholder = p?.config?.service || '';
  };
  $('#dm-go', m).onclick = (e) => busy(e.target, async () => {
    const r = await api('demo_start', {
      niche: $('#dm-niche', m).value, company_name: $('#dm-company', m).value, bot_name: $('#dm-bot', m).value,
      first_name: $('#dm-first', m).value, service: $('#dm-service', m).value,
    });
    closeModal();
    await loadReference();
    setDemo(true);
    S.clientFilter = 'all';
    renderClientFilter();
    setView('inbox');
    await loadLeads();
    await openLead(r.lead_id);
    $('#compose-text')?.focus();
  });
}

function setDemo(on) {
  S.demo = on;
  S.lead = null;
  S.campaignFilter = '';
  $('#demo-ribbon').hidden = !on;
  $('#demo-toggle').classList.toggle('on', on);
  renderClientFilter();
  renderCampaignFilter();
  renderChat();
  renderInsights();
  if (S.view === 'campaigns') renderCampaigns();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
const ACT = {
  open: (el) => openLead(el.dataset.id),
  more: () => { S.leadLimit += 200; loadLeads(); },
  filter: (el) => { S.statusFilter = el.dataset.k; renderChips(); loadLeads(); },
  tab: (el) => setTab(el.dataset.tab),
  insights: () => $('#view-inbox').classList.toggle('show-insights'),
  'close-modal': closeModal,
  menu: () => { $('#menu-pop').hidden = !$('#menu-pop').hidden; },
  signout: () => sb.auth.signOut(),
  forgot: async () => {
    const email = $('#login-email').value.trim();
    if (!email) { $('#login-msg').textContent = 'Enter your email first.'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $('#login-msg').textContent = error ? error.message : 'Check your email for a reset link.';
  },
  'toggle-demo': () => { setDemo(!S.demo); if (S.view === 'inbox') loadLeads(); else setView(S.view); },
  'demo-new': demoModal,
  'note-mode': (el) => { S.composeNote = el.checked; renderComposer(); },

  send: (el) => busy(el, async () => {
    const ta = $('#compose-text');
    const body = ta.value.trim();
    if (!body) return;
    if (S.lead.is_demo) await api('demo_reply', { lead_id: S.lead.id, body });
    else if (S.composeNote) await api('add_note', { lead_id: S.lead.id, body });
    else await api('send_message', { lead_id: S.lead.id, body });
    ta.value = '';
    ta.style.height = '';
  }),
  'toggle-ai': (el) => busy(el, () => api('set_ai', { lead_id: S.lead.id, enabled: !S.lead.ai_enabled })),
  'refresh-insights': (el) => busy(el, async () => { await api('refresh_insights', { lead_id: S.lead.id }); toast('Insights updated', 'ok'); }),
  'clear-callback': (el) => busy(el, () => api('clear_callback', { lead_id: S.lead.id })),
  'book-open': () => { const f = $('#book-form'); f.hidden = !f.hidden; },
  'questions-edit': () => questionsEditor(campaignById(S.lead.campaign_id)),
  'demo-delete': (el) => busy(el, async () => {
    if (!confirm(`Delete this demo with ${S.lead.first_name || 'the lead'}? The conversation is removed for good.`)) return;
    await api('demo_delete', { lead_id: S.lead.id });
    S.lead = null;
    await loadReference(); renderChat(); renderInsights(); loadLeads();
    toast('Demo deleted', 'ok');
  }),
  'demo-delete-campaign': (el) => busy(el, async () => {
    const c = campaignById(el.dataset.id);
    if (!confirm(`Delete "${c.name}" and its demo conversations? This can't be undone.`)) return;
    await api('demo_delete', { campaign_id: c.id });
    if (S.lead?.campaign_id === c.id) S.lead = null;
    await loadReference(); renderCampaigns();
    toast('Demo deleted', 'ok');
  }),
  'demo-reset': (el) => busy(el, async () => { await api('demo_reset', { lead_id: S.lead.id }); await openLead(S.lead.id, { tab: false }); }),

  'campaign-new': () => campaignEditor(null),
  'campaign-edit': (el) => campaignEditor(campaignById(el.dataset.id)),
  'campaign-upload': (el) => uploadModal(campaignById(el.dataset.id)),
  'campaign-leads': (el) => { S.campaignFilter = el.dataset.id; renderCampaignFilter(); setView('inbox'); },
  'campaign-launch': (el) => busy(el, async () => {
    const c = campaignById(el.dataset.id);
    const st = S.stats.find((s) => s.campaign_id === c.id) || {};
    if (!confirm(`${c.status === 'paused' ? 'Resume' : 'Launch'} "${c.name}"? ${st.pending || 0} leads will be texted from ${CFG.sharedNumber} during the sending window.`)) return;
    const r = await api('campaign_launch', { campaign_id: c.id });
    toast(`Live. ${r.queued} leads queued.`, 'ok');
    await loadReference(); renderCampaigns();
  }),
  'campaign-pause': (el) => busy(el, async () => {
    await api('campaign_pause', { campaign_id: el.dataset.id });
    toast('Paused. Conversations already going keep going.', 'ok');
    await loadReference(); renderCampaigns();
  }),

  'client-new': () => clientEditor(null),
  'client-edit': (el) => clientEditor(clientById(el.dataset.id)),
  'user-invite': inviteModal,
  'billing-refresh': () => renderBilling(),
  'billing-all': () => { S.clientFilter = 'all'; renderClientFilter(); renderBilling(); },
  'billing-client': (el) => { S.clientFilter = el.dataset.id; renderClientFilter(); renderCampaignFilter(); renderBilling(); },
  'open-lead': (el) => { setView('inbox'); openLead(el.dataset.id); },
  'buy-credits': (el) => busy(el, async () => { location.href = (await api('credits_checkout', { client_id: el.dataset.client, credits: +el.dataset.n })).url; }),
  'card-setup': (el) => busy(el, async () => { location.href = (await api('card_setup', { client_id: el.dataset.client })).url; }),
  'charge-now': (el) => busy(el, async () => {
    if (!confirm('Charge this client now for every booking past the dispute window?')) return;
    const r = await api('billing_charge_now', { client_id: el.dataset.client });
    toast(r.error ? `Charge failed: ${r.error}` : r.charged ? `Charged ${money(r.charged)}` : 'Nothing due yet', r.error ? 'err' : 'ok');
    renderBilling();
  }),
  'dispute': (el) => busy(el, async () => {
    const reason = prompt('Why shouldn\'t this booking be charged? (e.g. the lead says they never booked, wrong number, already a customer)');
    if (!reason || !reason.trim()) return;
    await api('booking_dispute', { charge_id: el.dataset.id, reason });
    toast('Disputed. It won\'t be charged while we review it.', 'ok');
    renderBilling();
  }),
  'resolve': (el) => busy(el, async () => {
    const waive = el.dataset.d === 'waive';
    const note = prompt(waive ? 'Waive this booking: note (optional)' : 'Uphold: it will be charged in the next run. Note (optional)');
    if (note === null) return;
    await api('booking_resolve', { charge_id: el.dataset.id, decision: el.dataset.d, note });
    renderBilling();
  }),
  'billing-save': (el) => busy(el, async () => {
    const cents = (id) => Math.round(Math.max(0, parseFloat($(id).value) || 0) * 100);
    const capRaw = $('#bs-cap').value.trim();
    const { error } = await sb.from('clients').update({
      billing_mode: $('#bs-mode').value, billing_email: $('#bs-email').value.trim() || null,
      price_per_booking_cents: cents('#bs-booking'), price_per_1000_credits_cents: cents('#bs-credits'),
      credits_per_call_minute: Math.max(0, parseInt($('#bs-minute').value, 10) || 0),
      credit_overdraft: Math.max(0, parseInt($('#bs-overdraft').value, 10) || 0),
      monthly_booking_cap: capRaw === '' ? null : Math.max(0, parseInt(capRaw, 10) || 0),
    }).eq('id', el.dataset.client);
    if (error) throw error;
    toast('Billing settings saved', 'ok');
    await loadReference();
    renderBilling();
  }),
  'credits-adjust': (el) => busy(el, async () => {
    const r = await api('credits_adjust', { client_id: el.dataset.client, delta: +$('#bs-adj').value, note: $('#bs-adj-note').value });
    toast(`Balance now ${Number(r.balance).toLocaleString('en-AU')} credits`, 'ok');
    renderBilling();
  }),
  'dnc-add': dncAddModal,
  'dnc-upload': dncUploadModal,
  'dnc-remove': (el) => dncRemoveModal(el.dataset.phone),
  'dnc-export': (el) => busy(el, () => dncExport(el)),
  'user-delete': (el) => busy(el, async () => {
    if (!confirm('Remove this user? They will no longer be able to sign in.')) return;
    await api('delete_user', { user_id: el.dataset.id });
    renderUsers();
  }),
};

document.addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]');
  if (v) { setView(v.dataset.view); return; }
  const t = e.target.closest('#mobile-tabs [data-tab]');
  if (t) { setTab(t.dataset.tab); return; }
  const el = e.target.closest('[data-act]');
  if (el && el.tagName !== 'SELECT' && !(el.tagName === 'INPUT' && el.type !== 'checkbox') && ACT[el.dataset.act]) {
    if (el.tagName === 'INPUT') { ACT[el.dataset.act](el, e); return; }
    e.preventDefault();
    ACT[el.dataset.act](el, e);
  }
  if (!e.target.closest('.menu')) $('#menu-pop').hidden = true;
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'client-filter') {
    S.clientFilter = el.value; S.lead = null; S.campaignFilter = '';
    renderCampaignFilter(); renderChat(); renderInsights();
    if (S.view === 'inbox') loadLeads(); else setView(S.view);
  } else if (el.id === 'campaign-filter') {
    S.campaignFilter = el.value; loadLeads();
  } else if (el.dataset.act === 'set-status' && el.value) {
    await busy(el, () => api('set_status', { lead_id: S.lead.id, status: el.value }));
  } else if (el.dataset.act === 'user-role') {
    const { error } = await sb.from('profiles').update({ role: el.value, ...(el.value === 'admin' ? { client_id: null } : {}) }).eq('id', el.dataset.id);
    if (error) toast(error.message, 'err'); else renderUsers();
  } else if (el.dataset.act === 'user-client') {
    const { error } = await sb.from('profiles').update({ client_id: el.value || null }).eq('id', el.dataset.id);
    toast(error ? error.message : 'Saved', error ? 'err' : 'ok');
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'book-form') return;
  e.preventDefault();
  busy(e.submitter, () => api('book_callback', { lead_id: S.lead.id, local_time: $('#book-time').value, notes: $('#book-notes').value }));
});

let searchTimer = 0;
$('#lead-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.search = e.target.value; loadLeads(); }, 300);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
// Relative times in the list drift; refresh them now and then.
setInterval(() => { if (S.view === 'inbox' && document.visibilityState === 'visible') renderLeadList(); }, 60000);

start();
})();
