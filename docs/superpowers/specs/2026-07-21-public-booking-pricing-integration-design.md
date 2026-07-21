# Public Booking, Pricing, and Payment Integration Design

**Date:** 2026-07-21

**Status:** Approved and locked for implementation

**Admin repository:** `/Users/retyush/airbnb-operations-calendar`

**Public website repository:** `/Users/retyush/Downloads/webzip_1783892501_single/.worktrees/noir-haus-ui-parity`

## 1. Objective

Connect the separate Noir Haus public website to the existing operations admin so guests can check availability, receive authoritative nightly prices, hold a room for ten minutes, pay through Razorpay, and receive Zoho transactional email. Add admin pricing and booking views without rebuilding the working calendar, Airbnb iCal synchronization, or sanitized public-page markup.

The admin application and its existing Supabase-managed Postgres database are the sole owner of inventory, guest records, bookings, holds, payments, refunds, prices, and calendar blocks. The public website remains a separate deployment and keeps no booking database.

Razorpay Test Mode is the delivery target for this milestone. Enabling Live Mode is a separate launch action.

## 2. Current System Constraints

The admin application is a Next.js App Router application deployed on Vercel with Supabase Auth and Postgres. It already provides:

- authenticated property and listing management;
- inbound Airbnb iCal synchronization into `external_calendar_events`;
- manual direct reservations and blocks in `local_calendar_entries`;
- outbound iCal feeds generated from active local entries with `sync_to_airbnb = true`;
- the Master Schedule, cleaning workflow, audit history, and protected cron sync.

The existing manual-entry overlap check is not a single concurrency-safe transaction, and the inbound sync does not share a property-level inventory lock with manual writes. These paths must be moved behind one shared inventory service before public booking is enabled.

Airbnb integration is polling-based iCal. Confirmed local blocks become available in the outbound feed immediately, but Airbnb decides when to read the feed. The application cannot force an instant Airbnb refresh.

The public website is a separately deployable Next.js application serving sanitized, locally resolved HTML routes. Its visible structure, header, room photography, horizontal room rail, and page-specific styling remain intact. Booking behavior is added through same-origin website endpoints and minimal client code.

## 3. Architecture Decision

### 3.1 Selected architecture

```text
Guest browser
  -> Public website server
      -> HMAC-signed private admin API
          -> Admin domain services
              -> One Supabase/Postgres database
              -> Razorpay
              -> Zoho ZeptoMail
              -> Existing Airbnb iCal integration
```

The admin backend owns the complete booking lifecycle. The public website acts as a thin server-side proxy and presentation layer.

### 3.2 Alternatives rejected

1. **Admin inventory gateway plus a separate website booking database.** This preserves a data boundary but introduces a distributed booking/payment saga and two durable stores.
2. **Website-owned holds with confirmed blocks pushed to admin.** This cannot atomically serialize website holds with manual admin writes and Airbnb imports.
3. **Direct browser access to admin or Supabase.** This would expose a broader public attack surface and cannot keep internal service credentials secret.

The selected single-database design provides the strongest internal consistency while preserving separate public and admin deployments.

## 4. Trust Boundary and Signed Internal API

The guest browser communicates only with same-origin public website routes. It never receives a Supabase service key, database URL, HMAC secret, Razorpay secret, Zoho token, or admin session.

The website server calls private admin routes over HTTPS. Each request includes:

- key ID;
- Unix timestamp;
- cryptographically random nonce;
- idempotency key for side-effecting booking requests;
- SHA-256 body hash;
- HMAC-SHA256 signature over the HTTP method, canonical path and query, timestamp, nonce, and body hash.

The admin performs constant-time signature comparison, accepts timestamps only within a plus-or-minus five-minute window, rejects unknown key IDs, and validates a strict allowlist schema before executing domain code. Current and previous key IDs may coexist only during deliberate secret rotation.

`api_request_nonces` persists every accepted nonce with its key ID, request hash, receipt time, and expiry. The nonce is atomically inserted under a unique constraint. A duplicate insert rejects the request. Nonces are retained for ten minutes and then removed by scheduled cleanup, which covers the complete clock-skew acceptance window.

Admin pricing mutation routes are not part of the signed service API. They continue to require an authenticated Supabase admin session and property membership. The internal service principal can quote, create, inspect, and reconcile bookings, but cannot change rates.

