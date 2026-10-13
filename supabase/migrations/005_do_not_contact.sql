-- =============================================================================
-- Do Not Contact list: record how and by whom each number was added
-- =============================================================================
-- opt_outs already is the list (one row per phone, global across clients:
-- everyone texts from the same number). This adds what the admin page shows.
--
--   reason:   'keyword' (replied STOP), 'asked' (asked by text),
--             'asked on a call', 'manual' (added by hand), 'import' (uploaded)
--   note:     free text, e.g. "Client's own DNC list, Oct 2026"
--   added_by: the admin's email, for manual and uploaded entries
--
-- Safe to run more than once.
-- =============================================================================

alter table public.opt_outs
  add column if not exists reason   text,
  add column if not exists note     text,
  add column if not exists added_by text;

-- Fill in the reason for opt-outs recorded before this column existed.
update public.opt_outs o
set reason = coalesce(
  (select e.data->>'how' from public.lead_events e
   where e.lead_id = o.lead_id and e.type = 'opted_out'
   order by e.created_at desc limit 1),
  'keyword')
where o.reason is null;

create index if not exists opt_outs_created_idx on public.opt_outs(created_at desc);
