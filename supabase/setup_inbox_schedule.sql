-- OPTIONAL: run only after OAuth, owner login, and Edge Function secrets work.
-- In Supabase Vault, create a secret named pollpe_inbox_cron_secret containing
-- the SAME value as the function's INBOX_CRON_SECRET. Never commit that value.
-- This does not modify the existing public mail/question cleanup jobs.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'pollpe_inbox_cron_secret' limit 1
  ) then
    raise exception 'Create the pollpe_inbox_cron_secret Vault secret first.';
  end if;
end $$;

select cron.schedule(
  'pollpe-protected-inbox-sync',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := 'https://ewdpamsogpqhuzreaayo.supabase.co/functions/v1/protected-inbox',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', decrypted_secret
      ),
      body := '{"action":"cron.sync"}'::jsonb,
      timeout_milliseconds := 100000
    )
    from vault.decrypted_secrets
    where name = 'pollpe_inbox_cron_secret'
    limit 1;
  $job$
);

-- Inspect without exposing the secret:
select jobid, jobname, schedule, active from cron.job
where jobname = 'pollpe-protected-inbox-sync' limit 1;
-- To stop this integration only:
-- select cron.unschedule('pollpe-protected-inbox-sync');