Both deployments apply request-size limits and rate limits. The public deployment limits requests by client IP before proxying; the admin limits by HMAC key ID and endpoint. Security logs exclude guest PII, request bodies, signatures, and secrets.

## 5. Internal and Admin API Surface

The private admin API is versioned under `/api/internal/v1`:

- `POST /availability` accepts a `public_room_slug`, check-in, checkout, and guest count. It returns availability plus an authoritative nightly price breakdown.
- `POST /bookings` accepts the same stay fields, guest name, guest email, guest phone, guest count, and an `Idempotency-Key` header. It never accepts an amount, currency, discount, fee, or price.
- `GET /bookings/:publicReference` returns the coarse state required by the public confirmation page.
- `POST /bookings/:publicReference/reconcile` verifies the current Razorpay order/payment state after a browser callback, checkout dismissal, ambiguous network result, or hold-expiry check.

Razorpay sends signed webhooks directly to `/api/webhooks/razorpay`. The raw request body is preserved for signature verification. Webhook handling never depends on the guest browser.

Authenticated admin routes cover pricing mutations and booking reads. They use the existing session and property-authorization conventions rather than the HMAC service principal.

## 6. Data Model

All new tables live in the existing admin database. Anonymous and ordinary authenticated clients receive no direct table grants; access is through server-side domain services and narrowly scoped admin reads.

### 6.1 `property_rates`

One row per bookable property:

- `property_id` primary key and foreign key;
- unique `public_room_slug`, matching a sanitized website room slug;
- `max_guests`;
- `weekday_price_paise`;
- `weekend_price_paise`;
- fixed `currency = 'INR'`;
- `booking_enabled`;
- `updated_by`, `created_at`, and `updated_at`.

Both price fields are positive integer paise. Friday and Saturday stay nights use the weekend price. A property without a complete, enabled rate row is not publicly bookable and is never quoted at zero.

### 6.2 `property_rate_overrides`

- `id`;
- `property_id`;
- `stay_date`;
- positive `price_paise`;
- `updated_by`, `created_at`, and `updated_at`;
- unique `(property_id, stay_date)`.

Pricing precedence for every stay night is:

1. date-specific override;
2. Friday/Saturday weekend price;
3. weekday price.

The charged total is the sum of the nightly snapshot. This milestone adds no coupon, tax, service-fee, partial-payment, or dynamic-demand engine.

### 6.3 `bookings`

Stores:

- internal UUID and non-sequential public reference;
- property ID;
- guest name, email, phone, and guest count;
- check-in and checkout, with checkout treated as the exclusive end date;
- lifecycle status: `processing`, `held`, `payment_pending`, `confirmed`, `payment_failed`, `expired`, or `cancelled`;
- hold expiry;
- immutable amount in paise and currency;
- Razorpay order and payment identifiers;
- cancellation reason, including `airbnb_collision`;
- separate refund status: `not_required`, `pending`, `processed`, or `failed`;
- Razorpay refund identifier when present;
- confirmation/cancellation timestamps and audit timestamps.

No self-service guest cancellation or booking modification exists in this milestone.

### 6.4 `booking_night_prices`

One immutable row per booking stay night:

- booking ID;
- stay date;
- price in paise;
- source: `override`, `weekend`, or `weekday`;
- unique `(booking_id, stay_date)`.

Later rate changes never alter an existing booking total or nightly breakdown.

### 6.5 `inventory_nights`

One inventory claim per property/night/source:

- property ID and stay date;
- source kind: website hold, website booking, manual local entry, Airbnb reservation, Airbnb unavailable, or Airbnb unknown;
- source identifier and the applicable typed foreign key;
- status: `active` or `released`;
- optional expiry for website holds;
- release reason and release timestamp;
- audit timestamps.

The concurrency guard is a partial unique index:

```sql
create unique index inventory_nights_one_active_owner
  on public.inventory_nights (property_id, stay_date)
  where status = 'active';
```

Released rows remain as audit history and do not prevent a future claim for the same night.

### 6.6 `booking_attempts`

Stores the website-generated idempotency key, canonical request hash, booking ID, attempt state, durable progress step, lease token, `lease_expires_at`, response replay deadline, terminal HTTP status/response, and timestamps.

