# Checkout Abandonment Recovery Design

Date: 2026-07-26

## Objective

Make an abandoned Razorpay Checkout feel recoverable without weakening Noir Haus inventory or payment safety.

The final behavior is:

- Closing Razorpay with its X/Cancel control triggers an immediate server-side Razorpay check.
- When Razorpay definitively reports no payment attempt or a failed payment, Noir Haus releases the room and shows a dedicated payment-cancelled result.
- Closing the entire browser tab or window preserves the temporary hold because the server cannot safely infer payment failure from a disconnected client.
- The browser that created the hold can return and resume the same Razorpay order instead of receiving a generic unavailable message or creating another hold.
- Uncertain payment states retain the hold for the existing ten-minute safety window.

## Definitions

- **Modal dismissal:** Razorpay Standard Checkout invokes `modal.ondismiss` while the Noir Haus page remains open.
- **Page abandonment:** The guest closes or navigates away from the entire Noir Haus tab/window.
- **Resume owner:** The browser holding the opaque resume token issued for that booking. Identity is not inferred from name, email, phone number, IP address, or cookies alone.
- **Definitive non-payment:** Razorpay independently reports either no payment attempts for the order or only failed attempts.
- **Uncertain payment:** Razorpay reports an authorised payment, an unknown state, a timeout, an invalid response, or is unavailable.

## Non-goals

- Do not release inventory solely from `beforeunload`, `pagehide`, `sendBeacon`, a missing heartbeat, or any other client-only signal.
- Do not allow the same email address or phone number to bypass an active hold.
- Do not create a second booking or Razorpay order when the existing attempt can be resumed.
- Do not shorten the global ten-minute hold in this change.
- Do not confirm a booking from a client callback or an authorised-but-not-captured payment.

## Architecture

This change spans both repositories:

- `airbnb-operations-calendar` remains the authoritative booking, inventory, and Razorpay service.
- `noirhaus-public` remains the public UI and signed proxy to the authoritative service.

The admin backend issues a cryptographically random opaque resume token after a booking hold and Razorpay order are durably attached. A SHA-256 lookup hash and authenticated ciphertext are stored; the raw token is not. The raw token is returned to the public site and stored in browser local storage with only non-sensitive attempt metadata.

The token is required for public client reconciliation, cancellation, and order resumption. Internal scheduled jobs and signed Razorpay webhooks do not require it.

## Data Model

Add `public.booking_resume_tokens`:

- `booking_id uuid primary key references public.bookings(id)`
- `token_hash text not null unique`
- `token_ciphertext text not null`
- `expires_at timestamptz not null`
- `revoked_at timestamptz null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

The raw token is generated from at least 32 random bytes and encoded for URL-safe transport. It is never logged or stored in plaintext. `token_hash` supports lookup and validation; `token_ciphertext` is encrypted with AES-256-GCM using a dedicated `BOOKING_RESUME_ENCRYPTION_KEY` so an idempotent replay can return the original token. Authentication-tag failure is terminal and must not fall back to minting another token.

The token expiry matches the booking hold expiry. It is revoked when the booking becomes confirmed, payment_failed, expired, or cancelled.

## Backend API

### Create booking

The existing create-booking response gains:

- `resumeToken`

The token is issued only after:

1. The booking and immutable nightly prices exist.
2. Inventory is held.
3. A valid Razorpay order is attached to that booking.

The existing `booking_attempts.terminal_response` stores only the token-free Checkout response. Initial and idempotent responses load and decrypt the same token from `booking_resume_tokens` immediately before returning it to the signed public proxy. A replay must not mint or rotate a token.

### Resume booking

Add:

`POST /api/internal/v1/bookings/{reference}/resume`

Request:

```json
{ "resumeToken": "opaque-token" }
```

Behavior:

1. Authenticate the public-site proxy request with the existing internal API HMAC.
2. Validate the reference, token hash, token expiry, and non-revoked state.
3. Load the booking and its attached Razorpay order.
4. Query Razorpay for payments before returning Checkout data.
5. If captured, run the existing amount-integrity reconciliation and return confirmed status.
6. If authorised, return payment_pending and do not open another Checkout.
7. If definitively failed, release inventory, revoke the token, and return payment_failed.
8. If no attempt exists and the hold remains active, return the original order ID, Razorpay key ID, booking reference, and hold expiry.
9. If provider state is uncertain, return a retryable status and retain the hold.

The endpoint never creates a new booking, hold, or Razorpay order.

### Cancel/dismiss attempt

Extend the existing reconcile request to require:

```json
{
  "trigger": "checkout_dismissed",
  "resumeToken": "opaque-token"
}
```

For a public client callback, require the same token. Webhook and worker reconciliation remain server-authenticated and tokenless.

On dismissal:

- No payment attempts: set booking to expired, release `website_hold` inventory, revoke token.
- Only failed attempts: set booking to payment_failed, release inventory, revoke token.
- Captured: confirm only through the existing captured-payment amount-integrity path.
- Authorised or uncertain: retain the hold and return payment_pending/retryable status.

The backend—not the browser—decides whether cancellation is definitive.

## Public-Site State

Store one versioned local-storage record per active booking attempt:

```json
{
  "version": 1,
  "bookingReference": "NH-...",
  "resumeToken": "opaque-token",
  "orderId": "order_...",
  "publicRoomSlug": "emerald-suite",
  "checkin": "2026-08-10",
  "checkout": "2026-08-11",
  "guests": 2,
  "holdExpiresAt": "2026-08-10T10:10:00.000Z"
}
```

Do not store guest name, email, phone, country, special requests, prices, key secrets, or payment details.

Clear the record when:

- The backend confirms payment.
- The backend definitively releases the hold.
- The backend reports cancellation.
- The token expires.
- The user explicitly discards a terminal record.

## User Flows

### Razorpay X/Cancel

1. Razorpay calls `modal.ondismiss`.
2. The page displays “Checking payment status…”.
3. The public proxy sends the resume token with `checkout_dismissed`.
4. If the backend verifies non-payment, clear local recovery state and navigate to a dedicated payment-cancelled result.
5. The result states that no payment was taken and the room was released.
6. The guest can immediately start any new booking.

Do not label a user dismissal as “Payment failed” unless Razorpay reports an actual failed attempt. Use “Payment cancelled” when there was no attempt.

### Entire tab/window closed

No release request is trusted or required from the closing page.

When the guest returns:

1. Read the active local recovery record.
2. Call the resume endpoint.
3. If resumable, show “Resume secure payment” with the room, dates, and hold-expiry countdown.
4. Opening Checkout uses the original Razorpay order.
5. If the guest prefers to abandon it, offer “Cancel this attempt”; this calls the same provider-verified dismissal path.
6. After verified cancellation, clear local state and allow a fresh booking.

If another browser without the token requests the same room and dates while the hold is active, availability remains blocked.

### Uncertain provider state

Display:

> We are checking your payment status. Your room remains temporarily held to prevent a duplicate charge or double booking.

Poll the booking status with bounded backoff. Do not create another attempt or release inventory until Razorpay provides definitive evidence or the expiry worker completes its final provider check.

## Payment and Inventory Safety

- Checkout continues to receive only `order_id`, never a client-controlled amount.
- Captured payment confirmation continues to enforce the payment/order/booking/nightly-price amount invariant.
- Late captures after a released hold continue through the existing late-payment refund workflow.
- Resume and dismissal operations are booking-scoped and token-scoped.
- The same Razorpay payment or order cannot confirm another booking.
- All state-changing operations remain idempotent.
- Razorpay webhooks remain the asynchronous source of truth; immediate API fetches provide user-facing responsiveness.

## Error Handling

- Invalid, missing, expired, or revoked token: return 401/409 without revealing booking details.
- Booking already confirmed: return confirmed status and clear local recovery state.
- Booking already terminal: return the terminal state and clear local recovery state.
- Razorpay timeout, rate limit, 5xx, or malformed response: retain hold and return retryable status.
- Public proxy timeout: preserve local recovery state and direct the guest to status/resume rather than a new booking.
- Local storage unavailable: the current ten-minute expiry remains the safe fallback.

## UI Copy

Verified modal cancellation:

> Payment cancelled
>
> No payment was taken. Your temporary room hold has been released, and you may start a new booking.

Resumable attempt:

> Your room is still on hold
>
> Resume secure payment before the hold expires, or cancel this attempt to release the room.

Uncertain state:

> Checking payment status
>
> Your room remains temporarily held while we verify the payment with Razorpay.

## Testing

### Admin database-backed tests

- A valid token resumes the original booking and original Razorpay order.
- Resume never creates another booking, order, nightly price, or inventory claim.
- Invalid, expired, and revoked tokens are rejected.
- Modal dismissal with no provider payment releases inventory immediately and revokes the token.
- A fresh booking for the same dates succeeds immediately after verified release.
- Failed payment releases inventory.
- Authorised payment retains inventory as payment_pending.
- Captured payment confirms only after all existing amount-integrity checks pass.
- Provider ambiguity retains inventory.
- Late capture after release does not reclaim inventory and enqueues one refund.
- Idempotent create replay returns the original resume token.

### Public route and browser tests

- Create response stores only the approved non-sensitive recovery fields.
- Razorpay modal dismissal sends the token and displays the verified cancellation page.
- A refresh or simulated tab close followed by return resumes the same order.
- “Cancel this attempt” releases only after a definitive backend result.
- Terminal statuses clear local recovery state.
- Uncertain results preserve recovery state and never start another booking.
- A browser without the token continues to see active inventory as unavailable.
- Mobile, tablet, and desktop booking layouts expose a single resume/cancel action set.

## Rollout

1. Generate a 32-byte `BOOKING_RESUME_ENCRYPTION_KEY` and add it to admin Preview and Production without exposing it to browser code.
2. Apply the database migration and deploy the admin backend to Preview.
3. Deploy the public recovery UI and proxies to Preview.
4. Run database-backed payment tests and public Playwright tests.
5. In Razorpay Test Mode, verify modal dismissal, tab abandonment/return, failed payment, successful capture, provider timeout simulation, and ten-minute expiry.
6. Confirm no resume token or guest PII appears in logs, analytics, URLs, or HTML.
7. Promote the admin backend first, then the public site.
8. Verify production health, booking worker freshness, webhook delivery, immediate modal cancellation, and same-browser resumption.

## Acceptance Criteria

- A verified modal cancellation releases the room within seconds and shows a dedicated cancellation result.
- Closing the whole tab does not blindly release inventory.
- Returning from the same browser resumes the original hold and Razorpay order.
- The guest can provider-verify cancellation, release the hold, and then create a fresh booking.
- A different browser cannot bypass the active hold.
- No client-only signal can release inventory.
- Existing capture-only confirmation and amount-integrity guarantees remain intact.
- The ten-minute expiry remains the safe fallback for abandoned or uncertain attempts.
