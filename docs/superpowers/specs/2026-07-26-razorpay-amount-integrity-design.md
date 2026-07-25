# Razorpay Amount Integrity Hardening Design

## Scope

This change closes the two failed findings from the 2026-07-26 payment audit:

1. The public browser must open Razorpay Standard Checkout with the server-created order ID and must not pass `amount` or `currency`.
2. A captured payment must not confirm a booking until provider and database evidence independently prove the amount.

## Captured-payment evidence

Every captured-payment path, whether triggered by a Razorpay webhook, the browser callback, or a worker, will:

1. Resolve the booking by its unique Razorpay order ID.
2. Fetch the Razorpay order through `GET /v1/orders/{order_id}`.
3. Fetch the payments through `GET /v1/orders/{order_id}/payments`; a webhook payment must match a captured provider payment with the same payment ID and amount.
4. Read and sum every immutable `booking_night_prices.price_paise` row for the booking.
5. Require the webhook/provider payment amount, Razorpay order amount, `bookings.amount_paise`, and immutable nightly sum to be identical positive safe integers.
6. Require the order ID, INR currency, and `nh_<booking reference>` receipt to match the booking.

Only verified evidence is passed to the existing captured branch. The final confirmation update remains scoped to the resolved booking and order.

## Integrity failure

An amount, currency, receipt, order, payment, or nightly-snapshot mismatch is terminal for that reconciliation attempt:

- The booking status, payment ID, hold, and inventory remain unchanged.
- A booking event with type `AMOUNT_INTEGRITY_FAILURE` records the four amounts and provider identifiers.
- A matching audit-log record is written.
- An admin email is queued through the existing ZeptoMail notification outbox, deduplicated by booking and payment.
- Any payment-reconciliation job for the booking is marked definitive failure.
- A webhook event is marked `ignored` with `amount_integrity_failure` and acknowledged successfully so Razorpay does not repeatedly deliver the same unsafe event.
- Direct/client or worker reconciliation raises `AMOUNT_INTEGRITY_FAILURE`; workers must not convert it back into a retryable job.

Provider transport failures remain retryable and do not get mislabeled as integrity failures.

## Testing

The public Playwright test will prove that Checkout receives the order ID without amount or currency. Razorpay adapter tests will prove `fetchOrder` uses the exact order endpoint and validates its response.

The database regression test will create a held booking whose `bookings.amount_paise` and provider payment/order are one paise while its immutable nightly rows total a higher amount. It will pass a correctly HMAC-signed captured webhook through the real parser and reconciliation service, then assert:

- the booking is not confirmed;
- the hold remains active;
- the payment event and booking event contain `AMOUNT_INTEGRITY_FAILURE`;
- the admin alert is queued;
- `fetchOrder` and provider payment lookup execute on every attempt;
- changing only the key-ID match cannot bypass provider verification.

