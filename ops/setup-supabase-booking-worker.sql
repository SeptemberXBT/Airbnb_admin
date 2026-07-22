create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'noirhaus-booking-worker-minute';

select cron.schedule(
  'noirhaus-booking-worker-minute',
  '* * * * *',
  $worker$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'noir_booking_worker_url'
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'noir_booking_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 50000
    );
  $worker$
);