- A processing lease is stale after 60 seconds without renewal.
- Initial acquisition and stale takeover use one atomic conditional insert/update. There is no check-then-write lease acquisition.
- A concurrent request seeing a live lease receives `202 Processing` and `Retry-After`.
- A stale lease resumes by reconciling stored booking, hold, Razorpay receipt/order, and payment identifiers. It does not rerun blindly from the first step.
- Retryable failures resume from the last durable progress step.
- Terminal success and deterministic failures such as room unavailability replay for 30 minutes.
- After the replay window, the same key returns `409 IDEMPOTENCY_KEY_EXPIRED` and is never silently considered a new request.
- A new intentional checkout attempt requires a new UUID.
- The large cached response is cleared after the replay window, but a compact tombstone is retained permanently. No TTL ever makes a used key fresh again.

### 6.7 Payment, notification, and audit tables

- `payment_events` stores the unique Razorpay event ID, event type, related booking/payment/refund, processing state, and timestamps. The unique event ID makes webhook retries harmless.
- `payment_jobs` durably represents outbound order-recovery and refund work, including an idempotency identity, lease, attempts, next retry, provider ID, and terminal result.
- `notification_outbox` stores guest/admin Zoho ZeptoMail messages, template identity, deduplication key, delivery state, attempts, next retry, and provider message ID.
- `booking_events` records status transitions and operational/security reasons without storing secrets.

### 6.8 Existing-table integration

A confirmed website booking creates or links one `local_calendar_entries` direct reservation with `sync_to_airbnb = true`, a website booking source, and no guest PII in its outbound iCal representation. The migration adds a nullable booking foreign key and permits `created_by` to be null only when that booking foreign key is present. Manual admin entries still require authenticated `created_by` attribution.

Archiving or cancelling the website booking archives its linked local entry. Temporary website holds exist only in `inventory_nights`; they are never exported to Airbnb.

## 7. Shared Inventory Service

Every inventory writer must use the same server-only service:

1. Acquire `pg_advisory_xact_lock` using a stable property-scoped key.
2. Release expired holds for that property.
3. Load and validate every requested night against active inventory.
4. Insert, transition, or release all per-night claims under the partial unique index.
5. Commit all requested nights together or none of them.

The following existing and new paths must use this service:

- manual local reservation/block creation, editing, and archive;
- inbound Airbnb iCal reconciliation;
- website hold creation and expiry;
- payment confirmation;
- collision cancellation/refund preparation;
- any future cancellation service.

The advisory lock prevents concurrent writers from doing duplicate work; the partial unique index remains the database-level invariant if a caller is implemented incorrectly.

Before public booking is enabled, existing active local entries and active external events are backfilled into the inventory ledger. Public availability treats every active Airbnb event type as unavailable.

Because raw local and external sources may already overlap, the ledger is a materialized active owner rather than a replacement for those source records. Every source mutation recomputes its affected property nights under the same property lock instead of blindly deleting claims.

Backfill precedence is genuine Airbnb reservation, manual local entry, then Airbnb unavailable/unknown. After public booking is enabled:

- a newly imported genuine Airbnb reservation invokes the collision rule and displaces a website booking or hold;
- a newly imported unavailable/unknown event displaces an unpaid website hold, marks that booking `expired`, and creates an operator alert;
- a newly imported unavailable/unknown event does not automatically cancel an already confirmed website booking because it may be an owner block or a mirror of the outbound local entry; the confirmed website claim stays active and an `audit_log` conflict requires operator review.

When the current winning source is archived, reconciliation promotes the next still-active raw source without incorrectly marking the night available.

## 8. Availability and Authoritative Pricing

Availability requests contain only the `public_room_slug`, check-in, checkout, and guest count. The admin resolves the slug to one enabled property and validates:

- a valid non-empty date range;
- check-in is not in the past in `Asia/Kolkata`;
- guest count is within the property maximum;
- the property is active and publicly bookable;
- every requested night is free after opportunistic expired-hold cleanup.

The admin computes the price exclusively from `property_rate_overrides` and `property_rates`. The response includes the nightly date, amount, source, currency, and total. The website may display this response but cannot submit an amount back as authority.

Booking creation recomputes price and availability inside the locked hold transaction. A previous availability response is informational and cannot reserve a room or freeze a rate.

## 9. Booking and Razorpay Flow

