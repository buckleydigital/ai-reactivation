// =============================================================================
// reactivation - the whole backend for AI Database Reactivation, in one file
// =============================================================================
// One function so it can be pasted straight into the Supabase dashboard. It
// routes on the path after /functions/v1/reactivation:
//
//   POST /api            the app (signed-in users; JWT checked here)
//   POST /cron           send queue, called every minute by pg_cron
//   POST /twilio/sms     Twilio: a text came in on the shared number
//   POST /twilio/status  Twilio: delivery status of a text we sent
//   POST /twilio/voice   Twilio: a call came in on the shared number
//   POST /openai/call    OpenAI: the call has reached the Realtime API
//
// "Enforce JWT verification" must be OFF for this function: Twilio, OpenAI and
// pg_cron cannot send a Supabase JWT. Each route authenticates itself instead:
// Twilio signatures, OpenAI webhook signatures, a cron secret, or the user's
// access token.
//
// Secrets (Edge Functions -> Secrets):
//   OPENAI_API_KEY          required
//   OPENAI_MODEL            optional, default gpt-5-mini (SMS replies)
//   OPENAI_REALTIME_MODEL   optional, default gpt-realtime (calls)
//   OPENAI_PROJECT_ID       for calls: proj_... (Twilio dials it over SIP)
//   OPENAI_WEBHOOK_SECRET   for calls: whsec_... from the OpenAI webhook
//   TWILIO_ACCOUNT_SID      required
//   TWILIO_AUTH_TOKEN       required
//   TWILIO_NUMBER           required, the shared number, e.g. +61485074685
//   CRON_SECRET             required, same value as in 003_send_queue_cron.sql
//   SIP_HEADER_SECRET       for calls: any long random string
//   APP_URL                 the app's address, for invite emails
//   RESEND_API_KEY          optional, emails "callback booked" alerts
//   NOTIFY_FROM_EMAIL       optional, the From address for those emails
// =============================================================================

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SUPABASE_URL = env("SUPABASE_URL");
const FN_BASE = `${SUPABASE_URL}/functions/v1/reactivation`;
const OPENAI_MODEL = env("OPENAI_MODEL", "gpt-5-mini");
const REALTIME_MODEL = env("OPENAI_REALTIME_MODEL", "gpt-realtime");
// How long the agent waits before answering a real text: a random 30-60s, so
// it reads like a person picking up their phone, not a bot. If the lead texts
// again in that time the wait starts over, so a burst of texts gets one
// reply. Demo leads answer almost at once.
//
// The wait runs inside the function, after Twilio has had its response, so
// it counts towards the function's run time (150s free plan, 400s paid). A
// 60s wait plus a reply (usually 5-15s) fits either.
const SMS_REPLY_DELAY_MIN_MS = Number(env("SMS_REPLY_DELAY_MIN_MS", "30000"));
const SMS_REPLY_DELAY_MAX_MS = Number(env("SMS_REPLY_DELAY_MAX_MS", "60000"));
const replyDelay = (demo: boolean) => demo ? 600
  : SMS_REPLY_DELAY_MIN_MS + Math.random() * Math.max(0, SMS_REPLY_DELAY_MAX_MS - SMS_REPLY_DELAY_MIN_MS);
// The sideband connection lives inside this function, so it can only last as
// long as the function may run (150s on the free plan, 400s on paid). The call
// itself carries on after that; only bookings made by voice after this point
// would be missed, and the post-call summary still runs.
const SIDEBAND_MAX_MS = Number(env("SIDEBAND_MAX_MS", "380000"));

const db: SupabaseClient = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// =============================================================================
// Router
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const route = new URL(req.url).pathname.replace(/^.*?\/reactivation/, "") || "/";
  try {
    switch (route) {
      case "/api": return await handleApi(req);
      case "/cron": return await handleCron(req);
      case "/twilio/sms": return await handleTwilioSms(req);
      case "/twilio/status": return await handleTwilioStatus(req);
      case "/twilio/voice": return await handleTwilioVoice(req);
      case "/openai/call": return await handleOpenAiCall(req);
      default: return json({ error: "Not found" }, 404);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(`[${route}]`, e);
    // Twilio retries anything that is not a 2xx, which would only repeat the
    // failure, so its routes still answer with empty TwiML.
    if (route.startsWith("/twilio/")) return twiml("");
    return json({ error: (e as Error).message || "Server error" }, 500);
  }
});

// =============================================================================
// Small helpers
// =============================================================================

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function twiml(inner: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    status: 200, headers: { "Content-Type": "text/xml" },
  });
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

function background(p: Promise<unknown>) {
  const guarded = p.catch((e) => console.error("background task:", e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(guarded);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const clean = (v: unknown, max = 500) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

// House rule, shared with ql-hq and ql-mc: nothing we send contains an em
// dash. Em dashes (and spaced en dashes) become " - ", a bare en dash as in
// "7–14 days" becomes a hyphen. Applied to every text and email on the way
// out and to everything the model writes, so the app shows exactly what the
// lead received.
const EM = "(?:—|―|&mdash;|&#0*8212;|&#x0*2014;|&#0*8213;|&#x0*2015;)";
const EN = "(?:–|&ndash;|&#0*8211;|&#x0*2013;)";
const DASH_RULES: Array<[RegExp, string]> = [
  [new RegExp(`^[ \\t]*(?:${EM}|${EN})[ \\t]*`, "gim"), "- "],
  [new RegExp(`[ \\t]*${EM}[ \\t]*`, "gi"), " - "],
  [new RegExp(`[ \\t]+${EN}[ \\t]+`, "gi"), " - "],
  [new RegExp(EN, "gi"), "-"],
];
function noEmDash(s: string): string {
  let out = s;
  for (const [re, to] of DASH_RULES) out = out.replace(re, to);
  return out;
}
function cleanDeep<T>(v: T): T {
  if (typeof v === "string") return noEmDash(v) as T;
  if (Array.isArray(v)) return v.map(cleanDeep) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, cleanDeep(x)])) as T;
  }
  return v;
}
const NO_DASH_RULE = "Never use em dashes or en dashes. Use a comma, a full stop or a plain hyphen instead.";

// Phones are stored E.164. Australian local formats are converted; anything
// already international is kept as long as it looks like a phone number.
function normalisePhone(raw: unknown): string | null {
  let p = String(raw ?? "").replace(/[^\d+]/g, "");
  if (!p) return null;
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (p.startsWith("+")) return /^\+\d{8,15}$/.test(p) ? p : null;
  if (p.startsWith("61") && p.length === 11) return "+" + p;
  if (p.startsWith("0") && p.length === 10) return "+61" + p.slice(1);
  if (p.startsWith("4") && p.length === 9) return "+61" + p;
  return null;
}

// Every stored format that could hold the same phone, for routing.
function phoneVariants(e164: string): string[] {
  const v = [e164, e164.replace(/^\+/, "")];
  if (e164.startsWith("+61")) v.push("0" + e164.slice(3));
  return v;
}

function leadName(lead: Row): string {
  return [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown";
}

const enc = new TextEncoder();

async function hmac(hash: "SHA-1" | "SHA-256", key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", (typeof key === "string" ? enc.encode(key) : key) as BufferSource, { name: "HMAC", hash }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- Time --------------------------------------------------------------------
// Business hours, send windows and callbacks are all in the client's timezone.

const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function zoned(date: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second,
    dow: DOW[parts.weekday], ymd: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}`,
  };
}

function tzOffsetMs(date: Date, tz: string): number {
  const z = zoned(date, tz);
  return Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s) - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-10-14T15:30" in the client's timezone -> the real instant.
function localToUtc(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = guess - tzOffsetMs(new Date(guess), tz);
  utc = guess - tzOffsetMs(new Date(utc), tz); // second pass settles DST edges
  return new Date(utc);
}

type Window = { days: number[]; start: string; end: string };

function inWindow(date: Date, tz: string, w: Window): boolean {
  const z = zoned(date, tz);
  return arr<number>(w?.days).includes(z.dow) && z.hm >= (w.start || "00:00") && z.hm < (w.end || "24:00");
}

function fmtLocal(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  }).format(date);
}

function daysText(days: number[]): string {
  const d = [...arr<number>(days)].sort();
  if (d.join() === "1,2,3,4,5") return "Monday to Friday";
  if (d.join() === "1,2,3,4,5,6") return "Monday to Saturday";
  if (d.join() === "1,2,3,4,5,6,7") return "every day";
  return d.map((n) => DAY_NAMES[n]).join(", ");
}

// The next fortnight as "Tue 14 Oct = 2026-10-14", so the model can turn
// "Thursday arvo" into a real date without doing calendar maths.
function calendarHint(tz: string): string {
  const out: string[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const z = zoned(d, tz);
    const label = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
    out.push(`${label} = ${z.ymd}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`);
  }
  return out.join("\n");
}

// =============================================================================
// Twilio
// =============================================================================

async function twilioSignatureOk(req: Request, params: Record<string, string>, url: string): Promise<boolean> {
  const sig = req.headers.get("X-Twilio-Signature") || "";
  const token = env("TWILIO_AUTH_TOKEN");
  if (!sig || !token) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return safeEqual(b64(await hmac("SHA-1", token, data)), sig);
}

async function twilioSend(to: string, body: string): Promise<string> {
  const sid = env("TWILIO_ACCOUNT_SID"), token = env("TWILIO_AUTH_TOKEN"), from = env("TWILIO_NUMBER");
  if (!sid || !token || !from) throw new Error("Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBER)");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: noEmDash(body), StatusCallback: `${FN_BASE}/twilio/status` }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Twilio error ${r.status}`);
  return j.sid as string;
}

