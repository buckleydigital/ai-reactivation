-- =============================================================================
-- AI Database Reactivation - schema
-- =============================================================================
-- Run this first, in the Supabase SQL editor, on a fresh project.
--
-- Multi-client by design: every row that belongs to a client carries
-- client_id, and row level security decides who can see it. Admins see every
-- client; a client user sees only the client on their profile. The edge
-- function uses the service role and does its own checks, so nothing here is
-- loosened for it.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Clients: the businesses we reactivate leads for.
-- ---------------------------------------------------------------------------
create table public.clients (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  timezone       text not null default 'Australia/Sydney',
  -- Where "callback booked" alerts go.
  notify_phone   text,
  notify_email   text,
  -- When the business can ring a lead back. Callbacks are only booked inside
  -- these hours. days: 1 = Monday ... 7 = Sunday.
  business_hours jsonb not null default '{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}',
  -- Demo clients never touch Twilio: their leads are fake and every message
  -- stays in the database.
  is_demo        boolean not null default false,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Profiles: one per auth user. role decides admin vs client mode.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'client' check (role in ('admin', 'client')),
  client_id   uuid references public.clients(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Every new auth user gets a profile with no access. Deliberately ignores any
-- role or client in the sign-up metadata: anyone can write that. The invite
-- action in the edge function (service role) assigns the client afterwards.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Access helpers. security definer so policies can read profiles without
-- recursing into profiles' own policies.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create or replace function public.my_client_id()
returns uuid language sql stable security definer set search_path = public as $$
  select client_id from public.profiles where id = auth.uid()
$$;

create or replace function public.can_see_client(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or (c is not null and c = public.my_client_id())
$$;

-- ---------------------------------------------------------------------------
-- Niche presets: starting configs for each industry. A campaign copies one
-- and can then change anything in it.
-- ---------------------------------------------------------------------------
create table public.niche_presets (
  slug        text primary key,
  name        text not null,
  sort        int not null default 100,
  config      jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Campaigns: one uploaded list for one client, with the agent's script.
--
-- agent (jsonb):
--   bot_name, company_name, service, tone,
--   handraiser_templates: text[]   ({first_name} {bot_name} {company} {service})
--   handraiser_mode: 'template' | 'ai'
--   opt_out_text,
--   qualification_questions: [{key, question, required}]
--   disqualifiers: text[], compliance_notes, extra_instructions,
--   voice: OpenAI realtime voice name for inbound calls
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete cascade,
  name             text not null,
  niche            text references public.niche_presets(slug) on delete set null,
  status           text not null default 'draft'
                   check (status in ('draft', 'active', 'paused', 'completed')),
  agent            jsonb not null default '{}',
  -- When handraisers may go out, in the client's timezone.
  send_window      jsonb not null default '{"days":[1,2,3,4,5,6],"start":"09:00","end":"19:00"}',
  send_per_minute  int not null default 6 check (send_per_minute between 1 and 60),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index campaigns_client_idx on public.campaigns(client_id);

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create table public.leads (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete cascade,
  campaign_id      uuid references public.campaigns(id) on delete set null,
  first_name       text,
  last_name        text,
  phone            text not null,               -- E.164, e.g. +61412345678
  email            text,
  service          text,                        -- what they enquired about
  enquired_at      date,
  source           text,
  notes            text,
  extra            jsonb not null default '{}', -- any other CSV columns
  status           text not null default 'new' check (status in (
                     'new', 'queued', 'sending', 'contacted', 'replied', 'engaged',
                     'qualified', 'booked', 'not_interested', 'wrong_person',
                     'disqualified', 'opted_out', 'failed')),
  ai_enabled       boolean not null default true,
  -- Drives the agent animation: 'thinking' while a reply is being written,
  -- 'on_call' while the voice agent is on the phone with them.
  ai_state         text not null default 'idle' check (ai_state in ('idle', 'thinking', 'on_call')),
  intent           text,
  sentiment        text,
  qualification    jsonb not null default '{}',
  summary          text,
  next_action      text,
  callback_at      timestamptz,
  callback_notes   text,
  -- Anchor 1 and anchor 2.
  replied_at       timestamptz,
  booked_at        timestamptz,
  contacted_at     timestamptz,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  last_message_at  timestamptz,
  handraiser_variant int,
  error            text,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  -- The same phone may be a lead for two clients, never twice for one.
  unique (client_id, phone)
);
create index leads_phone_idx on public.leads(phone);
create index leads_campaign_status_idx on public.leads(campaign_id, status);
create index leads_client_activity_idx on public.leads(client_id, last_message_at desc nulls last);

-- ---------------------------------------------------------------------------
-- Messages: SMS both ways, voice transcript lines, demo messages and notes.
-- ---------------------------------------------------------------------------
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  lead_id     uuid not null references public.leads(id) on delete cascade,
  direction   text not null check (direction in ('inbound', 'outbound')),
  channel     text not null default 'sms' check (channel in ('sms', 'voice', 'demo', 'note')),
  author      text not null check (author in ('lead', 'ai', 'human', 'system')),
  body        text not null,
  twilio_sid  text,
  status      text,
  error       text,
  call_id     uuid,
  created_at  timestamptz not null default now()
);
create index messages_lead_idx on public.messages(lead_id, created_at);
create unique index messages_twilio_sid_idx on public.messages(twilio_sid) where twilio_sid is not null;

-- ---------------------------------------------------------------------------
-- Events: the timeline, including the two anchors
-- ('lead_replied', 'callback_booked').
-- ---------------------------------------------------------------------------
create table public.lead_events (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  lead_id     uuid not null references public.leads(id) on delete cascade,
  type        text not null,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index lead_events_lead_idx on public.lead_events(lead_id, created_at);
create index lead_events_type_idx on public.lead_events(client_id, type, created_at);

-- ---------------------------------------------------------------------------
-- Inbound calls handled by the voice agent.
-- ---------------------------------------------------------------------------
create table public.calls (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete cascade,
  lead_id          uuid not null references public.leads(id) on delete cascade,
  twilio_call_sid  text,
  openai_call_id   text,
  from_number      text,
  status           text not null default 'ringing',
  summary          text,
  started_at       timestamptz not null default now(),
  answered_at      timestamptz,
  ended_at         timestamptz
);
create index calls_lead_idx on public.calls(lead_id, started_at);

-- ---------------------------------------------------------------------------
-- Opt-outs. Global per phone: everyone texts from the same shared number, so
-- someone who replied STOP to it must never hear from it again, whichever
-- client they were answering.
-- ---------------------------------------------------------------------------
create table public.opt_outs (
  phone       text primary key,
  client_id   uuid references public.clients(id) on delete set null,
  lead_id     uuid references public.leads(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Routing: which lead does an inbound text or call from this phone belong to?
--
-- The shared number's only defence against mixing clients up. A phone in one
-- client's leads goes to that lead. A phone in several clients' leads goes to
-- whoever texted it most recently. If none of them has texted it, there is no
-- evidence either way and it returns null: delivering to the wrong client is
-- far worse than not delivering at all. Demo leads never match.
-- ---------------------------------------------------------------------------
create or replace function public.route_inbound_phone(p_phones text[])
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  n int;
  top record;
begin
  select count(*) into n from public.leads where phone = any(p_phones) and not is_demo;
  if n = 0 then return null; end if;

  select id, last_outbound_at into top
  from public.leads
  where phone = any(p_phones) and not is_demo
  order by last_outbound_at desc nulls last, created_at desc
  limit 1;

  if n > 1 and top.last_outbound_at is null then return null; end if;
  return top.id;
end $$;
revoke all on function public.route_inbound_phone(text[]) from public, anon, authenticated;

-- Atomically hands the send queue its next batch, so two overlapping cron runs
-- can never text the same lead twice.
create or replace function public.claim_queued_leads(p_campaign uuid, p_limit int)
returns setof public.leads language sql security definer set search_path = public as $$
  update public.leads l set status = 'sending'
  where l.id in (
    select id from public.leads
    where campaign_id = p_campaign and status = 'queued'
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning l.*;
$$;
revoke all on function public.claim_queued_leads(uuid, int) from public, anon, authenticated;

-- Funnel numbers per campaign. security_invoker so it obeys leads' RLS.
create or replace view public.campaign_stats with (security_invoker = true) as
select
  c.id as campaign_id,
  c.client_id,
  count(l.id)                                                          as total,
  count(l.id) filter (where l.status in ('new', 'queued', 'sending'))  as pending,
  count(l.id) filter (where l.contacted_at is not null)                as contacted,
  count(l.id) filter (where l.replied_at is not null)                  as replied,
  count(l.id) filter (where l.booked_at is not null)                   as booked,
  count(l.id) filter (where l.status = 'opted_out')                    as opted_out,
  count(l.id) filter (where l.status = 'failed')                       as failed
from public.campaigns c
left join public.leads l on l.campaign_id = c.id
group by c.id, c.client_id;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.clients       enable row level security;
alter table public.profiles      enable row level security;
alter table public.niche_presets enable row level security;
alter table public.campaigns     enable row level security;
alter table public.leads         enable row level security;
alter table public.messages      enable row level security;
alter table public.lead_events   enable row level security;
alter table public.calls         enable row level security;
alter table public.opt_outs      enable row level security;

create policy clients_read  on public.clients for select to authenticated using (public.can_see_client(id));
create policy clients_admin on public.clients for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy profiles_read  on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_admin on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy presets_read  on public.niche_presets for select to authenticated using (true);
create policy presets_admin on public.niche_presets for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy campaigns_read  on public.campaigns for select to authenticated using (public.can_see_client(client_id));
create policy campaigns_admin on public.campaigns for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- Client users may read their leads. Changes (pausing the AI, marking a lead)
-- go through the edge function so they are logged on the timeline.
create policy leads_read  on public.leads for select to authenticated using (public.can_see_client(client_id));
create policy leads_admin on public.leads for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy messages_read on public.messages    for select to authenticated using (public.can_see_client(client_id));
create policy events_read   on public.lead_events for select to authenticated using (public.can_see_client(client_id));
create policy calls_read    on public.calls       for select to authenticated using (public.can_see_client(client_id));
create policy optouts_admin on public.opt_outs    for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Realtime: the app listens to these so replies, anchors and the agent's
-- "thinking" state appear live. Realtime applies the policies above, so a
-- client user only ever receives their own rows.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.leads, public.messages, public.lead_events, public.calls;
