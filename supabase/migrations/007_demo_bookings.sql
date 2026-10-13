-- =============================================================================
-- Demo bookings from the website (demo.html)
-- =============================================================================
-- Run once in the SQL editor. Safe to run more than once.
--
-- Visitors fill in a form, pick a time, and the edge function books it,
-- emails contact@quoteleads.com.au and sends them a confirmation. Nothing
-- here is readable or writable from the website directly: only the edge
-- function (service role) and admins in the app touch these tables.
-- =============================================================================

-- Your availability. One row; edit it in the app (Demos page) or here.
create table if not exists public.demo_settings (
  id                 int primary key default 1 check (id = 1),
  timezone           text not null default 'Australia/Brisbane',
  days               int[] not null default '{1,2,3,4,5}',  -- 1 = Monday ... 7 = Sunday
  start_time         text not null default '09:00',
  end_time           text not null default '17:00',
  slot_minutes       int  not null default 30 check (slot_minutes between 10 and 120),
  min_notice_hours   int  not null default 12 check (min_notice_hours between 0 and 336),
  horizon_days       int  not null default 21 check (horizon_days between 1 and 90),
  notify_email       text not null default 'contact@quoteleads.com.au',
  updated_at         timestamptz not null default now()
);
insert into public.demo_settings (id) values (1) on conflict (id) do nothing;

-- Times you're not available (leave, other meetings). Slots overlapping
-- these aren't offered.
create table if not exists public.demo_blackouts (
  id          uuid primary key default gen_random_uuid(),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  note        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.demo_requests (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null,
  phone         text,
  business      text,
  industry      text,
  lead_count    text,
  message       text,
  slot_start    timestamptz not null,
  slot_end      timestamptz not null,
  visitor_tz    text,
  status        text not null default 'booked' check (status in ('booked', 'completed', 'cancelled', 'no_show')),
  admin_note    text,
  ip_hash       text,   -- hashed, for rate limiting only; the raw IP isn't kept
  created_at    timestamptz not null default now()
);
-- Two people can never hold the same slot.
create unique index if not exists demo_requests_slot_idx on public.demo_requests(slot_start) where status = 'booked';
create index if not exists demo_requests_ip_idx on public.demo_requests(ip_hash, created_at);

alter table public.demo_settings  enable row level security;
alter table public.demo_blackouts enable row level security;
alter table public.demo_requests  enable row level security;

drop policy if exists demo_settings_admin on public.demo_settings;
create policy demo_settings_admin on public.demo_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists demo_blackouts_admin on public.demo_blackouts;
create policy demo_blackouts_admin on public.demo_blackouts for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists demo_requests_admin on public.demo_requests;
create policy demo_requests_admin on public.demo_requests for all to authenticated using (public.is_admin()) with check (public.is_admin());