// =============================================================================
// OpenAI
// =============================================================================

async function openaiJSON<T = Row>(messages: Row[], name: string, schema: Row): Promise<T> {
  const key = env("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const body: Row = {
    model: OPENAI_MODEL,
    messages,
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
  };
  // Reasoning models take an effort level; older chat models reject it.
  if (/^(gpt-5|o\d)/.test(OPENAI_MODEL)) body.reasoning_effort = env("OPENAI_REASONING_EFFORT", "low");

  // One retry: a timeout, a 5xx/429 or an unreadable answer is usually fine
  // on the second go, and the alternative is a lead left without a reply.
  let lastErr: Error = new Error("OpenAI failed");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(800);
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = new Error(`OpenAI: ${j.error?.message || r.status}`);
        if (r.status >= 500 || r.status === 429) continue;
        throw lastErr; // a 4xx (bad key, bad request) won't fix itself
      }
      const msg = j.choices?.[0]?.message || {};
      const parsed = readJSON(msg.content, schema) ??
        // The answer sometimes comes back in the refusal field instead of
        // content, prefixed with "json". Take it if it's the object we asked
        // for; a genuine refusal won't parse into that shape.
        readJSON(msg.refusal, schema);
      if (parsed) return cleanDeep(parsed) as T;
      lastErr = new Error(`OpenAI returned no usable answer (finish: ${j.choices?.[0]?.finish_reason || "?"})` +
        (msg.refusal ? `: ${String(msg.refusal).slice(0, 200)}` : ""));
    } catch (e) {
      if (e === lastErr) throw e;
      lastErr = e as Error;
    }
  }
  throw lastErr;
}

// The JSON object in a model's answer, if it has every key the schema needs.
function readJSON(text: unknown, schema: Row): Row | null {
  if (typeof text !== "string") return null;
  const i = text.indexOf("{"), k = text.lastIndexOf("}");
  if (i < 0 || k < i) return null;
  try {
    const v = JSON.parse(text.slice(i, k + 1));
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return arr<string>(schema.required).every((key) => key in v) ? v : null;
  } catch {
    return null;
  }
}

