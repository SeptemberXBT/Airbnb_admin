# Professional Guest Booking Confirmation Email Design

**Date:** 2026-07-23  
**Status:** Approved for implementation planning

## Objective

Replace the current bare guest booking-confirmation message with a polished Noir Haus transactional email. The email must clearly confirm the reservation and payment, give the guest the essential stay details, and provide a reliable way to contact Noir Haus.

This first version is text-led. It does not include a room image, but its layout will allow an image section to be added later without redesigning the rest of the template.

## Confirmed Decisions

- Use a code-owned, responsive HTML email with a matching plain-text fallback.
- Keep the current ZeptoMail outbox and retry pipeline.
- Send the email only after Razorpay payment capture has been reconciled and the booking has become `confirmed`.
- Use `hello@noirhaus.in` as the guest-support address and Reply-To address for now.
- Omit the physical property address and support phone number until verified values are provided.
- Omit cancellation and refund policy language until the policy is finalized.
- Keep the room-photo area out of the rendered version for now; prepare a clean insertion point for a later image-enabled version.
- Do not redesign admin, cancellation, or refund email templates in this work.

## Considered Approaches

### 1. Code-owned responsive template — selected

Create the HTML and plain-text versions in the application and cover them with automated tests. Use conservative email-client-compatible markup, inline styles, escaped dynamic content, and the existing outbox.

This is the recommended approach because the email remains versioned with the booking code, can be tested alongside payment reconciliation, and does not depend on a separately edited ZeptoMail dashboard template.

### 2. ZeptoMail-hosted template

Store the visual template in ZeptoMail and send merge data from the application. This makes visual edits possible outside the codebase but separates the template from application tests, introduces dashboard state that is harder to audit, and makes deployment rollback less deterministic.

### 3. Expanded version of the current generic template

Add more paragraphs and fields to the existing generic `<p>` and `<dl>` output. This is the smallest code change but would not provide the professional hierarchy, mobile behavior, or brand presentation requested.

## Email Content and Hierarchy

### Envelope and preview

- **From name:** Noir Haus
- **Reply-To:** `hello@noirhaus.in`
- **Subject:** `Your Noir Haus booking is confirmed — {bookingReference}`
- **Preheader:** `Your reservation at {propertyName} is confirmed for {checkinDate} to {checkoutDate}.`

The configured ZeptoMail sender address remains unchanged. Reply-To is separate so guest replies go to the support inbox.

### HTML body

The email uses a centered, single-column card with a maximum width of approximately 640 pixels. It uses tables and inline styles for broad email-client compatibility, system fonts, generous spacing, a warm neutral background, and Noir Haus brand colors. No JavaScript, remote fonts, or decorative external dependencies are used.

Content order:

1. **Noir Haus wordmark header** — text-based in this version.
2. **Confirmed status** — a restrained confirmation label followed by “Your stay is confirmed.”
3. **Personal greeting** — addresses the guest by name and confirms that payment was received and the reservation is secured.
4. **Stay summary** — room or suite name, guest count, check-in date and time, and check-out date and time.
5. **Payment receipt** — `Paid` status, total paid in INR, Razorpay payment reference, and Noir Haus booking reference.
6. **Arrival note** — asks the guest to keep the booking reference and contact Noir Haus if arrival details change or assistance is needed. It must not promise a specific access or check-in procedure that operations has not approved.
7. **Support block** — a mail link to `hello@noirhaus.in`.
8. **Footer** — identifies the message as a transactional confirmation from Noir Haus and repeats the booking reference.

### Plain-text body

The plain-text version mirrors every material fact from the HTML version in the same order. It includes the confirmation status, guest name, suite, dates and times, guest count, total paid, payment reference, booking reference, and support email. It remains readable without HTML or styling.

## Data Contract

The guest confirmation renderer requires:

- guest name
- property name
- Noir Haus public booking reference
- check-in date
- check-out date
- check-in time
- check-out time
- guest count
- amount paid in paise
- Razorpay payment ID
- support email

