# Deployment and pilot

## 1. Supabase

1. Create a Supabase project in the India region when available.
2. Apply the migrations in filename order: `0001_initial.sql`,
   `0002_cleaning_task_identity.sql`, `0003_universal_operation_times.sql`, then
   `0004_shared_admin_workspace.sql`, `0005_manual_entry_payment.sql`,
   `0006_preserve_airbnb_history.sql`, `0007_public_booking.sql`, then
   `0008_premium_booking_checkout.sql`.
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

Migration `0005` adds private payment storage for manual blocks and direct
reservations. Apply it before deploying application code that writes or exports
payment data.

Migration `0006` retains completed Airbnb events after Airbnb removes them from
its current iCal feed. Apply it before deploying application code that queries
the new `historical` column. It safely restores previously archived rows only
when the database proves they were still observed on or after check-in; it
cannot reconstruct stays that the application never imported.

Migration `0007` adds authoritative website rates, immutable booking-night price
snapshots, payment attempts, ten-minute holds, the partial active-night inventory
index, provider event/job tables, notification outbox, and booking audit events.
Keep `INVENTORY_LEDGER_MODE=shadow` and `PUBLIC_BOOKING_ENABLED=false` through the
manual-entry/iCal parity gate. Applying the migration does not enable public sales.

Migration `0008` adds premium guest fields, reversible archive metadata, and the
non-secret Razorpay key ID that binds an order/refund to the account and mode
that created it. Apply `0008` before deploying the matching admin code. Deploy
admin immediately after the migration, verify `/api/health`, and deploy the
public site last. The admin returns the legacy status shape unless the signed
client sends `X-Noir-Api-Version: 2`, so the currently deployed public site
continues working during this staged rollout. Do not reverse this order: the new
public form sends additive fields that the old admin schema rejects.

## 2. Secrets

Generate values locally and store them only in Supabase/Vercel/server secret
stores:

```sh
openssl rand -base64 32 # ICAL_ENCRYPTION_KEY
openssl rand -hex 32    # SYNC_SECRET
openssl rand -hex 32    # BOOKING_API_HMAC_SECRET
openssl rand -hex 32    # BOOKING_CRON_SECRET (must be a different value)
```

Set these Vercel variables for Preview and Production:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `DATABASE_URL`
- `SYNC_SECRET`
- `ICAL_ENCRYPTION_KEY`
- `APP_URL`
- `BOOKING_API_KEY_ID`
- `BOOKING_API_HMAC_SECRET`
- `RAZORPAY_KEY_ID` (a `rzp_test_...` key during this rollout)
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `ZEPTOMAIL_TOKEN`
- `ZEPTOMAIL_SENDER_ADDRESS`
- `ZEPTOMAIL_SENDER_NAME`
- `ADMIN_NOTIFICATION_EMAIL`
- `BOOKING_CRON_SECRET`
- `INVENTORY_LEDGER_MODE=shadow`
- `PUBLIC_BOOKING_ENABLED=false`

Set `BOOKING_API_PREVIOUS_KEY_ID` and `BOOKING_API_PREVIOUS_HMAC_SECRET` only
during an intentional HMAC key rotation. Never put database, Razorpay, ZeptoMail,
webhook, cron, or HMAC secrets in `NEXT_PUBLIC_*` variables.

Do not set `DEMO_MODE` in Vercel. The application ignores demo bypasses in
production, but omitting it keeps the intent explicit.

## 3. Vercel

Import this repository, set the environment variables, and deploy. Confirm:

- `/login` is reachable.
- `/calendar` redirects to `/login` without a session.
- `/api/sync/cron` returns `401` without the bearer secret.
- `/api/health` returns `200`.
- `/api/bookings/cron` returns `401` without its dedicated bearer secret.
- `/api/internal/v1/availability` returns a controlled `503` while
  `PUBLIC_BOOKING_ENABLED=false`.

Immediately after a new environment starts, `/api/health` can return `503` with
coarse `bookingWorker: stale` until the first one-minute worker run completes.
It never lists missing configuration names or secret values.

## 4. One-minute booking worker

For the Vercel Hobby deployment, use Supabase `pg_cron` + `pg_net` instead of
Vercel Cron. In Supabase SQL Editor, store the production endpoint and the same
server-only cron secret in Vault, then run `ops/setup-supabase-booking-worker.sql`:

```sql
select vault.create_secret(
  'https://your-admin-domain.example/api/bookings/cron',
  'noir_booking_worker_url'
);
select vault.create_secret(
  'the-same-BOOKING_CRON_SECRET-stored-in-vercel',
  'noir_booking_cron_secret'
);
```

The setup SQL replaces only the named `noirhaus-booking-worker-minute` job and
never embeds either secret in source control. Verify it with `cron.job` and
`net._http_response`, then check `/api/health` after the first successful run.

### Existing always-on server alternative

Copy `ops/trigger-sync.sh` to the server. Create `/etc/haven-operations.env`
with mode `600`:

```sh
APP_URL=https://your-vercel-domain.example
SYNC_SECRET=the-same-secret-stored-in-vercel
```

Install the relevant lines from `ops/crontab.example`. The Airbnb trigger runs every 15 minutes,
uses a 70-second timeout and two transport retries, and exits non-zero for HTTP
errors. Send `/var/log/haven-sync.log` to the server's existing monitoring.

The booking trigger runs every minute with its separate `BOOKING_CRON_SECRET`.
It recovers ambiguous Razorpay orders by receipt, reconciles expired holds
against Razorpay before release, processes queued payment checks, full refunds,
ZeptoMail outbox delivery, nonce cleanup, stale leases, and expired idempotency
response bodies. Monitor `/var/log/haven-booking-jobs.log`
and alert when `/api/health` reports `bookingWorker: stale` for more than three
minutes. The cron response contains counts only—never guest details or provider
credentials.

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
10. Create a two-night manual entry with a guest and INR 1,000 total payment.
    Export both dates and confirm the property column contains INR 500.00 on
    each occupied date.

Airbnb controls its own import interval. The application cannot force an Airbnb
refresh or create an Airbnb reservation, payout, message thread, or confirmation.

## 6. Website booking Test Mode

Use [`docs/booking-test-mode-runbook.md`](./docs/booking-test-mode-runbook.md)
for the staged migration, isolated Preview setup, HMAC rotation, Razorpay and
ZeptoMail configuration, firewall limits, acceptance tests, monitoring, and
rollback order. The production booking flag stays off until a separate owner
approval is recorded after Preview acceptance.