1. The guest searches dates and reviews the admin-computed quote.
2. The website generates one booking-attempt UUID when the guest submits details.
3. The admin atomically claims the idempotency attempt, recomputes the quote, creates the booking and immutable nightly snapshot, claims all stay nights, and sets a ten-minute hold.
4. After that transaction commits, the admin creates a Razorpay Test Mode order for the exact stored amount. The unique Razorpay receipt is derived from the booking public reference.
5. The admin records the Razorpay order ID and returns only the order ID, public Checkout key, amount, currency, booking reference, and hold expiry.
6. If the admin crashes after Razorpay creates the order but before saving its ID, recovery queries Razorpay by the unique receipt and attaches the existing order instead of creating another.
7. The browser opens Razorpay Checkout. Client callbacks may request reconciliation for faster UI, but only verified server state can confirm a booking.
8. Verified `payment.authorized`, `payment.captured`, and `order.paid` events reconcile the booking. An authorized result keeps the inventory hold, marks payment reconciliation pending, and triggers capture/status reconciliation. Only a captured/paid result converts held nights to confirmed nights within the property-locked transaction and creates the linked local direct reservation.
9. Confirmation enqueues guest confirmation and admin-notification emails. Email failure never rolls back a valid booking.

Razorpay partial payments are disabled. The admin verifies the order ID, payment ID, signature, currency, amount, receipt, and stored booking relationship before changing inventory.

## 10. Hold and Release Rules

The hold lasts ten minutes from durable creation.

- A definitive payment failure releases the hold immediately.
- Checkout dismissal triggers immediate server reconciliation.
- If dismissal occurred before any payment attempt and Razorpay confirms no authorized/captured payment, mark the booking `expired` and release immediately.
- A browser network loss or unknown provider result is not treated as failure. The hold remains while the backend reconciles.
- At the ten-minute boundary, the expiry worker performs one final Razorpay order/payment check before releasing.
- If Razorpay reports captured/paid, confirm the booking.
- If Razorpay reports authorized, retain the nights beyond the ordinary expiry while capture/status reconciliation completes; do not release or confirm on an authorization alone.
- If Razorpay confirms no successful payment, mark the booking expired and release the nights.
- A payment that becomes successful only after the booking was expired and its nights released is never allowed to overwrite new inventory. The booking remains `expired`; a separate late-payment workflow records `late_payment_after_expiry`, initiates an idempotent refund, and emails the guest that the late payment is being returned. It does not call the collision cancellation service because the inventory was already released.

Temporary holds appear on the Master Schedule in amber as **Payment in progress**, including their expiry. They are not written to the outbound Airbnb feed.

## 11. Airbnb Collision Rule

Airbnb iCal latency leaves an unavoidable external booking window. A single admin database eliminates internal double-writer races but cannot make Airbnb poll its imported feed instantly.

When inbound sync detects a genuine Airbnb reservation overlapping an active website hold or confirmed website booking, **the Airbnb reservation always wins**.

Under the property lock, the shared collision service:

1. marks the website booking `cancelled` with `cancellation_reason = 'airbnb_collision'`;
2. releases its active `inventory_nights` claims;
3. archives the linked local entry if one exists;
4. claims the nights for the Airbnb reservation;
5. creates a durable refund job when a captured website payment exists;
6. records a prominent admin alert and booking event.

If no payment was captured, the booking requires no refund. If payment was captured, the refund worker initiates one full, source refund and stores its Razorpay ID. A pending refund is not described as completed:

- the first Zoho email says the booking was cancelled and the refund was initiated;
- `refund.processed` changes the refund state to `processed` and sends a separate refund-confirmation email;
- `refund.failed` or a definitive API failure changes the state to `failed`, retains retry/manual-review context, and alerts admin.

This shared cancel/release/refund/email service has no public cancellation endpoint in this milestone. The Airbnb collision path is its only caller.

## 12. Public Website Experience

The sanitized HTML structure and existing visual design remain the source of truth.

- Accommodation and room-page forms call same-origin website endpoints.
- All eight room cards remain in the existing single horizontal scroll rail with localized photos.
- Search results show availability, the nightly breakdown, and total returned by admin.
- Selecting a room collects guest name, email, phone, and guest count.
- Double-clicks reuse the current idempotency key; a deliberate new attempt generates a new UUID.
- Loading, unavailable, expired, payment-failed, and server-unavailable states are accessible and do not leave dead forms.
- The confirmation page polls coarse booking status through the website server and renders `processing`, `confirmed`, `payment_failed`, `expired`, or `cancelled` without trusting browser payment state.

