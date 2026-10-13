-- =============================================================================
-- Anchor 1 becomes "positive reply"; real SMS replies wait 30-60s
-- =============================================================================
-- Run once in the SQL editor, before deploying the matching edge function.
--
-- interested_at: when the lead first showed real interest (a positive reply,
--   calling back, answering the qualifying questions or agreeing a
--   callback). replied_at still records any reply at all, including "no"
--   and STOP, for the reply rate.
-- reply_due_at: when the agent will answer the latest text, so the app can
--   show "replies in about 40s".
-- =============================================================================

alter table public.leads
  add column if not exists interested_at timestamptz,
  add column if not exists reply_due_at  timestamptz;

-- Leads that were already engaged, qualified or booked were interested.
update public.leads
set interested_at = coalesce(replied_at, booked_at, now())
where interested_at is null
  and (status in ('engaged', 'qualified', 'booked') or booked_at is not null);

-- Same view as before with "interested" added (new columns go last).
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
  count(l.id) filter (where l.status = 'failed')                       as failed,
  count(l.id) filter (where l.interested_at is not null)               as interested
from public.campaigns c
left join public.leads l on l.campaign_id = c.id
group by c.id, c.client_id;