async function openaiPost(path: string, body: Row): Promise<Response> {
  return await fetch(`https://api.openai.com/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// OpenAI signs webhooks the Standard Webhooks way.
async function openaiWebhookOk(headers: Headers, body: string): Promise<boolean> {
  const secret = env("OPENAI_WEBHOOK_SECRET");
  const id = headers.get("webhook-id"), ts = headers.get("webhook-timestamp"), sigs = headers.get("webhook-signature");
  if (!secret || !id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const expected = b64(await hmac("SHA-256", key, `${id}.${ts}.${body}`));
  return sigs.split(" ").some((s) => safeEqual(s.split(",")[1] || "", expected));
}

// =============================================================================
// The agent
// =============================================================================

type Agent = {
  bot_name: string; company_name: string; service: string; tone: string;
  handraiser_templates: string[]; handraiser_mode: "template" | "ai"; opt_out_text: string;
  qualification_questions: { key: string; question: string; required?: boolean }[];
  disqualifiers: string[]; compliance_notes: string; extra_instructions: string; voice: string;
};

function agentConfig(campaign: Row | null, client: Row): Agent {
  const a = campaign?.agent || {};
  return {
    bot_name: a.bot_name || "Sarah",
    company_name: a.company_name || client.name,
    service: a.service || "your enquiry",
    tone: a.tone || "Friendly, warm and professional.",
    handraiser_templates: arr<string>(a.handraiser_templates).filter((t) => String(t || "").trim()),
    handraiser_mode: a.handraiser_mode === "ai" ? "ai" : "template",
    opt_out_text: a.opt_out_text ?? "Reply STOP to opt out.",
    qualification_questions: arr<Row>(a.qualification_questions)
      .filter((q) => q && q.key && q.question)
      .map((q) => ({ key: String(q.key), question: String(q.question), required: !!q.required })),
    disqualifiers: arr<string>(a.disqualifiers).filter(Boolean),
    compliance_notes: a.compliance_notes || "",
    extra_instructions: a.extra_instructions || "",
    voice: a.voice || "marin",
  };
}

type Ctx = { lead: Row; client: Row; campaign: Row | null; agent: Agent; messages: Row[] };

async function loadCtx(leadId: string): Promise<Ctx | null> {
  const { data: lead } = await db.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) return null;
  const [{ data: client }, campaignRes, { data: msgs }] = await Promise.all([
    db.from("clients").select("*").eq("id", lead.client_id).single(),
    lead.campaign_id
      ? db.from("campaigns").select("*").eq("id", lead.campaign_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from("messages").select("*").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(60),
  ]);
  const campaign = (campaignRes as { data: Row | null }).data;
  return { lead, client: client!, campaign, agent: agentConfig(campaign, client!), messages: (msgs || []).reverse() };
}

// ---- Prompt ------------------------------------------------------------------

function factSheet(ctx: Ctx): string {
  const { lead, client, agent } = ctx;
  const tz = client.timezone || "Australia/Sydney";
  const bh: Window = client.business_hours || { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  const now = new Date();
  const extra = Object.entries(lead.extra || {}).filter(([, v]) => v !== null && v !== "").slice(0, 15)
    .map(([k, v]) => `- ${k}: ${String(v).slice(0, 200)}`).join("\n");
  const known = Object.entries(lead.qualification || {}).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const questions = agent.qualification_questions
    .map((q) => `- ${q.key}: ${q.question}${q.required ? " (required)" : " (optional)"}`).join("\n");
  // Spelled out so the agent can't lose track of what's left to ask.
  const answered = lead.qualification || {};
  const toAsk = agent.qualification_questions.filter((q) => !String(answered[q.key] || "").trim())
    .map((q) => `- ${q.key}: ${q.question}`).join("\n");

  return `## The business
${agent.company_name}
${agent.extra_instructions ? `\n## Extra instructions from the business\n${agent.extra_instructions}\n` : ""}
## The lead
Name: ${leadName(lead)}
Mobile: ${lead.phone}
They enquired about: ${lead.service || agent.service}${lead.enquired_at ? ` (enquired ${lead.enquired_at})` : ""}
${lead.notes ? `Notes from the business: ${lead.notes}\n` : ""}${extra ? `Other details:\n${extra}\n` : ""}
## Qualifying questions
Ask EVERY question below, required and optional, one at a time and in your own words, before you offer callback times. Only skip an optional one if the lead is short with you or asks to book straight away.
${questions || "- (none set: just confirm their interest and book the callback)"}

Answers so far:
${known || "- none yet"}

Still to ask:
${questions ? toAsk || "- nothing: all answered, move on to booking the callback" : "- nothing"}
${agent.disqualifiers.length ? `\n## Disqualifiers\nIf any of these is true, politely wrap up without booking:\n${agent.disqualifiers.map((d) => `- ${d}`).join("\n")}\n` : ""}${agent.compliance_notes ? `\n## Compliance (must follow)\n${agent.compliance_notes}\n` : ""}
## Booking a callback
A person from ${agent.company_name} phones the lead back. You never call anyone yourself.
Callbacks can be ${daysText(bh.days)}, ${bh.start} to ${bh.end} (${tz}).
Right now it is ${fmtLocal(now, tz)}. The earliest callback is ${fmtLocal(new Date(now.getTime() + 30 * 60000), tz)}.
${lead.callback_at ? `A callback is ALREADY BOOKED for ${fmtLocal(new Date(lead.callback_at), tz)}. Only change it if they ask to.` : "No callback is booked yet."}
Dates for the next two weeks:
${calendarHint(tz)}`;
}

function smsSystemPrompt(ctx: Ctx): string {
  const { agent } = ctx;
  return `You are ${agent.bot_name}, texting on behalf of ${agent.company_name}. This person enquired a while ago but never went ahead. We texted them to check they are still interested. Your job is to re-engage them, qualify them, and book a callback with the team.

## How the conversation goes
1. Confirm interest. If it's the wrong person, apologise briefly and stop. If they're not interested, thank them warmly and stop. Never push or argue.
2. If they're interested, ask the qualifying questions one at a time, naturally, in your own words.
3. Once "Still to ask" is empty, book a callback with a team member from ${agent.company_name}. Offer one or two specific times.
   When they pick one of the times you offered, even loosely ("today works", "the first one", "tomorrow's good", "yes 6:30"), that IS their agreement: set "callback" to that time straight away and confirm the day and time in your reply. Never ask them to confirm a time they've already chosen.
   If what they said could mean more than one of the times you offered, ask which one.
4. Once booked, keep any further replies short and helpful.

## Style
${agent.tone}
Write like a real person texting: short (under 300 characters), one question at a time, no lists, no emojis unless they use them first. Australian English. Use their first name occasionally, not every message. ${NO_DASH_RULE}

## Rules
- If asked whether you're a bot or a real person, be honest: you're an AI assistant for ${agent.company_name}, and a real person from the team will call them.
- Never make up prices, discounts, timeframes, guarantees or anything else not given here. If they ask something you can't answer, say the team will cover it on the callback.
- Never give financial, legal or medical advice.
- If they ask you to stop messaging them, set intent to "opt_out", confirm they won't hear from you again, and stop.
- If they're rude or upset, stay polite and calm.

${factSheet(ctx)}

## Your output
- reply: the next text to send, or "" if nothing needs saying (for example after they say "thanks" to a goodbye).
- lead_interested: true if the lead has shown ANY interest so far, including a plain "yes", "yep" or "that's me" to our first text, answering a qualifying question, asking about price or next steps, or agreeing to a call. False only if they have said no, wrong person, stop, or have not engaged yet.
- callback: set it as soon as they've picked or agreed a time (see step 3), including in the same turn they pick it. local_time is "YYYY-MM-DDTHH:MM" in the business's timezone, and must be inside the callback hours. Otherwise null.
- qualification: answers learned from their LATEST messages, keyed by the question keys above. Values are short.
- summary: 1-2 sentences on where things stand, for the business owner.
- next_action: what the business should do next, in a few words.`;
}

function voiceInstructions(ctx: Ctx): string {
  const { agent, lead } = ctx;
  return `You are ${agent.bot_name}, an AI assistant answering the phone for ${agent.company_name}. ${leadName(lead)} is calling back the number that texted them about their enquiry. Your job is to confirm their interest, ask the qualifying questions and book a callback with a team member.

When the call connects, speak first: greet them by first name, say you're ${agent.bot_name} from ${agent.company_name}, and thank them for calling back. Then ask whether they're still looking into ${lead.service || agent.service}.

## Style
${agent.tone}
You're on the phone: short sentences, one question at a time, natural and warm. Australian English. ${NO_DASH_RULE} Let them finish talking. Say times the way people say them ("Thursday at 2:30").

## Tools
- save_answer: whenever they answer a qualifying question.
- book_callback: once they agree to a specific time. If it fails, offer another time.
- set_outcome: if they're not interested, the wrong person, disqualified, or want no further contact.
- end_call: only after you've said goodbye.

## Rules
- If asked, be honest that you're an AI assistant. A real person from the team will call them back.
- Never make up prices, discounts, timeframes or guarantees. Never give financial, legal or medical advice.
- Things you can't answer are for the team on the callback.

${factSheet(ctx)}`;
}

function chatHistory(messages: Row[]): Row[] {
  return messages.filter((m) => m.channel !== "note" && m.author !== "system").map((m) => {
    const tag = m.channel === "voice" ? "[on the phone] " : "";
    if (m.author === "lead") return { role: "user", content: tag + m.body };
    return { role: "assistant", content: (m.author === "human" ? "[sent by a team member] " : "") + tag + m.body };
  });
}

// ---- Structured output -------------------------------------------------------

const QUAL_ITEMS = {
  type: "array",
  items: {
    type: "object", additionalProperties: false, required: ["key", "value"],
    properties: { key: { type: "string" }, value: { type: "string" } },
  },
};

const TURN_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["reply", "intent", "lead_interested", "sentiment", "qualification", "disqualified", "disqualify_reason", "callback", "summary", "next_action"],
  properties: {
    reply: { type: "string" },
    lead_interested: { type: "boolean" },
    intent: { type: "string", enum: ["positive", "question", "booking", "not_interested", "wrong_person", "opt_out", "unclear", "other"] },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    qualification: QUAL_ITEMS,
    disqualified: { type: "boolean" },
    disqualify_reason: { type: ["string", "null"] },
    callback: {
      anyOf: [
        {
          type: "object", additionalProperties: false, required: ["local_time", "notes"],
          properties: { local_time: { type: "string" }, notes: { type: "string" } },
        },
        { type: "null" },
      ],
    },
    summary: { type: "string" },
    next_action: { type: "string" },
  },
};

const INSIGHTS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["intent", "sentiment", "qualification", "summary", "next_action"],
  properties: {
    intent: { type: "string", enum: ["positive", "question", "booking", "not_interested", "wrong_person", "opt_out", "unclear", "other"] },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    qualification: QUAL_ITEMS,
    summary: { type: "string" },
    next_action: { type: "string" },
  },
};

// ---- Lead state --------------------------------------------------------------

const STAGE: Record<string, number> = { new: 0, queued: 0, sending: 0, failed: 0, contacted: 1, replied: 2, engaged: 3, qualified: 4, booked: 5 };
const CLOSED = ["opted_out", "wrong_person"];

async function addEvent(lead: Row, type: string, data: Row = {}) {
  await db.from("lead_events").insert({ client_id: lead.client_id, lead_id: lead.id, type, data });
}

function mergeQualification(lead: Row, items: { key: string; value: string }[]): Row {
  const q = { ...(lead.qualification || {}) };
  for (const { key, value } of items) {
    if (key && String(value || "").trim()) q[key] = String(value).trim().slice(0, 300);
  }
  return q;
}

function allRequiredAnswered(agent: Agent, q: Row): boolean {
  const req = agent.qualification_questions.filter((x) => x.required);
  return req.length > 0 && req.every((x) => String(q[x.key] || "").trim());
}

// Stores a message and, unless it is a demo lead, sends it by SMS.
async function deliver(lead: Row, body: string, author: "ai" | "human" | "system", opts: { ignoreOptOut?: boolean } = {}) {
  body = noEmDash(body);
  const now = new Date().toISOString();
  if (lead.is_demo) {
    await db.from("messages").insert({
      client_id: lead.client_id, lead_id: lead.id, direction: "outbound", channel: "demo", author, body, status: "delivered",
    });
  } else {
    if (!opts.ignoreOptOut) {
      const { data: opted } = await db.from("opt_outs").select("phone").eq("phone", lead.phone).maybeSingle();
      if (opted) throw new HttpError(409, "This number has opted out");
    }
    const { data: msg } = await db.from("messages").insert({
      client_id: lead.client_id, lead_id: lead.id, direction: "outbound", channel: "sms", author, body, status: "queued",
    }).select("id").single();
    try {
      const sid = await twilioSend(lead.phone, body);
      await db.from("messages").update({ twilio_sid: sid, status: "sent" }).eq("id", msg!.id);
    } catch (e) {
      await db.from("messages").update({ status: "failed", error: (e as Error).message }).eq("id", msg!.id);
      throw e;
    }
  }
  await db.from("leads").update({ last_outbound_at: now, last_message_at: now }).eq("id", lead.id);
}

async function optOut(lead: Row, how: string) {
  await db.from("opt_outs").upsert(
    { phone: lead.phone, client_id: lead.client_id, lead_id: lead.id, reason: how },
    { onConflict: "phone" },
  );
  await db.from("leads").update({ status: "opted_out", ai_enabled: false, next_action: "None: opted out" }).eq("id", lead.id);
  await addEvent(lead, "opted_out", { how });
}

// Checks a proposed callback against business hours and other bookings.
async function checkCallback(ctx: Ctx, local: string): Promise<{ ok: true; at: Date } | { ok: false; reason: string }> {
  const tz = ctx.client.timezone || "Australia/Sydney";
  const at = localToUtc(local, tz);
  if (!at) return { ok: false, reason: "the time was not in YYYY-MM-DDTHH:MM format" };
  const now = Date.now();
  if (at.getTime() < now + 25 * 60000) return { ok: false, reason: "it is too soon or already in the past" };
  if (at.getTime() > now + 21 * 86400000) return { ok: false, reason: "it is more than three weeks away" };
  const bh: Window = ctx.client.business_hours || { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  if (!inWindow(at, tz, bh)) return { ok: false, reason: `it is outside callback hours (${daysText(bh.days)}, ${bh.start}-${bh.end})` };
  if (!ctx.lead.is_demo) {
    const { data: clash } = await db.from("leads").select("id")
      .eq("client_id", ctx.lead.client_id).neq("id", ctx.lead.id)
      .gte("callback_at", new Date(at.getTime() - 15 * 60000).toISOString())
      .lte("callback_at", new Date(at.getTime() + 15 * 60000).toISOString())
      .limit(1);
    if (clash?.length) return { ok: false, reason: "another callback is already booked within 15 minutes of that time" };
  }
  return { ok: true, at };
}

// Anchor 1: the first time a lead shows real interest - a positive reply,
// calling the number back, answering the qualifying questions or agreeing a
// callback. A "no", STOP or "wrong number" is a reply but not this.
async function markInterested(lead: Row, channel: string, why: string) {
  if (lead.interested_at) return;
  const now = new Date().toISOString();
  // Conditional, so two signals at once still log the anchor only once.
  const { data } = await db.from("leads").update({ interested_at: now })
    .eq("id", lead.id).is("interested_at", null).select("id");
  lead.interested_at = now;
  if (data?.length) await addEvent(lead, "lead_interested", { channel, why });
}

// Anchor 2.
async function bookCallback(ctx: Ctx, at: Date, notes: string, source: "sms" | "voice" | "demo" | "manual") {
  const { lead, client } = ctx;
  const tz = client.timezone || "Australia/Sydney";
  const rescheduled = !!lead.callback_at;
  await db.from("leads").update({
    status: "booked", callback_at: at.toISOString(), callback_notes: notes || null,
    booked_at: lead.booked_at || new Date().toISOString(),
  }).eq("id", lead.id);
  await addEvent(lead, "callback_booked", { at: at.toISOString(), local: fmtLocal(at, tz), notes, source, rescheduled });
  lead.callback_at = at.toISOString();
  lead.status = "booked";
  await markInterested(lead, source, "agreed a callback");
  if (source !== "manual") background(notifyBooking(ctx, at, notes, rescheduled));
}

async function notifyBooking(ctx: Ctx, at: Date, notes: string, rescheduled: boolean) {
  const { lead, client, agent } = ctx;
  if (lead.is_demo) return;
  const when = fmtLocal(at, client.timezone || "Australia/Sydney");
  const what = lead.service || agent.service;
  const text = `${rescheduled ? "Callback moved" : "New callback booked"}: ${leadName(lead)} (${lead.phone}) - ${when}. Re: ${what}.` +
    (notes ? ` Notes: ${notes}` : "") + (lead.summary ? ` Summary: ${lead.summary}` : "");
  const phone = normalisePhone(client.notify_phone);
  if (phone) await twilioSend(phone, text.slice(0, 600)).catch((e) => console.error("notify sms:", e));

  const resend = env("RESEND_API_KEY"), from = env("NOTIFY_FROM_EMAIL");
  if (client.notify_email && resend && from) {
    const q = Object.entries(lead.qualification || {}).map(([k, v]) => `<li><b>${escapeXml(k)}</b>: ${escapeXml(String(v))}</li>`).join("");
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
      body: JSON.stringify(cleanDeep({
        from, to: String(client.notify_email).split(",").map((s) => s.trim()).filter(Boolean),
        subject: `${rescheduled ? "Callback moved" : "Callback booked"}: ${leadName(lead)} - ${when}`,
        html: `<p><b>${escapeXml(leadName(lead))}</b> (${escapeXml(lead.phone)}) would like a call back <b>${escapeXml(when)}</b>.</p>
<p>Enquiry: ${escapeXml(what)}</p>${notes ? `<p>Notes: ${escapeXml(notes)}</p>` : ""}
${lead.summary ? `<p>Summary: ${escapeXml(lead.summary)}</p>` : ""}${q ? `<ul>${q}</ul>` : ""}
${env("APP_URL") ? `<p><a href="${escapeXml(env("APP_URL"))}">Open the conversation</a></p>` : ""}`,
      })),
    }).catch((e) => console.error("notify email:", e));
  }
}

// ---- Handraiser ----------------------------------------------------------------

function hashIndex(id: string, n: number): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return n ? h % n : 0;
}

function fill(t: string, vars: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)).replace(/\s+/g, " ").trim();
}

async function buildHandraiser(lead: Row, agent: Agent): Promise<{ text: string; variant: number }> {
  const first = String(lead.first_name || "").trim();
  let templates = agent.handraiser_templates.length
    ? agent.handraiser_templates
    : ["Hi {first_name}, it's {bot_name} from {company}. Is this the same {first_name} who was looking into {service} recently?"];
  // A template built around their name reads badly without one.
  let variant = hashIndex(lead.id, templates.length);
  if (!first) {
    templates = ["Hi, it's {bot_name} from {company}. You enquired about {service} with us a little while ago - are you still looking?"];
    variant = -1;
  }
  const vars = {
    first_name: first, lead_name: first, bot_name: agent.bot_name, company: agent.company_name,
    company_name: agent.company_name, service: lead.service || agent.service,
  };
  let text = fill(templates[Math.max(0, variant)], vars);

  if (agent.handraiser_mode === "ai") {
    try {
      const r = await openaiJSON<{ sms: string }>([
        {
          role: "system",
          content: "Rewrite this SMS so it reads naturally, as if a real person typed it. Keep the meaning, the person's first name, the sender's name and the business name. Under 220 characters. No emojis, no links, no prices, no em dashes or en dashes. Australian English. Return JSON {\"sms\": \"...\"}.",
        },
        { role: "user", content: text },
      ], "handraiser", {
        type: "object", additionalProperties: false, required: ["sms"], properties: { sms: { type: "string" } },
      });
      if (r.sms?.trim()) text = r.sms.trim();
    } catch (e) {
      console.error("handraiser rewrite failed, using the template:", e);
    }
  }
  if (agent.opt_out_text && !/\bstop\b/i.test(text)) text += ` ${agent.opt_out_text}`;
  return { text, variant };
}

async function sendHandraiser(lead: Row, campaign: Row, client: Row) {
  try {
    if (!lead.is_demo) {
      const { data: opted } = await db.from("opt_outs").select("phone").eq("phone", lead.phone).maybeSingle();
      if (opted) {
        await db.from("leads").update({ status: "opted_out", ai_enabled: false }).eq("id", lead.id);
        return;
      }
    }
    const agent = agentConfig(campaign, client);
    const { text, variant } = await buildHandraiser(lead, agent);
    await deliver(lead, text, "ai", { ignoreOptOut: true });
    const now = new Date().toISOString();
    await db.from("leads").update({
      status: "contacted", contacted_at: now, handraiser_variant: variant, error: null,
    }).eq("id", lead.id);
    await addEvent(lead, "handraiser_sent", { variant, text });
  } catch (e) {
    console.error(`handraiser to ${lead.id} failed:`, e);
    await db.from("leads").update({ status: "failed", error: (e as Error).message.slice(0, 300) }).eq("id", lead.id);
  }
}

// ---- Inbound -------------------------------------------------------------------

// A clear "yes" ticks Anchor 1 the moment it arrives, without waiting on the
// agent (or its reply delay). Anything with a hint of "no" is left to the
// agent to judge.
const CLEAR_YES = /^(yes|yeah|yea|yep|yup|ya|y|sure|correct|definitely|absolutely|of course|still keen|still interested|keen|interested|that'?s me|thats me|it is|it'?s me|this is (him|her|me)|i am|yes please|ok(ay)?)\b/i;
const HAS_NO = /\b(no|nah|nope|not|n't|never|stop|wrong|don'?t|dont|unsubscribe|remove|cancel|longer|already)\b/i;
const isClearYes = (body: string) => {
  const t = body.trim().toLowerCase().replace(/[!.,]+/g, " ").trim();
  return t.length <= 120 && CLEAR_YES.test(t) && !HAS_NO.test(t);
};

const STOP_WORDS = /^(stop|stop all|stopall|unsubscribe|unsub|cancel|end|quit|opt ?out|remove me|stop texting me|stop messaging me)[\s.!]*$/i;

// Runs for every message from a lead, by SMS or in a demo.
async function onInbound(lead: Row, body: string, messageId: string) {
  const now = new Date().toISOString();

  if (STOP_WORDS.test(body.trim())) {
    await db.from("leads").update({ last_inbound_at: now, last_message_at: now }).eq("id", lead.id);
    await optOut(lead, "keyword");
    const ctx = await loadCtx(lead.id);
    await deliver(lead, `You've been unsubscribed and won't hear from ${ctx?.agent.company_name || "us"} again.`, "system", { ignoreOptOut: true })
      .catch((e) => console.error("opt-out confirmation:", e));
    return;
  }

  const patch: Row = { last_inbound_at: now, last_message_at: now };
  // Every reply is recorded (reply rate, routing, unread). It is not the
  // anchor: that waits for the agent to read it as interest.
  if (!lead.replied_at) {
    patch.replied_at = now;
    if ((STAGE[lead.status] ?? 9) < STAGE.replied) patch.status = "replied";
    await addEvent(lead, "lead_replied", { channel: lead.is_demo ? "demo" : "sms", text: body.slice(0, 300) });
  }
  if (!lead.interested_at && isClearYes(body)) await markInterested(lead, lead.is_demo ? "demo" : "sms", "positive reply");

  const willReply = lead.ai_enabled && !CLOSED.includes(lead.status);
  const wait = replyDelay(!!lead.is_demo);
  // Shown in the app as "replies in about 40s", so a person watching can
  // pause the AI first if they'd rather answer themselves.
  if (willReply) patch.reply_due_at = new Date(Date.now() + wait).toISOString();
  await db.from("leads").update(patch).eq("id", lead.id);

  if (willReply) background(debouncedTurn(lead.id, messageId, wait));
}

async function debouncedTurn(leadId: string, messageId: string, wait: number) {
  await sleep(wait);
  const { data: latest } = await db.from("messages").select("id").eq("lead_id", leadId).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  // A later message arrived: its own run will answer everything at once.
  if (latest && latest.id !== messageId) return;
  await runAgentTurn(leadId);
}

async function runAgentTurn(leadId: string) {
  const ctx = await loadCtx(leadId);
  if (!ctx) return;
  const { lead, agent } = ctx;
  if (!lead.ai_enabled || CLOSED.includes(lead.status)) {
    // Paused (or a team member stepped in) while it was waiting to reply.
    if (lead.reply_due_at) await db.from("leads").update({ reply_due_at: null }).eq("id", leadId);
    return;
  }

  await db.from("leads").update({ ai_state: "thinking", reply_due_at: null }).eq("id", leadId);
  try {
    const history = chatHistory(ctx.messages);
    let feedback = "";
    // deno-lint-ignore no-explicit-any
    let turn: any = null;
    let booking: Date | null = null;

    // The model proposes a callback; the server decides whether it is valid.
    // If not, the model is told why and writes a new reply, so it never
    // confirms a time nobody can make.
    for (let attempt = 0; attempt < 3; attempt++) {
      const msgs: Row[] = [{ role: "system", content: smsSystemPrompt(ctx) }, ...history];
      if (feedback) msgs.push({ role: "system", content: feedback });
      turn = await openaiJSON(msgs, "agent_turn", TURN_SCHEMA);
      if (!turn.callback) break;
      const check = await checkCallback(ctx, turn.callback.local_time);
      if (check.ok) { booking = check.at; break; }
      feedback = `You proposed a callback at ${turn.callback.local_time}, but it can't be booked: ${check.reason}. Don't confirm it. Write a new reply offering a time that works, and set callback to null.`;
      turn.callback = null;
      if (attempt === 2) {
        turn.reply = "Let me check that time with the team and come back to you shortly.";
        turn.next_action = "Agree a callback time with the lead (the AI couldn't fit their request into callback hours)";
      }
    }

    const q = mergeQualification(lead, turn.qualification || []);
    const patch: Row = {
      intent: turn.intent, sentiment: turn.sentiment, qualification: q,
      summary: turn.summary || lead.summary, next_action: turn.next_action || lead.next_action,
    };
    let status = lead.status;
    if (turn.intent === "wrong_person") { status = "wrong_person"; patch.ai_enabled = false; }
    else if (turn.disqualified) status = "disqualified";
    else if (turn.intent === "not_interested") status = "not_interested";
    else if (!booking && allRequiredAnswered(agent, q) && (STAGE[status] ?? 9) < STAGE.qualified) status = "qualified";
    // A question alone ("who is this?") keeps the lead where it was.
    else if (["positive", "booking"].includes(turn.intent) &&
      ((STAGE[status] ?? 9) < STAGE.engaged || ["not_interested", "disqualified"].includes(status))) status = "engaged";
    if (status !== lead.status) {
      patch.status = status;
      await addEvent(lead, "status_changed", { from: lead.status, to: status, reason: turn.disqualify_reason || turn.intent });
    }
    await db.from("leads").update(patch).eq("id", leadId);
    Object.assign(lead, patch);

    if (turn.intent === "opt_out") await optOut(lead, "asked");
    else if (turn.lead_interested || ["positive", "booking"].includes(turn.intent) || status === "qualified") {
      await markInterested(lead, lead.is_demo ? "demo" : "sms", status === "qualified" && !turn.lead_interested ? "answered the qualifying questions" : "positive reply");
    }
    if (booking) await bookCallback(ctx, booking, turn.callback?.notes || "", lead.is_demo ? "demo" : "sms");

    const reply = String(turn.reply || "").trim();
    if (reply) await deliver(lead, reply, "ai", { ignoreOptOut: turn.intent === "opt_out" });
  } catch (e) {
    console.error(`agent turn for ${leadId} failed:`, e);
    await addEvent(lead, "ai_error", { message: (e as Error).message.slice(0, 300) });
  } finally {
    await db.from("leads").update({ ai_state: "idle" }).eq("id", leadId).eq("ai_state", "thinking");
  }
}

// Re-reads the whole conversation (including calls) and refreshes the
// insights panel. Used after a call and on demand.
async function refreshInsights(leadId: string): Promise<Row | null> {
  const ctx = await loadCtx(leadId);
  if (!ctx || !ctx.messages.length) return null;
  const transcript = ctx.messages.filter((m) => m.channel !== "note")
    .map((m) => `${m.author === "lead" ? "Lead" : m.author === "human" ? "Team" : "Agent"}${m.channel === "voice" ? " (call)" : ""}: ${m.body}`)
    .join("\n");
  const r = await openaiJSON<Row>([
    {
      role: "system",
      content: `You review a sales conversation between ${ctx.agent.company_name}'s assistant and a lead, and report where it stands for the business owner.\n\n${factSheet(ctx)}\n\nReturn: intent of the lead overall, sentiment, any qualifying answers they have given (keyed by the question keys), a 1-2 sentence summary, and the next action for the business in a few words. ${NO_DASH_RULE}`,
    },
    { role: "user", content: transcript.slice(-24000) },
  ], "insights", INSIGHTS_SCHEMA);
  const patch = {
    intent: r.intent, sentiment: r.sentiment, qualification: mergeQualification(ctx.lead, r.qualification || []),
    summary: r.summary, next_action: r.next_action,
  };
  await db.from("leads").update(patch).eq("id", leadId);
  return patch;
}

