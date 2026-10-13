-- =============================================================================
-- Billing: per booking, prepaid credits, or invoiced by hand
-- =============================================================================
-- Run once in the SQL editor, before deploying the matching edge function.
-- Safe to run more than once.
--
-- Each client has a billing mode, set by an admin:
--   per_booking  card saved in Stripe; each booked callback is charged once,
--                after a dispute window, in a weekly run
--   credits      prepaid packs, no card saved; 1 credit per SMS segment in or
--                out, N credits per call minute; new handraisers stop at 0
--   invoice      usage is recorded and you bill them outside the app
--
-- Prices are in cents (AUD) and are whatever you charge (GST inclusive or not
-- is up to you; Stripe charges exactly these amounts).
-- =============================================================================

alter table public.clients
  add column if not exists billing_mode text not null default 'invoice',
  add column if not exists price_per_booking_cents int not null default 0,
  add column if not exists price_per_1000_credits_cents int not null default 0,
  add column if not exists credits_per_call_minute int not null default 10,
  add column if not exists credit_balance int not null default 0,
  -- Live conversations may carry on this far below zero, so a lead isn't
  -- dropped mid-booking the moment the balance runs out.
  add column if not exists credit_overdraft int not null default 50,
  add column if not exists monthly_booking_cap int,
  add column if not exists billing_email text,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_payment_method_id text,
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

do $$ begin
  alter table public.clients add constraint clients_billing_mode_check
    check (billing_mode in ('per_booking', 'credits', 'invoice'));
exception when duplicate_object then null; end $$;

-- Everything metered, in every mode. credits is what was deducted (credits
-- mode only); quantity is segments, minutes or bookings.
create table if not exists public.usage (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  lead_id     uuid references public.leads(id) on delete set null,
  kind        text not null check (kind in ('sms_out', 'sms_in', 'call_minutes', 'booking')),
  quantity    int not null default 1,
  credits     int not null default 0,
  ref         text,
  created_at  timestamptz not null default now()
);
create index if not exists usage_client_idx on public.usage(client_id, created_at desc);

-- Every change to a credit balance: purchases (+), usage (-), adjustments.
create table if not exists public.credit_ledger (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients(id) on delete cascade,
  delta              int not null,
  balance_after      int not null,
  reason             text not null,  -- purchase | usage | adjustment
  amount_cents       int,
  stripe_session_id  text unique,    -- a purchase can never be credited twice
  note               text,
  created_by         text,
  created_at         timestamptz not null default now()
);
create index if not exists credit_ledger_client_idx on public.credit_ledger(client_id, created_at desc);

-- One charge per booked lead, ever: moving the time never charges again.
create table if not exists public.booking_charges (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients(id) on delete cascade,
  lead_id            uuid references public.leads(id) on delete set null,
  lead_name          text,
  amount_cents       int not null,
  status             text not null default 'pending'
                     check (status in ('pending', 'disputed', 'waived', 'charging', 'charged', 'failed')),
  booked_at          timestamptz not null default now(),
  dispute_reason     text,
  disputed_at        timestamptz,
  disputed_by        text,
  resolution_note    text,
  resolved_by        text,
  payment_intent_id  text,
  charged_at         timestamptz,
  error              text,
  created_at         timestamptz not null default now()
);
create unique index if not exists booking_charges_lead_idx on public.booking_charges(lead_id) where lead_id is not null;
create index if not exists booking_charges_client_idx on public.booking_charges(client_id, status, booked_at);

-- Who confirmed that an uploaded list is people who agreed to be contacted.
create table if not exists public.lead_imports (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  campaign_id   uuid references public.campaigns(id) on delete set null,
  uploaded_by   text not null,
  consent_text  text not null,
  rows_total    int not null default 0,
  inserted      int not null default 0,
  created_at    timestamptz not null default now()
);

alter table public.calls add column if not exists duration_seconds int;

-- Atomically changes a balance and records why. A purchase passes its Stripe
-- session id, so a webhook delivered twice credits once.
create or replace function public.apply_credits(
  p_client uuid, p_delta int, p_reason text,
  p_session text default null, p_amount int default null, p_note text default null, p_by text default null
) returns int language plpgsql security definer set search_path = public as $$
declare bal int;
begin
  if p_session is not null and exists (select 1 from public.credit_ledger where stripe_session_id = p_session) then
    select credit_balance into bal from public.clients where id = p_client;
    return bal;
  end if;
  update public.clients set credit_balance = credit_balance + p_delta where id = p_client
  returning credit_balance into bal;
  insert into public.credit_ledger (client_id, delta, balance_after, reason, amount_cents, stripe_session_id, note, created_by)
  values (p_client, p_delta, bal, p_reason, p_amount, p_session, p_note, p_by);
  return bal;
end $$;
revoke all on function public.apply_credits(uuid, int, text, text, int, text, text) from public, anon, authenticated;

-- Usage takes credits off without a ledger row per text; the usage table is
-- the itemised record of what was used.
create or replace function public.use_credits(p_client uuid, p_credits int)
returns int language sql security definer set search_path = public as $$
  update public.clients set credit_balance = credit_balance - p_credits where id = p_client
  returning credit_balance;
$$;
revoke all on function public.use_credits(uuid, int) from public, anon, authenticated;

-- Usage per client per month (Sydney time), for the Billing page.
create or replace view public.usage_monthly with (security_invoker = true) as
select
  client_id,
  (date_trunc('month', created_at at time zone 'Australia/Sydney'))::date as month,
  kind,
  sum(quantity)::int as quantity,
  sum(credits)::int  as credits
from public.usage
group by 1, 2, 3;

alter table public.usage           enable row level security;
alter table public.credit_ledger   enable row level security;
alter table public.booking_charges enable row level security;
alter table public.lead_imports    enable row level security;

drop policy if exists usage_read on public.usage;
create policy usage_read on public.usage for select to authenticated using (public.can_see_client(client_id));
drop policy if exists ledger_read on public.credit_ledger;
create policy ledger_read on public.credit_ledger for select to authenticated using (public.can_see_client(client_id));
drop policy if exists charges_read on public.booking_charges;
create policy charges_read on public.booking_charges for select to authenticated using (public.can_see_client(client_id));
drop policy if exists imports_read on public.lead_imports;
create policy imports_read on public.lead_imports for select to authenticated using (public.can_see_client(client_id));

-- Weekly booking charges: Mondays 00:05 UTC (10:05am AEST / 11:05am AEDT).
-- Reuses the send queue's secrets from 003; only the path differs.
do $$ begin
  perform cron.unschedule('reactivation-weekly-charges');
exception when others then null; end $$;
select cron.schedule(
  'reactivation-weekly-charges',
  '5 0 * * 1',
  $$
  select net.http_post(
    url     := replace((select decrypted_secret from vault.decrypted_secrets where name = 'reactivation_cron_url'), '/cron', '/billing/charge'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reactivation_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
