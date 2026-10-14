-- Prepaid credits are gone: clients are billed per booking, or invoiced by
-- hand. Anyone still on credits moves to invoice, and the mode can't be set
-- again. credit_ledger and the credit columns stay as history; nothing reads
-- or writes them any more.

update public.clients set billing_mode = 'invoice' where billing_mode = 'credits';

alter table public.clients drop constraint if exists clients_billing_mode_check;
alter table public.clients add constraint clients_billing_mode_check
  check (billing_mode in ('per_booking', 'invoice'));

