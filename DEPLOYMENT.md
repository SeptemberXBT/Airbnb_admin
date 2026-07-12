# Deployment and pilot

## 1. Supabase

1. Create a Supabase project in the India region when available.
2. Apply the migrations in filename order: `0001_initial.sql`,
   `0002_cleaning_task_identity.sql`, `0003_universal_operation_times.sql`, then
   `0004_shared_admin_workspace.sql`.
3. Create the first manager in Supabase Authentication. Disable public signup.
4. Use the pooled Postgres connection string for `DATABASE_URL`.

Rollback files are supplied beside each forward migration. Take a database
backup before using a rollback in a live project.

Migration `0003` normalizes every property to an 11:00 AM checkout and 1:00 PM
check-in. Reservation-level early check-in and late checkout overrides remain
supported from the Today queue.

Migration `0004` shares every property with every Supabase Auth user in this
dedicated project, including future users and properties. Keep public signup
disabled so only accounts created by the Noir Haus owner receive access.

## 2. Secrets

Generate values locally and store them only in Supabase/Vercel/server secret
stores:

```sh
openssl rand -base64 32 # ICAL_ENCRYPTION_KEY
openssl rand -hex 32    # SYNC_SECRET
```

Set these Vercel variables for Preview and Production:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `DATABASE_URL`
- `SYNC_SECRET`
- `ICAL_ENCRYPTION_KEY`
- `APP_URL`

Do not set `DEMO_MODE` in Vercel. The application ignores demo bypasses in
production, but omitting it keeps the intent explicit.

## 3. Vercel

Import this repository, set the environment variables, and deploy. Confirm:

- `/login` is reachable.
- `/calendar` redirects to `/login` without a session.
- `/api/sync/cron` returns `401` without the bearer secret.
- `/api/health` returns `200`.

## 4. Existing server trigger

Copy `ops/trigger-sync.sh` to the server. Create `/etc/haven-operations.env`
with mode `600`:

```sh
APP_URL=https://your-vercel-domain.example
SYNC_SECRET=the-same-secret-stored-in-vercel
```

Install the line from `ops/crontab.example`. The trigger runs every 15 minutes,
uses a 70-second timeout and two transport retries, and exits non-zero for HTTP
errors. Send `/var/log/haven-sync.log` to the server's existing monitoring.

## 5. One-listing pilot

1. Add one synthetic or non-critical property and its private Airbnb export URL.
2. Run **Refresh now** and verify one inbound reservation appears once.
3. Rotate the listing's outbound feed and copy the one-time URL.
4. Import that URL into the matching Airbnb listing.
5. Create a future local block with **Block on Airbnb** enabled.
6. Confirm the block is immediately visible locally and later visible on Airbnb.
7. Archive the future block and confirm it disappears from the outbound feed,
   then from Airbnb after Airbnb refreshes.
8. Confirm a real same-day turnover produces the correct cleaning order.
9. Review sync health and audit history before adding more properties.

Airbnb controls its own import interval. The application cannot force an Airbnb
refresh or create an Airbnb reservation, payout, message thread, or confirmation.
