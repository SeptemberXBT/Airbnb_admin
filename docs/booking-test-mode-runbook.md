# Booking Test Mode rollout

This runbook operates the admin backend as the only database, pricing, inventory,
payment, email, and Airbnb-sync authority. The separately deployed public site
has no database or provider credentials and reaches only the signed internal API.

This document prepares a rollout; it does not authorize a production migration,
deployment, public-booking enablement, or Razorpay Live Mode.

## 1. Release gates

1. Back up the target Supabase database and record the restore point.
2. Apply `supabase/migrations/0007_public_booking.sql` after migrations `0001`
   through `0006` are present.
3. Deploy with `INVENTORY_LEDGER_MODE=shadow` and
   `PUBLIC_BOOKING_ENABLED=false`.
4. Run the idempotent inventory backfill:

   ```sh
   NODE_ENV=production CONFIRM_BOOKING_BACKFILL=yes npm run backfill:inventory
   ```

5. Observe at least one complete inbound Airbnb sync cycle. Run manual
   create/edit/archive smoke tests and investigate every shadow-ledger mismatch.
6. Only after zero unexplained mismatches, deploy
   `INVENTORY_LEDGER_MODE=enforced` while keeping public booking disabled.
7. Create an isolated admin Preview with enforced inventory and Test Mode
   booking enabled. Never point the public Preview at the production admin.

For the premium checkout release, apply `0008_premium_booking_checkout.sql`,
then deploy admin, verify health/status with the existing public site, and only
then deploy public. Version 2 signed requests receive the expanded safe booking
summary while an unversioned deployed client keeps the legacy response. This
ordering prevents either strict schema from seeing an incompatible payload.

The production public-booking flag remains `false` until a later, explicit
approval. Do not use the rollback migration merely to disable sales; use the
feature flag first so payment/refund/email workers can finish durable work.

## 2. Admin environment variables

Set these independently for Preview and Production. Preview must use its own
HMAC identity, Razorpay Test Mode keys/webhook secret, and test notification
recipients.

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
DATABASE_URL
SYNC_SECRET
ICAL_ENCRYPTION_KEY
APP_URL
BOOKING_API_KEY_ID
BOOKING_API_HMAC_SECRET
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
ZEPTOMAIL_TOKEN
ZEPTOMAIL_SENDER_ADDRESS
ZEPTOMAIL_SENDER_NAME
GUEST_SUPPORT_EMAIL
ADMIN_NOTIFICATION_EMAIL
BOOKING_CRON_SECRET
INVENTORY_LEDGER_MODE
PUBLIC_AVAILABILITY_ENABLED
PUBLIC_BOOKING_ENABLED
```

During a deliberate key rotation only, also set:

```text
BOOKING_API_PREVIOUS_KEY_ID
BOOKING_API_PREVIOUS_HMAC_SECRET
```

Rules:

- `RAZORPAY_KEY_ID` must start with `rzp_test_` for this rollout.
- `BOOKING_CRON_SECRET`, `SYNC_SECRET`, and the HMAC secret are different random
  values.
- No server secret may have a `NEXT_PUBLIC_` prefix.
- `APP_URL` is the exact admin deployment origin.
- Keep both production flags at `INVENTORY_LEDGER_MODE=enforced` and
  `PUBLIC_BOOKING_ENABLED=false` during Preview acceptance.

The public API rollout supports these fail-closed states:

```text
availability=false, booking=false  -> all public API operations disabled
availability=true,  booking=false  -> quotes enabled; booking creation disabled
availability=any,   booking=true   -> quotes and booking creation enabled
```

The availability-only state does not require Razorpay, ZeptoMail, or a healthy
booking worker because a quote creates no booking, hold, payment, or email
state. `PUBLIC_AVAILABILITY_ENABLED` must equal `true` exactly; missing or
invalid values remain disabled unless full public booking is enabled.

## 3. Eight-room pricing gate

In the authenticated `/pricing` page, map each fixed public slug to exactly one
active property. Enter the owner-approved guest limit and weekday and weekend
night prices. Weekend means Friday and Saturday night. Date overrides take
precedence over weekend, which takes precedence over weekday. Never copy a price
from the browser request or invent a launch price.

Public stays are limited to 30 nights and check-in is limited to 365 days from
the current India stay date. Both public proxy and admin enforce these bounds
before any nightly enumeration or database lookup.

Required slugs:

```text
sage-sunlight-studio
ink-ivory-suite
shade-of-love
midnight-espresso-suite
luxe-urban-nest
emerald-suite
linen-lace-suite
silk-sage
```

Before enabling Preview booking, run this read-only completeness check in the
target database. It must return `8`, `8`, `8`:

```sql
select
  count(*) as configured_rows,
  count(distinct r.public_room_slug) as unique_slugs,
  count(*) filter (
    where r.booking_enabled
      and r.max_guests > 0
      and r.weekday_price_paise > 0
      and r.weekend_price_paise > 0
      and p.active
      and p.archived_at is null
  ) as enabled_complete_rows