// =============================================================================
// Routes: Twilio
// =============================================================================

async function readTwilio(req: Request, path: string): Promise<Record<string, string>> {
  const params = Object.fromEntries(new URLSearchParams(await req.text()));
  if (!(await twilioSignatureOk(req, params, `${FN_BASE}${path}`))) throw new HttpError(403, "Bad Twilio signature");
  return params;
}

async function routePhone(from: string): Promise<Row | null> {
  const { data: leadId, error } = await db.rpc("route_inbound_phone", { p_phones: phoneVariants(from) });
  if (error) throw error;
  if (!leadId) return null;
  const { data: lead } = await db.from("leads").select("*").eq("id", leadId).single();
  return lead;
}

async function handleTwilioSms(req: Request): Promise<Response> {
  const p = await readTwilio(req, "/twilio/sms");
  const from = normalisePhone(p.From);
  const body = String(p.Body || "").trim();
  if (!from || !body) return twiml("");

  // Only numbers we have texted get an answer. Anything else is ignored.
  const lead = await routePhone(from);
  if (!lead) {
    console.log(`Inbound SMS from ${from} matched no lead (or matched several with no evidence) - ignored.`);
    return twiml("");
  }

  const { data: msg, error } = await db.from("messages").insert({
    client_id: lead.client_id, lead_id: lead.id, direction: "inbound", channel: "sms", author: "lead",
    body: body.slice(0, 2000), twilio_sid: p.MessageSid || null, status: "received",
  }).select("id").single();
  if (error) {
    if (error.code === "23505") return twiml(""); // Twilio redelivered one we already have
    throw error;
  }
  await onInbound(lead, body, msg!.id);
  return twiml("");
}