Dates are formatted as full guest-friendly dates, for example `Tuesday, 11 August 2026`. Times are formatted as `1:00 PM` and `11:00 AM`. Formatting must be deterministic in the property's operating timezone and must not change with the server's host timezone.

Dynamic content is HTML-escaped before interpolation. The Razorpay key ID, key secret, API token, and other credentials must never appear in either email body.

## Architecture and Boundaries

### Guest confirmation renderer

The professional booking confirmation is a dedicated renderer with a typed input contract. It owns only presentation and formatting. It does not query the database, call ZeptoMail, or change booking state.

The existing generic renderer remains available for admin, cancellation, and refund notifications. This avoids forcing unrelated templates into the richer guest-confirmation data contract.

### Payment reconciliation integration

When a captured Razorpay payment is accepted and the booking transaction changes to `confirmed`, payment reconciliation loads the additional guest count, property check-in/check-out times, and payment ID. It passes these values to the guest renderer and enqueues the result using the existing key:

`booking-confirmed:{bookingId}:guest`

The existing deduplication key guarantees that webhook, client callback, and worker retries cannot create duplicate guest confirmation emails.

### ZeptoMail delivery

The outbox worker continues to send persisted subject, HTML, and text content. The ZeptoMail client adds the configured Reply-To address, defaulting to `hello@noirhaus.in` for this deployment. Sender authentication continues to use the existing verified ZeptoMail sender domain and credentials.

## State and Failure Behavior

- A held, processing, authorized-only, expired, cancelled, or payment-failed booking does not receive the confirmation email.
- A confirmed captured payment enqueues one guest confirmation.
- Email delivery failure does not cancel, refund, or unblock a confirmed booking.
- Temporary ZeptoMail failures use the existing outbox retries and backoff.
- After retry exhaustion, the existing notification failure event remains the admin-visible failure record.
- Payment or email provider credentials are never rendered or logged in template output.
- Missing optional future content, such as a photo, cannot prevent a confirmation from being rendered.

## Testing Strategy

### Template tests

- Assert the exact professional subject and preheader.
- Assert HTML and plain text contain the booking reference, suite, formatted dates and times, guest count, amount, payment ID, and support address.
- Assert guest and property values are safely HTML-escaped.
- Assert secrets and unrelated policy language are absent.
- Assert the HTML contains no room image or external image dependency in this version.
- Assert output is deterministic when the test process runs under a different host timezone.

### Delivery client tests

- Assert ZeptoMail receives the configured Noir Haus sender and `hello@noirhaus.in` Reply-To value.
- Preserve existing provider-error and invalid-response behavior.

### Reconciliation tests

- Assert a captured payment that confirms a booking enqueues the new guest subject, HTML, and text exactly once.
- Assert guest count, property operating times, and payment ID are mapped into the renderer.
- Preserve existing assertions that authorized, failed, expired, and duplicate reconciliation paths do not send an incorrect confirmation.

### Verification

Run the focused email, ZeptoMail, and payment reconciliation tests first, followed by the full lint, typecheck, test, and production build commands.

## Out of Scope

- Room or property photographs
- Physical address and support phone/WhatsApp number
- Cancellation, refund, or no-show policy text
- Redesign of admin, cancellation, refund, or failure notification emails
- PDF invoices or downloadable receipts
- Changes to payment capture, refund behavior, booking inventory, or public checkout UI

## Acceptance Criteria

1. A newly confirmed, captured booking queues exactly one professional guest confirmation email.
2. The email clearly shows who booked, what was booked, the stay dates and times, guest count, total paid, payment reference, and booking reference.
3. Replies route to `hello@noirhaus.in`.
4. HTML is responsive and email-client-compatible, and the plain-text fallback contains the same essential facts.
5. Dynamic values are escaped and no credential or unapproved policy text is exposed.
6. Existing outbox deduplication, retries, booking state, and all unrelated templates continue to work unchanged.
