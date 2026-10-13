-- =============================================================================
-- Send queue: every minute, ask the edge function to send the next batch of
-- handraisers.
-- =============================================================================
-- Before running:
--   1. Database -> Extensions: enable pg_cron and pg_net (or let the two lines
--      below do it).
--   2. Replace REPLACE_WITH_CRON_SECRET with the same value you set as the
--      CRON_SECRET edge function secret.
--
-- The secret goes in Supabase Vault so it is not in the cron job's text.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(
  'https://vcantdssoketpxaybtwh.supabase.co/functions/v1/reactivation/cron',
  'reactivation_cron_url'
);
select vault.create_secret('REPLACE_WITH_CRON_SECRET', 'reactivation_cron_secret');

select cron.schedule(
  'reactivation-send-queue',
  '* * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'reactivation_cron_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reactivation_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- To change the secret later:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'reactivation_cron_secret'),
--     'NEW_VALUE');
-- To stop the queue:
--   select cron.unschedule('reactivation-send-queue');