async function handleTwilioStatus(req: Request): Promise<Response> {
  const p = await readTwilio(req, "/twilio/status");
  if (!p.MessageSid) return twiml("");
  const status = p.MessageStatus || p.SmsStatus || "";
  const error = p.ErrorCode ? `Twilio error ${p.ErrorCode}` : null;
  const { data: msg } = await db.from("messages").update({ status, ...(error ? { error } : {}) })
    .eq("twilio_sid", p.MessageSid).select("lead_id").maybeSingle();
  if (msg && (status === "failed" || status === "undelivered")) {
    await db.from("leads").update({ error: error || `SMS ${status}` }).eq("id", msg.lead_id);
    await db.from("leads").update({ status: "failed" }).eq("id", msg.lead_id).eq("status", "contacted");
  }
  return twiml("");
}

// A call came in on the shared number. Known lead: hand the call to the
// OpenAI Realtime API over SIP, carrying a signed reference to the lead.
// Anyone else: reject.
async function handleTwilioVoice(req: Request): Promise<Response> {
  const p = await readTwilio(req, "/twilio/voice");
  const from = normalisePhone(p.From);
  const lead = from ? await routePhone(from) : null;
  const project = env("OPENAI_PROJECT_ID"), sipSecret = env("SIP_HEADER_SECRET");
  if (!lead) return twiml("<Reject/>");
  if (!project || !sipSecret) {
    console.error("Calls need OPENAI_PROJECT_ID and SIP_HEADER_SECRET");
    return twiml("<Reject/>");
  }

  const { data: call } = await db.from("calls").insert({
    client_id: lead.client_id, lead_id: lead.id, twilio_call_sid: p.CallSid || null, from_number: from, status: "ringing",
  }).select("id").single();
  const sig = hex(await hmac("SHA-256", sipSecret, `${lead.id}.${call!.id}`));
  const uri = `sip:${project}@sip.api.openai.com;transport=tls?X-Lead-Id=${lead.id}&X-Call-Ref=${call!.id}&X-Rx-Sig=${sig}`;
  return twiml(`<Dial answerOnBridge="true" timeout="25"><Sip>${escapeXml(uri)}</Sip></Dial>`);
}