The website contains no admin pricing controls and never calls admin directly from client JavaScript.

## 13. Admin Experience

### 13.1 Pricing page

Add `/pricing` using the established Master Schedule visual language:

- one property per row;
- sticky property identity column;
- authenticated weekday and Friday/Saturday base-price controls per property;
- date columns that show the effective price;
- cell interaction to create, edit, or clear a date override;
- visible indication of base versus override source;
- mobile behavior consistent with the existing horizontally scrolling schedule;
- audit entry for every mutation.

Only property-authorized admin users may read or write private pricing controls.

### 13.2 Bookings page

Add `/bookings` with search/list and detail views for:

- guest and stay details;
- nightly price snapshot and total;
- booking, payment, and refund states;
- Razorpay order/payment/refund references;
- email delivery state;
- lifecycle/audit events.

No cancellation action is exposed in this milestone.

### 13.3 Master Schedule

- active website holds: amber **Payment in progress**;
- confirmed website bookings: direct reservations;
- collisions/refund failures: prominent operational alert;
- released/expired holds: absent from active occupancy but preserved in audit history.

## 14. Failure Handling and Recovery

- Admin or database unavailable: the website displays temporary unavailability and creates no payment order.
- Definitive Razorpay order-creation failure: release the hold immediately.
- Ambiguous Razorpay timeout: keep the hold and recover by unique receipt before retrying.
- Duplicate webhook: return success after reading the existing `payment_events` result.
- Zoho failure: keep the valid booking, retry from `notification_outbox`, and alert after repeated failure.
- Refund API ambiguity: query existing refund/payment state before retrying; never assume failure merely because the response was lost.
- Invalid HMAC, stale timestamp, replayed nonce, changed idempotency payload, or forbidden field: reject without domain side effects and emit a redacted security event.
- Lease owner crash: after 60 seconds, an atomic takeover resumes from the last durable step.
- Cleanup worker delay: every inventory transaction independently releases expired holds before checking availability.

Provider calls and database state changes form resumable sagas. No database transaction remains open across a Razorpay or Zoho network call.

## 15. Email

Use Zoho ZeptoMail for transactional delivery. Email is created only by admin backend services and sent through the durable outbox.

Templates in scope:

- guest booking confirmation;
- admin new-booking notification;
- guest Airbnb-collision cancellation when no refund is required;
- guest Airbnb-collision cancellation and refund-initiated notice;
- guest refund-processed confirmation;
- guest late-payment refund-initiated notice;
- admin collision/refund-failure alert.

Messages use stored immutable booking and price data. Provider tokens never reach the public deployment or browser.

## 16. Security and Operations

Production secrets are stored only in Vercel secret stores:

- current and rotation HMAC key IDs/secrets on both server deployments;
- Razorpay Test Mode key ID and secret;
- Razorpay webhook secret;
- Zoho ZeptoMail token and verified sender;
- booking-admin notification address;
- public website and admin service URLs.

Managed Vercel and Supabase hosts provide synchronized clocks; the admin records observed drift and rejects signed requests outside the five-minute window.

Existing `/api/health` monitoring is extended with booking-dependency readiness that reveals no secrets or customer data. External monitoring covers both deployments. Alerts cover repeated webhook, refund, email, inventory-shadow, and clock-drift failures. Database backups and migration rollback scripts are required before production migration.

Guest PII is excluded from outbound iCal, application logs, analytics, and security-event payloads. Admin reads follow existing property membership. Public signup remains disabled.

## 17. Testing Requirements

### 17.1 Unit and contract tests

- pricing precedence and Friday/Saturday classification;
- immutable nightly snapshots after rate edits;
- property/guest/date validation;
- HMAC canonicalization, known vectors, constant-time validation path, clock drift, nonce replay, body/path tampering, and key rotation;
- strict internal request/response schemas proving amount fields are rejected;
- idempotency hashing, terminal replay, tombstone rejection, atomic live lease behavior, 60-second stale takeover, and durable-step recovery;
- Razorpay and Zoho adapter error classification;
- hold-expiry and checkout-dismissal rules;
- late-payment-after-expiry refund handling;
- collision state transitions and two-stage refund email semantics.