from public.property_rates r
join public.properties p on p.id = r.property_id;
```

Check an override on the Pricing calendar and verify that an availability quote
uses `override`, then check a Friday/Saturday night uses `weekend` and another
night uses `weekday`.

## 4. HMAC key rotation

Never replace both deployments at once and never reuse a key ID.

1. Generate a new key ID and 32-byte-or-longer random secret.
2. On admin, set the new pair as `BOOKING_API_KEY_ID` and
   `BOOKING_API_HMAC_SECRET`; move the current pair to the two `PREVIOUS`
   variables. Deploy admin first.
3. Verify the old public deployment still receives a signed availability result.
4. Set the new current pair on the public deployment and deploy it.
5. Verify availability, create, status, and reconcile from the public Preview.
6. Remove both `PREVIOUS` variables from admin and deploy admin again.
7. Confirm a request signed with the retired key returns `401`.

The admin persists nonces, rejects replay with a unique constraint, allows five
minutes of clock drift, expires nonce rows after ten minutes, and stream-caps
signed bodies at 8 KiB before buffering. The ten-minute per-key endpoint buckets
are 600 availability, 60 booking creates, 1,200 status reads, and 120 reconcile
requests, so search traffic cannot starve payment/status calls. Keep both hosts
on normal NTP.

## 5. Razorpay Test Mode

In the Razorpay Test Mode dashboard:

1. Set the webhook URL to
   `https://ADMIN_PREVIEW/api/webhooks/razorpay`.
2. Use the same generated secret as `RAZORPAY_WEBHOOK_SECRET`.
3. Subscribe to the events this application accepts:
   `payment.authorized`, `payment.captured`, `payment.failed`, and `order.paid`.
4. Ensure Test Mode automatic capture is configured before acceptance testing.
5. Deliver a signed test event and verify `200`; missing/bad signatures must be
   `401`, and repeated event IDs must not duplicate side effects.

The browser receives only the public key ID, order ID, amount, and currency that
admin computed. It never receives the Razorpay key secret or webhook secret.
The admin also records that non-secret key ID on the booking. A refund remains
retryable and is never sent when the worker's configured key ID does not match
the booking. For a pre-migration booking with no recorded key ID, the admin
verifies that the configured account can see the exact captured order/payment
before it archives the booking or releases inventory.
The webhook and the one-minute reconciliation worker remain the source of truth;
the Checkout handler only asks admin to reconcile.

Refund webhooks are not consumed by this release. Refund jobs reconcile through
the Razorpay API every minute and remain `pending` on ambiguous provider errors.

## 6. Zoho ZeptoMail

1. Create a transactional ZeptoMail Agent for booking mail.
2. Add the sending domain, publish the exact DKIM TXT and bounce CNAME records
   shown by Zoho, and wait until the domain is verified.
3. Associate the verified domain and intended sender address with the Agent.
4. Generate a send-mail token and store it only as `ZEPTOMAIL_TOKEN` on admin.
5. Set `ZEPTOMAIL_SENDER_ADDRESS` to that enabled sender and
   `ADMIN_NOTIFICATION_EMAIL` to the Preview test recipient. Optionally set
   `GUEST_SUPPORT_EMAIL`; it defaults to `hello@noirhaus.in` and must use a
   domain verified in the same Agent. Guest replies route to this address.
6. Send a test through the durable outbox and verify guest plus admin delivery,
   DKIM alignment, links, and that no secret or internal identifier is exposed.

Mail is sent only by the worker after durable booking state changes. A mail
provider failure does not undo a confirmed booking; it leaves a retryable outbox
item and a visible operations failure.

## 7. Cron and health monitoring

On Vercel Hobby, store `noir_booking_worker_url` and
`noir_booking_cron_secret` in Supabase Vault, then run
`ops/setup-supabase-booking-worker.sql` in Supabase SQL Editor. This installs a
one-minute `pg_cron` job that calls the existing authenticated endpoint through
`pg_net`. An always-on external host running `ops/trigger-booking-jobs.sh`
remains a supported alternative. Do not use a sleeping hobby instance as the
scheduler.