// =============================================================================
// Routes: OpenAI Realtime (inbound calls)
// =============================================================================

const VOICE_TOOLS = [
  {
    type: "function", name: "book_callback",
    description: "Book a callback from a team member once the caller agrees to a specific time.",
    parameters: {
      type: "object", required: ["local_time"],
      properties: {
        local_time: { type: "string", description: "YYYY-MM-DDTHH:MM in the business's timezone" },
        notes: { type: "string", description: "Anything the team should know before calling" },
      },
    },
  },
  {
    type: "function", name: "save_answer",
    description: "Save the caller's answer to one of the qualifying questions.",
    parameters: {
      type: "object", required: ["key", "value"],
      properties: { key: { type: "string" }, value: { type: "string" } },
    },
  },
  {
    type: "function", name: "set_outcome",
    description: "Record that the caller is not interested, is the wrong person, is disqualified, or wants no further contact.",
    parameters: {
      type: "object", required: ["outcome"],
      properties: {
        outcome: { type: "string", enum: ["not_interested", "wrong_person", "disqualified", "opt_out"] },
        reason: { type: "string" },
      },
    },
  },
  {
    type: "function", name: "end_call",
    description: "Hang up. Only after saying goodbye.",
    parameters: { type: "object", properties: {} },
  },
];

async function handleOpenAiCall(req: Request): Promise<Response> {
  const raw = await req.text();
  if (!(await openaiWebhookOk(req.headers, raw))) return json({ error: "Bad signature" }, 401);
  const ev = JSON.parse(raw);
  if (ev.type !== "realtime.call.incoming") return json({ ok: true });

  const callId: string = ev.data?.call_id;
  const headers = arr<Row>(ev.data?.sip_headers);
  const h = (n: string) => headers.find((x) => String(x.name).toLowerCase() === n.toLowerCase())?.value as string | undefined;
  const leadId = h("X-Lead-Id") || "", callRef = h("X-Call-Ref") || "", sig = h("X-Rx-Sig") || "";
  const expected = hex(await hmac("SHA-256", env("SIP_HEADER_SECRET"), `${leadId}.${callRef}`));

  // Only calls our own TwiML put through, for the lead it named.
  if (!leadId || !callRef || !safeEqual(sig, expected)) {
    console.warn("Realtime call without a valid lead signature - rejecting");
    await openaiPost(`/realtime/calls/${callId}/reject`, { status_code: 603 });
    return json({ ok: true });
  }
  const ctx = await loadCtx(leadId);
  if (!ctx) {
    await openaiPost(`/realtime/calls/${callId}/reject`, { status_code: 603 });
    return json({ ok: true });
  }

  const r = await openaiPost(`/realtime/calls/${callId}/accept`, {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: voiceInstructions(ctx),
    audio: { output: { voice: ctx.agent.voice || "marin" } },
  });
  if (!r.ok) {
    console.error("accept failed:", r.status, await r.text());
    await db.from("calls").update({ status: "failed", ended_at: new Date().toISOString() }).eq("id", callRef);
    return json({ ok: true });
  }

  const now = new Date().toISOString();
  await db.from("calls").update({ openai_call_id: callId, status: "in_progress", answered_at: now }).eq("id", callRef);
  const patch: Row = { ai_state: "on_call", last_inbound_at: now, last_message_at: now };
  if (!ctx.lead.replied_at) {
    patch.replied_at = now;
    if ((STAGE[ctx.lead.status] ?? 9) < STAGE.replied) patch.status = "replied";
    await addEvent(ctx.lead, "lead_replied", { channel: "voice" });
  }
  await db.from("leads").update(patch).eq("id", leadId);
  Object.assign(ctx.lead, patch);
  await addEvent(ctx.lead, "call_started", { call_id: callRef });
  // Calling the number back is about as clear a "yes" as a lead gives.
  await markInterested(ctx.lead, "voice", "called back");

  background(runSideband(ctx, callId, callRef));
  return json({ ok: true });
}

// Listens to the live call: saves the transcript as it goes and carries out
// the agent's tool calls (booking the callback, saving answers, hanging up).
function runSideband(ctx: Ctx, callId: string, callRef: string): Promise<void> {
  return new Promise((resolve) => {
    const { lead } = ctx;
    let finished = false;
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
      ["realtime", `openai-insecure-api-key.${env("OPENAI_API_KEY")}`],
    );
    const stopTimer = setTimeout(() => ws.close(), SIDEBAND_MAX_MS);
    const send = (o: Row) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

    const line = (direction: "inbound" | "outbound", body: string) => {
      const text = noEmDash(String(body || "")).trim();
      if (!text) return Promise.resolve();
      return db.from("messages").insert({
        client_id: lead.client_id, lead_id: lead.id, direction, channel: "voice",
        author: direction === "inbound" ? "lead" : "ai", body: text.slice(0, 4000), call_id: callRef,
      }).then(() => db.from("leads").update({ last_message_at: new Date().toISOString() }).eq("id", lead.id));
    };

    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(stopTimer);
      try {
        await db.from("calls").update({ status: "completed", ended_at: new Date().toISOString() }).eq("id", callRef);
        await db.from("leads").update({ ai_state: "idle" }).eq("id", lead.id).eq("ai_state", "on_call");
        await addEvent(lead, "call_ended", { call_id: callRef });
        const insights = await refreshInsights(lead.id);
        if (insights?.summary) await db.from("calls").update({ summary: insights.summary }).eq("id", callRef);
      } catch (e) {
        console.error("call wrap-up:", e);
      }
      resolve();
    };

    const runTool = async (name: string, args: Row): Promise<Row> => {
      const fresh = await loadCtx(lead.id);
      if (!fresh) return { ok: false, error: "lead not found" };
      if (name === "book_callback") {
        const check = await checkCallback(fresh, String(args.local_time || ""));
        if (!check.ok) return { ok: false, reason: check.reason };
        await bookCallback(fresh, check.at, String(args.notes || ""), "voice");
        return { ok: true, booked_for: fmtLocal(check.at, fresh.client.timezone || "Australia/Sydney") };
      }
      if (name === "save_answer") {
        await db.from("leads").update({
          qualification: mergeQualification(fresh.lead, [{ key: String(args.key), value: String(args.value) }]),
        }).eq("id", lead.id);
        return { ok: true };
      }
      if (name === "set_outcome") {
        const outcome = String(args.outcome);
        if (outcome === "opt_out") await optOut(fresh.lead, "asked on a call");
        else {
          await db.from("leads").update({ status: outcome, ...(outcome === "wrong_person" ? { ai_enabled: false } : {}) }).eq("id", lead.id);
          await addEvent(fresh.lead, "status_changed", { from: fresh.lead.status, to: outcome, reason: args.reason || "call" });
        }
        return { ok: true };
      }
      return { ok: false, error: `unknown tool ${name}` };
    };

    ws.onopen = () => {
      send({
        type: "session.update",
        session: {
          type: "realtime",
          tools: VOICE_TOOLS,
          tool_choice: "auto",
          audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } },
        },
      });
      // The caller is waiting in silence: the agent speaks first.
      send({ type: "response.create" });
    };

    ws.onmessage = async (e) => {
      let ev: Row;
      try { ev = JSON.parse(String(e.data)); } catch { return; }
      try {
        switch (ev.type) {
          case "conversation.item.input_audio_transcription.completed":
            await line("inbound", ev.transcript);
            break;
          case "response.output_audio_transcript.done":
          case "response.audio_transcript.done":
            await line("outbound", ev.transcript);
            break;
          case "response.function_call_arguments.done": {
            if (ev.name === "end_call") {
              // Let the goodbye finish playing first.
              await sleep(3500);
              await openaiPost(`/realtime/calls/${callId}/hangup`, {});
              ws.close();
              break;
            }
            let args: Row = {};
            try { args = JSON.parse(ev.arguments || "{}"); } catch { /* empty */ }
            const output = await runTool(ev.name, args);
            send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(output) } });
            send({ type: "response.create" });
            break;
          }
          case "error":
            console.error("realtime error:", JSON.stringify(ev.error));
            break;
        }
      } catch (err) {
        console.error(`sideband ${ev.type}:`, err);
      }
    };

    ws.onerror = (e) => console.error("sideband socket error:", (e as ErrorEvent).message || e);
    ws.onclose = () => { finish(); };
  });
}