### 17.2 Database and concurrency tests

- partial active-night uniqueness;
- released night reclamation;
- all-or-nothing multi-night claim;
- concurrent website holds for the same room/dates;
- concurrent manual entry and website hold;
- concurrent inbound Airbnb sync and website confirmation;
- expired-hold cleanup under lock;
- idempotent booking, confirmation, release, collision, refund, and notification jobs;
- migration backfill parity with existing local/external availability.

### 17.3 Existing admin regression tests

- manual block/direct reservation create, edit, archive, and overlap errors;
- inbound iCal create/update/archive/history retention;
- outbound feed content and token behavior;
- calendar/vacancy summaries;
- cleaning queue derivation and Today workflow;
- private notes and revenue export behavior;
- authentication and property authorization.

### 17.4 Browser and provider tests

- public availability, room selection, guest form, Checkout launch, confirmation polling, failure, expiry, and cancellation states;
- horizontal eight-room rail and existing static-page visual behavior;
- admin pricing and booking pages on desktop/mobile;
- Master Schedule hold/confirmed/collision states;
- Razorpay Test Mode payment, webhook retry, modal dismissal, failed payment, late authorization, and refund events;
- Zoho outbox delivery and retry using a non-production recipient configuration.

## 18. Staged Rollout

1. Add migrations, rollback SQL, services, and backfill tooling with public booking disabled.
2. Backfill `inventory_nights` from current active local entries and external events.
3. Run manual and iCal writers in shadow comparison mode. Continue using existing availability behavior while logging every ledger mismatch.
4. Resolve all mismatches and pass dedicated manual/iCal regression and concurrency tests.
5. Enable the shared inventory ledger for existing admin writers only.
6. Deploy `/pricing` and `/bookings`; configure all eight properties, slugs, guest limits, and rates.
7. Deploy signed internal APIs, Razorpay Test Mode, Zoho outbox, monitoring, and webhook handling with public booking still disabled.
8. Wire the separate public website to its same-origin proxy routes.
9. Run the end-to-end acceptance flow: public search -> authoritative quote -> hold -> Razorpay Test Mode payment -> admin confirmation -> Master Schedule -> Zoho email -> outbound Airbnb feed.
10. Run collision/refund, ambiguous-network, expired-hold, and provider-retry acceptance flows.
11. Enable the public-booking feature flag only after shadow parity, full admin regression, production builds, and health monitoring pass.
12. Keep Razorpay in Test Mode until a separate live-launch review rotates in live credentials and verifies live webhooks.

The migration and manual/iCal refactor are deliberately staged ahead of public booking because they carry the highest regression risk to the existing production admin.

## 19. Acceptance Criteria

The milestone is complete when:

- all eight website room slugs map to enabled admin properties with weekday, Friday/Saturday, and optional date-override pricing;
- website requests cannot provide or modify a charge amount;
- one active claim per property/night is enforced under concurrent writers;
- a booking creates a ten-minute admin-visible hold and one Razorpay Test Mode order;
- confirmed payment produces one confirmed booking, linked direct reservation, outbound busy feed entry, guest confirmation, and admin notification;
- closing Checkout or losing the browser network follows verified hold/release rules without false failure;
- released nights can be booked again while audit history remains;
- a genuine Airbnb reservation collision always wins and produces cancellation, inventory transfer, refund handling, correct staged email, and admin alert;
- signed API replay, nonce replay, modified payloads, stale clocks, and duplicate attempts cannot duplicate side effects;
- existing manual block, iCal sync/export, calendar, cleaning, and revenue behavior passes regression testing;
- both deployments pass lint, typecheck, unit/integration tests, production builds, browser tests, and monitored Test Mode smoke tests.

## 20. Out of Scope

- Razorpay Live Mode launch;
- self-service guest cancellation or modification;
- admin-initiated cancellation UI;
- coupons, taxes, service fees, partial payments, deposits, or demand pricing;
- an instantaneous Airbnb/channel-manager API;
- a second payment gateway;
- SMS or WhatsApp notifications;
- structural redesign of sanitized public pages;
- rewriting existing admin calendar or cleaning workflows outside the shared inventory integration.