Monitor:

- `GET /api/health` every minute from outside Vercel;
- alert after two consecutive non-`200` responses or when
  `bookingWorker=stale` for more than three minutes;
- alert immediately when `bookingWorker=degraded`; the latest bounded worker
  batch had failures or a terminal mail/refund item needs attention;
- `/var/log/haven-booking-jobs.log` for transport/HTTP failures;
- admin `/bookings` for payment/refund/outbox failures and collision alerts;
- Razorpay webhook delivery failures and ZeptoMail bounces.

The health response is deliberately coarse. Never add guest data, secret names,
provider payloads, signatures, or database details to it or to cron logs.

## 8. Firewall and request limits

Configure Vercel Firewall rules in log-only mode first, observe at least ten
minutes, then change the action to HTTP `429`:

- Public `/api/booking/availability`: 60 requests per client IP per minute.
- Public `/api/booking/create`: 10 requests per client IP per 10 minutes.
- Public `/api/booking/status/*`: 120 requests per client IP per 10 minutes.
- Public `/api/booking/reconcile/*`: 20 requests per client IP per 10 minutes.
- Admin `/api/internal/v1/*`: allow only the public deployment egress path when
  stable IP controls are available; otherwise apply 300 requests per source IP
  per minute in addition to HMAC, nonce, timestamp, and per-key controls.

Do not challenge Razorpay webhook traffic. Verify the signature on every event
and, where the hosting tier permits, allow Razorpay's documented webhook IPs.
All public and internal JSON requests remain subject to the application body-size
limits.

## 9. Preview acceptance

Record the time, booking reference, room, and outcome for each case without
copying guest PII into the release log.

1. Public search returns a server-computed eight-room quote.
2. Create shows one amber ten-minute hold in Master Schedule and `/bookings`.
3. Test payment confirms the booking, keeps the immutable nightly price snapshot,
   creates the linked direct reservation, and exposes a busy outbound iCal event.
4. Guest and admin emails are delivered once.
5. Closing Checkout with no payment reconciles immediately, releases the hold,
   and permits the nights to be claimed again.
6. A network ambiguity remains pending until webhook/worker reconciliation; the
   browser never labels it failed merely because the request was lost.
7. An untouched hold expires after ten minutes, reconciles Razorpay first, then
   releases and permits the nights to be claimed again.
8. Abandon an order creation after an ambiguous provider response. The one-minute
   worker must recover the order by its deterministic receipt and attach it, or
   release the hold after expiry only when a successful lookup proves no order
   exists. A provider lookup outage must retain inventory and retry.
9. Repeating a create call with the same live idempotency UUID returns the same
   result; a live processing lease returns `202` plus `Retry-After`; an expired
   tombstone returns `409` until the guest explicitly submits a new UUID.
10. Replaying a nonce or webhook event ID has no duplicate effect.
11. Import a genuine colliding Airbnb reservation. Airbnb wins: website booking
    becomes `cancelled` with `airbnb_collision`, active nights release, a full
    refund begins, the first email says refund pending, the processed email is
    sent only after provider confirmation, and admin receives an alert.
12. Force eight consecutive ZeptoMail failures. The outbox becomes terminal
    `failed`, a `notification_delivery_failed` booking event appears, and health
    stays degraded until operations resolves it.
13. Manual create/edit/archive and normal Airbnb import still pass under enforced
    inventory.

Seeing the website-created busy event reach the matching Airbnb calendar is the
cross-system acceptance result; record Airbnb's observed refresh time.

## 10. Rollback order

For an incident:

1. Set admin `PUBLIC_BOOKING_ENABLED=false` and redeploy. This fails closed for
   new availability/booking calls without interrupting existing reconciliation.
2. Keep the booking worker and Razorpay webhook online until every existing
   payment/refund/outbox item is terminal.
3. If the public deployment itself is faulty, roll it back to the last known
   release or replace its admin origin with a disabled admin Preview.
4. If inventory enforcement regresses existing manual/iCal flows, set
   `INVENTORY_LEDGER_MODE=shadow`, redeploy admin, and investigate mismatches.
5. Rotate the HMAC pair and Razorpay webhook secret if compromise is suspected.
6. Restore the database backup or use the reviewed rollback migration only after
   durable booking/payment work is reconciled and an explicit destructive-change
   approval is recorded.

Do not switch Razorpay to Live Mode or set production public booking to `true`
as part of this Test Mode runbook.