// =============================================================================
// Route: send queue (pg_cron, every minute)
// =============================================================================

async function handleCron(req: Request): Promise<Response> {
  const secret = env("CRON_SECRET");
  if (!secret || !safeEqual(req.headers.get("x-cron-secret") || "", secret)) throw new HttpError(401, "Unauthorised");

  const cap = Number(env("MAX_SENDS_PER_MINUTE", "30"));
  let sent = 0;
  const { data: campaigns } = await db.from("campaigns").select("*, client:clients(*)").eq("status", "active");
  for (const c of campaigns || []) {
    const client = c.client as Row;
    if (!client || client.is_demo || !client.active) continue;
    if (!inWindow(new Date(), client.timezone || "Australia/Sydney", c.send_window)) continue;
    const take = Math.min(c.send_per_minute || 6, cap - sent);
    if (take <= 0) break;
    const { data: claimed, error } = await db.rpc("claim_queued_leads", { p_campaign: c.id, p_limit: take });
    if (error) { console.error("claim:", error); continue; }
    for (const lead of claimed || []) {
      await sendHandraiser(lead, c, client);
      sent++;
    }
  }
  return json({ sent });
}

// =============================================================================
// Route: the app
// =============================================================================

async function handleApi(req: Request): Promise<Response> {
  if (req.method !== "POST") throw new HttpError(405, "POST only");
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) throw new HttpError(401, "Please sign in again");
  const { data: profile } = await db.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) throw new HttpError(403, "No profile");
  const isAdmin = profile.role === "admin";
  const b = await req.json().catch(() => ({}));

  const adminOnly = () => { if (!isAdmin) throw new HttpError(403, "Admins only"); };
  // A lead the caller is allowed to touch. Client users only reach their own.
  const getLead = async (id: string): Promise<Row> => {
    const { data } = await db.from("leads").select("*").eq("id", id).maybeSingle();
    if (!data || (!isAdmin && data.client_id !== profile.client_id)) throw new HttpError(404, "Lead not found");
    return data;
  };
  const getCampaign = async (id: string): Promise<Row> => {
    const { data } = await db.from("campaigns").select("*, client:clients(*)").eq("id", id).maybeSingle();
    if (!data) throw new HttpError(404, "Campaign not found");
    return data;
  };

  switch (b.action) {
    // ---- Leads ----------------------------------------------------------
    case "import_leads": {
      adminOnly();
      const camp = await getCampaign(b.campaign_id);
      const rows = arr<Row>(b.rows);
      if (rows.length > 20000) throw new HttpError(400, "Upload at most 20,000 rows at a time");
      const seen = new Set<string>();
      let invalid = 0, dupes = 0;
      const out: Row[] = [];
      for (const r of rows) {
        const phone = normalisePhone(r.phone);
        if (!phone) { invalid++; continue; }
        if (seen.has(phone)) { dupes++; continue; }
        seen.add(phone);
        out.push({
          client_id: camp.client_id, campaign_id: camp.id, phone,
          first_name: clean(r.first_name, 80), last_name: clean(r.last_name, 80), email: clean(r.email, 200),
          service: clean(r.service, 200), enquired_at: parseDate(r.enquired_at), source: clean(r.source, 120),
          notes: clean(r.notes, 1000), extra: typeof r.extra === "object" && r.extra ? r.extra : {},
          // Every row carries every column: a bulk upsert sends the union of
          // keys, and a key missing from one row would arrive as null.
          status: camp.status === "active" ? "queued" : "new", ai_enabled: true, is_demo: !!camp.client?.is_demo,
        });
      }
      // People who have opted out are kept for the record but never queued.
      const opted = new Set<string>();
      for (let i = 0; i < out.length; i += 500) {
        const { data } = await db.from("opt_outs").select("phone").in("phone", out.slice(i, i + 500).map((r) => r.phone));
        (data || []).forEach((r) => opted.add(r.phone));
      }
      out.forEach((r) => { if (opted.has(r.phone)) { r.status = "opted_out"; r.ai_enabled = false; } });
      let inserted = 0;
      for (let i = 0; i < out.length; i += 500) {
        const { data, error } = await db.from("leads")
          .upsert(out.slice(i, i + 500), { onConflict: "client_id,phone", ignoreDuplicates: true }).select("id");
        if (error) throw error;
        inserted += data?.length || 0;
      }
      return json({ inserted, already_existed: out.length - inserted, invalid, duplicates_in_file: dupes, opted_out: opted.size });
    }

    case "send_message": {
      const lead = await getLead(b.lead_id);
      const body = String(b.body || "").trim();
      if (!body) throw new HttpError(400, "Message is empty");
      await deliver(lead, body.slice(0, 1200), "human");
      // A person has stepped in, so the AI stands back unless asked not to.
      if (b.pause_ai !== false && lead.ai_enabled) {
        await db.from("leads").update({ ai_enabled: false }).eq("id", lead.id);
        await addEvent(lead, "ai_paused", { by: profile.email, reason: "team member replied" });
      }
      return json({ ok: true });
    }

    case "set_ai": {
      const lead = await getLead(b.lead_id);
      const on = !!b.enabled;
      if (on && lead.status === "opted_out") throw new HttpError(409, "This lead has opted out");
      await db.from("leads").update({ ai_enabled: on }).eq("id", lead.id);
      await addEvent(lead, on ? "ai_resumed" : "ai_paused", { by: profile.email });
      return json({ ok: true });
    }

    case "set_status": {
      const lead = await getLead(b.lead_id);
      const allowed = ["engaged", "qualified", "not_interested", "wrong_person", "disqualified", "contacted"];
      if (!allowed.includes(b.status)) throw new HttpError(400, "That status can't be set by hand");
      await db.from("leads").update({ status: b.status }).eq("id", lead.id);
      await addEvent(lead, "status_changed", { from: lead.status, to: b.status, by: profile.email });
      if (b.status === "engaged" || b.status === "qualified") await markInterested(lead, "manual", `marked ${b.status} by ${profile.email}`);
      return json({ ok: true });
    }

    case "book_callback": {
      const lead = await getLead(b.lead_id);
      const ctx = (await loadCtx(lead.id))!;
      const at = localToUtc(String(b.local_time || ""), ctx.client.timezone || "Australia/Sydney");
      if (!at) throw new HttpError(400, "Pick a date and time");
      await bookCallback(ctx, at, String(b.notes || ""), "manual");
      return json({ ok: true });
    }

    case "clear_callback": {
      const lead = await getLead(b.lead_id);
      await db.from("leads").update({ callback_at: null, callback_notes: null, status: "engaged" }).eq("id", lead.id);
      await addEvent(lead, "callback_cleared", { by: profile.email });
      return json({ ok: true });
    }

    case "refresh_insights": {
      const lead = await getLead(b.lead_id);
      return json({ insights: await refreshInsights(lead.id) });
    }

    case "add_note": {
      const lead = await getLead(b.lead_id);
      const body = String(b.body || "").trim();
      if (!body) throw new HttpError(400, "Note is empty");
      await db.from("messages").insert({
        client_id: lead.client_id, lead_id: lead.id, direction: "outbound", channel: "note", author: "human",
        body: `${body.slice(0, 2000)}`, status: profile.email,
      });
      return json({ ok: true });
    }

    // ---- Campaigns --------------------------------------------------------
    case "campaign_launch": {
      adminOnly();
      const camp = await getCampaign(b.campaign_id);
      const a = agentConfig(camp, camp.client);
      if (!a.handraiser_templates.length) throw new HttpError(400, "Add at least one handraiser message first");
      if (camp.client?.is_demo) throw new HttpError(400, "Demo campaigns don't send");
      await db.from("campaigns").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", camp.id);
      const { data } = await db.from("leads").update({ status: "queued" })
        .eq("campaign_id", camp.id).eq("status", "new").select("id");
      return json({ queued: data?.length || 0 });
    }

    case "campaign_pause": {
      adminOnly();
      const camp = await getCampaign(b.campaign_id);
      await db.from("campaigns").update({ status: "paused", updated_at: new Date().toISOString() }).eq("id", camp.id);
      return json({ ok: true });
    }

    case "preview_handraiser": {
      adminOnly();
      const camp = await getCampaign(b.campaign_id);
      const sample = { id: crypto.randomUUID(), first_name: b.first_name || "Alex", service: b.service || null };
      return json(await buildHandraiser(sample, agentConfig(camp, camp.client)));
    }

    // ---- Users --------------------------------------------------------------
    case "invite_user": {
      adminOnly();
      const email = String(b.email || "").trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "Enter a valid email");
      const role = b.role === "admin" ? "admin" : "client";
      if (role === "client" && !b.client_id) throw new HttpError(400, "Pick the client this user belongs to");
      const meta = { full_name: String(b.full_name || "") };
      const res = b.password
        ? await db.auth.admin.createUser({ email, password: String(b.password), email_confirm: true, user_metadata: meta })
        : await db.auth.admin.inviteUserByEmail(email, { data: meta, redirectTo: env("APP_URL") || undefined });
      if (res.error) throw new HttpError(400, res.error.message);
      const id = res.data.user!.id;
      await db.from("profiles").upsert({
        id, email, full_name: meta.full_name, role, client_id: role === "client" ? b.client_id : null,
      });
      return json({ ok: true, user_id: id });
    }

    case "delete_user": {
      adminOnly();
      if (b.user_id === user.id) throw new HttpError(400, "You can't delete yourself");
      const { error } = await db.auth.admin.deleteUser(String(b.user_id));
      if (error) throw new HttpError(400, error.message);
      return json({ ok: true });
    }

    // ---- Do Not Contact list -------------------------------------------------
    // Numbers on it are never texted from the shared number, for any client.
    case "dnc_add": {
      adminOnly();
      const raw = arr<unknown>(b.phones);
      if (raw.length > 50000) throw new HttpError(400, "Add at most 50,000 numbers at a time");
      const phones = [...new Set(raw.map(normalisePhone).filter((p): p is string => !!p))];
      const invalid = raw.length - raw.map(normalisePhone).filter(Boolean).length;
      const clientId = b.client_id || null;
      const reason = b.reason === "import" ? "import" : "manual";
      const note = clean(b.note, 300);
      let added = 0, leadsStopped = 0;
      for (let i = 0; i < phones.length; i += 500) {
        const chunk = phones.slice(i, i + 500);
        const { data, error } = await db.from("opt_outs").upsert(
          chunk.map((phone) => ({ phone, client_id: clientId, reason, note, added_by: profile.email })),
          { onConflict: "phone", ignoreDuplicates: true },
        ).select("phone");
        if (error) throw error;
        added += data?.length || 0;
        // Stop every lead with that number, in every client: nothing queued
        // goes out and the AI won't answer them.
        const { data: stopped, error: le } = await db.from("leads")
          .update({ status: "opted_out", ai_enabled: false, reply_due_at: null, next_action: "None: on the do-not-contact list" })
          .in("phone", chunk).eq("is_demo", false).neq("status", "opted_out")
          .select("id, client_id");
        if (le) throw le;
        leadsStopped += stopped?.length || 0;
        if (stopped?.length) {
          await db.from("lead_events").insert(stopped.map((l) => ({
            client_id: l.client_id, lead_id: l.id, type: "opted_out",
            data: { how: reason === "import" ? "uploaded do-not-contact list" : "added to do-not-contact list", by: profile.email },
          })));
        }
      }
      return json({ added, already_listed: phones.length - added, invalid, leads_stopped: leadsStopped });
    }

    case "dnc_remove": {
      adminOnly();
      const phone = normalisePhone(b.phone);
      if (!phone) throw new HttpError(400, "That isn't a valid number");
      const { data: gone, error } = await db.from("opt_outs").delete().eq("phone", phone).select("phone");
      if (error) throw error;
      if (!gone?.length) throw new HttpError(404, "That number isn't on the list");
      // Their leads come back where they were, with the AI left OFF: someone
      // decides to turn it back on, per lead.
      const { data: leads } = await db.from("leads").select("id, client_id, replied_at, contacted_at")
        .eq("phone", phone).eq("status", "opted_out");
      for (const l of leads || []) {
        const status = l.replied_at ? "replied" : l.contacted_at ? "contacted" : "new";
        await db.from("leads").update({ status, next_action: "Back in contact: turn the AI on if wanted" }).eq("id", l.id);
        await addEvent(l, "opted_back_in", { by: profile.email, reason: clean(b.reason, 300) });
      }
      return json({ ok: true, leads_restored: leads?.length || 0 });
    }

    // ---- Demo ---------------------------------------------------------------
    // A fake lead in a demo client. Nothing touches Twilio: the admin types
    // the lead's replies and the agent answers through OpenAI as normal.
    case "demo_start": {
      adminOnly();
      let { data: demo } = await db.from("clients").select("*").eq("is_demo", true).limit(1).maybeSingle();
      if (!demo) {
        ({ data: demo } = await db.from("clients").insert({
          name: "Demo", is_demo: true, business_hours: { days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "19:00" },
        }).select("*").single());
      }
      const { data: preset } = await db.from("niche_presets").select("*").eq("slug", b.niche).maybeSingle();
      if (!preset) throw new HttpError(400, "Pick a niche");
      const company = String(b.company_name || "").trim() || "Demo Company";
      const agent = {
        ...preset.config,
        bot_name: String(b.bot_name || "").trim() || preset.config.bot_name,
        company_name: company,
        service: String(b.service || "").trim() || preset.config.service,
      };
      const { data: camp, error: ce } = await db.from("campaigns").insert({
        client_id: demo!.id, name: `Demo: ${company} (${preset.name})`, niche: preset.slug, status: "active", agent,
      }).select("*").single();
      if (ce) throw ce;
      const fakePhone = "+6140" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
      const { data: lead, error: le } = await db.from("leads").insert({
        client_id: demo!.id, campaign_id: camp.id, phone: fakePhone, is_demo: true,
        first_name: String(b.first_name || "").trim() || "Alex", last_name: String(b.last_name || "").trim() || null,
        service: agent.service, source: "Demo",
        enquired_at: new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10),
      }).select("*").single();
      if (le) throw le;
      await sendHandraiser(lead, camp, demo!);
      return json({ lead_id: lead.id, client_id: demo!.id });
    }

    case "demo_reply": {
      adminOnly();
      const lead = await getLead(b.lead_id);
      if (!lead.is_demo) throw new HttpError(400, "Not a demo lead");
      const body = String(b.body || "").trim();
      if (!body) throw new HttpError(400, "Message is empty");
      const { data: msg } = await db.from("messages").insert({
        client_id: lead.client_id, lead_id: lead.id, direction: "inbound", channel: "demo", author: "lead", body: body.slice(0, 2000),
      }).select("id").single();
      await onInbound(lead, body, msg!.id);
      return json({ ok: true });
    }

    // Deletes a demo lead, or a whole demo campaign and its leads. Only ever
    // demo data: a real client's leads are never touched here.
    case "demo_delete": {
      adminOnly();
      let campaignId: string | null = b.campaign_id || null;
      if (b.lead_id) {
        const lead = await getLead(b.lead_id);
        if (!lead.is_demo) throw new HttpError(400, "Not a demo lead");
        campaignId = lead.campaign_id;
        await db.from("leads").delete().eq("id", lead.id).eq("is_demo", true);
      }
      if (campaignId) {
        const camp = await getCampaign(campaignId);
        if (!camp.client?.is_demo) throw new HttpError(400, "Not a demo campaign");
        // A whole campaign was asked for, or this was its last lead.
        if (b.campaign_id) await db.from("leads").delete().eq("campaign_id", campaignId).eq("is_demo", true);
        const { count } = await db.from("leads").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
        if (!count) await db.from("campaigns").delete().eq("id", campaignId);
      }
      return json({ ok: true });
    }

    case "demo_reset": {
      adminOnly();
      const lead = await getLead(b.lead_id);
      if (!lead.is_demo) throw new HttpError(400, "Not a demo lead");
      await db.from("messages").delete().eq("lead_id", lead.id);
      await db.from("lead_events").delete().eq("lead_id", lead.id);
      const { data: fresh } = await db.from("leads").update({
        status: "new", ai_enabled: true, ai_state: "idle", intent: null, sentiment: null, qualification: {},
        summary: null, next_action: null, callback_at: null, callback_notes: null, replied_at: null, booked_at: null,
        interested_at: null, reply_due_at: null,
        contacted_at: null, last_inbound_at: null, last_outbound_at: null, last_message_at: null, error: null,
      }).eq("id", lead.id).select("*").single();
      const camp = await getCampaign(lead.campaign_id);
      await sendHandraiser(fresh, camp, camp.client);
      return json({ ok: true });
    }

    default:
      throw new HttpError(400, `Unknown action: ${b.action}`);
  }
}

// CSV dates: ISO, Australian DD/MM/YYYY, or anything Date can read.
function parseDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    const mo = +m[2], d = +m[1];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
