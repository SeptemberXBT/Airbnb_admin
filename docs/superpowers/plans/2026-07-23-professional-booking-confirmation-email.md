# Professional Booking Confirmation Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one polished Noir Haus guest confirmation email, with a plain-text fallback and Reply-To support, after a captured Razorpay payment confirms a booking.

**Architecture:** Add a dedicated pure renderer for the guest confirmation while retaining the generic renderer for admin, cancellation, and refund messages. Enrich the payment reconciliation query with the guest count and property operating times, then enqueue the professional message through the existing deduplicated outbox. Configure the existing ZeptoMail client with a verified-domain Reply-To address resolved from one non-secret environment variable with a safe Noir Haus default.

**Tech Stack:** TypeScript, Next.js, PostgreSQL via `postgres`, Vitest, ZeptoMail REST API, existing payment reconciliation and notification outbox services

---

## File Map

- Create `src/features/email/email-config.ts`: own the default support address and environment resolution.
- Create `src/features/email/booking-confirmation-template.ts`: pure professional guest confirmation renderer and deterministic date/time formatting.
- Create `src/features/email/booking-confirmation-template.test.ts`: content, escaping, formatting, and no-image regression tests.
- Modify `src/features/email/templates.ts`: restrict the generic renderer to non-confirmation templates while retaining the shared template-key union.
- Modify `src/features/email/templates.test.ts`: keep generic coverage for admin, cancellation, and refund templates.
- Modify `src/features/email/zeptomail-client.ts`: add the official `reply_to` payload.
- Modify `src/features/email/zeptomail-client.test.ts`: verify the sender and Reply-To payload.
- Modify `src/features/bookings/job-runner.ts`: pass the resolved support address into the ZeptoMail client.
- Modify `src/features/payments/payment-reconciliation.ts`: load confirmation-only data, render the new message, and preserve generic admin mail.
- Modify `src/features/payments/payment-reconciliation.db.test.ts`: prove professional content is enqueued once after capture.
- Modify `.env.example`: document optional `GUEST_SUPPORT_EMAIL` configuration.
- Modify `docs/booking-test-mode-runbook.md`: document Reply-To setup and verification.

### Task 1: Add the dedicated professional guest renderer

**Files:**
- Create: `src/features/email/email-config.ts`
- Create: `src/features/email/booking-confirmation-template.ts`
- Create: `src/features/email/booking-confirmation-template.test.ts`
- Modify: `src/features/email/templates.ts`
- Modify: `src/features/email/templates.test.ts`

- [ ] **Step 1: Write the failing renderer tests**

Create `src/features/email/booking-confirmation-template.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderBookingConfirmationEmail } from "./booking-confirmation-template";

const booking = {
  guestName: "A & <B>",
  propertyName: "Shade <of> Love",
  bookingReference: "NH-EMAILTEST001",
  checkin: "2026-08-14",
  checkout: "2026-08-16",
  checkinTime: "13:00:00",
  checkoutTime: "11:00:00",
  guestCount: 2,
  amountPaise: 1200000,
  paymentId: "pay_confirmed_123",
  supportEmail: "hello@noirhaus.in",
};

describe("professional booking confirmation email", () => {
  it("renders a complete branded HTML and plain-text confirmation", () => {
    const message = renderBookingConfirmationEmail(booking);

    expect(message.subject).toBe("Your Noir Haus booking is confirmed — NH-EMAILTEST001");
    expect(message.htmlBody).toContain("Your stay is confirmed");
    expect(message.htmlBody).toContain("Friday, 14 August 2026");
    expect(message.htmlBody).toContain("Sunday, 16 August 2026");
    expect(message.htmlBody).toContain("1:00 PM");
    expect(message.htmlBody).toContain("11:00 AM");
    expect(message.htmlBody).toContain("2 guests");
    expect(message.htmlBody).toContain("₹12,000.00");
    expect(message.htmlBody).toContain("pay_confirmed_123");
    expect(message.htmlBody).toContain("mailto:hello@noirhaus.in");
    expect(message.textBody).toContain("BOOKING REFERENCE: NH-EMAILTEST001");
    expect(message.textBody).toContain("PAYMENT STATUS: Paid");
  });

  it("escapes dynamic HTML and remains text-led without external images", () => {
    const message = renderBookingConfirmationEmail(booking);

    expect(message.htmlBody).toContain("A &amp; &lt;B&gt;");
    expect(message.htmlBody).toContain("Shade &lt;of&gt; Love");
    expect(message.htmlBody).not.toContain("A & <B>");
    expect(message.htmlBody).not.toMatch(/<img\b/i);
    expect(message.htmlBody).not.toMatch(/rzp_(?:test|live)_/i);
  });
});
```

- [ ] **Step 2: Run the renderer test and verify the expected failure**

Run:

```bash
npx vitest run src/features/email/booking-confirmation-template.test.ts
```

Expected: FAIL because `./booking-confirmation-template` does not exist.

- [ ] **Step 3: Add support-email configuration**

Create `src/features/email/email-config.ts`:

```ts
export const DEFAULT_GUEST_SUPPORT_EMAIL = "hello@noirhaus.in";

export function resolveGuestSupportEmail(
  environment: { GUEST_SUPPORT_EMAIL?: string } = process.env,
) {
  return environment.GUEST_SUPPORT_EMAIL?.trim() || DEFAULT_GUEST_SUPPORT_EMAIL;
}
```

- [ ] **Step 4: Implement the renderer**

Create `src/features/email/booking-confirmation-template.ts` with this interface and behavior:

```ts
export type BookingConfirmationEmailData = {
  guestName: string;
  propertyName: string;
  bookingReference: string;
  checkin: string;
  checkout: string;
  checkinTime: string;
  checkoutTime: string;
  guestCount: number;
  amountPaise: number;
  paymentId: string;
  supportEmail: string;
};

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function formatStayDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return dateFormatter.format(new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  )));
}

function formatStayTime(value: string) {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = match[2];
  const period = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${minute} ${period}`;
}

function detailRow(label: string, value: string) {
  return `<tr><td style="padding:8px 0;color:#66716d;font-size:13px;line-height:20px;vertical-align:top;width:42%;">${escapeHtml(label)}</td><td style="padding:8px 0;color:#102f2a;font-size:14px;font-weight:600;line-height:20px;vertical-align:top;">${escapeHtml(value)}</td></tr>`;
}

export function renderBookingConfirmationEmail(data: BookingConfirmationEmailData) {
  const checkinDate = formatStayDate(data.checkin);
  const checkoutDate = formatStayDate(data.checkout);
  const checkinTime = formatStayTime(data.checkinTime);
  const checkoutTime = formatStayTime(data.checkoutTime);
  const amount = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(data.amountPaise / 100);
  const guestLabel = `${data.guestCount} ${data.guestCount === 1 ? "guest" : "guests"}`;
  const preheader = `Your reservation at ${data.propertyName} is confirmed for ${checkinDate} to ${checkoutDate}.`;
  const rows = [
    detailRow("Suite", data.propertyName),
    detailRow("Guests", guestLabel),
    detailRow("Check-in", `${checkinDate} · ${checkinTime}`),
    detailRow("Check-out", `${checkoutDate} · ${checkoutTime}`),
  ].join("");
  const receiptRows = [
    detailRow("Payment status", "Paid"),
    detailRow("Total paid", amount),
    detailRow("Payment reference", data.paymentId),
    detailRow("Booking reference", data.bookingReference),
  ].join("");

  const htmlBody = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Booking confirmed</title></head><body style="margin:0;background:#f4f0e9;color:#102f2a;font-family:Arial,Helvetica,sans-serif;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f0e9;"><tr><td align="center" style="padding:28px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-collapse:collapse;"><tr><td style="background:#073e35;padding:28px 36px;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:4px;">NOIR HAUS</td></tr><tr><td style="padding:40px 36px 20px;"><div style="color:#b85b49;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Reservation confirmed</div><h1 style="margin:12px 0 18px;color:#073e35;font-size:32px;line-height:40px;">Your stay is confirmed</h1><p style="margin:0 0 12px;color:#30433f;font-size:16px;line-height:26px;">Dear ${escapeHtml(data.guestName)},</p><p style="margin:0;color:#30433f;font-size:16px;line-height:26px;">Thank you for choosing Noir Haus. We have received your payment and secured your reservation.</p></td></tr><tr><td style="padding:12px 36px 20px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f8f6;border:1px solid #dfe7e3;border-collapse:separate;padding:18px 22px;"><tr><td colspan="2" style="padding:0 0 10px;color:#073e35;font-size:17px;font-weight:700;">Your stay</td></tr>${rows}</table></td></tr><tr><td style="padding:0 36px 20px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;"><tr><td colspan="2" style="padding:12px 0;border-bottom:1px solid #dfe7e3;color:#073e35;font-size:17px;font-weight:700;">Payment receipt</td></tr>${receiptRows}</table></td></tr><tr><td style="padding:4px 36px 36px;"><h2 style="margin:0 0 10px;color:#073e35;font-size:18px;line-height:26px;">Arrival and support</h2><p style="margin:0 0 12px;color:#30433f;font-size:15px;line-height:24px;">Please keep your booking reference handy. If your arrival details change or you need assistance, our team will be happy to help.</p><p style="margin:0;color:#30433f;font-size:15px;line-height:24px;">Email us at <a href="mailto:${escapeHtml(data.supportEmail)}" style="color:#164896;font-weight:700;">${escapeHtml(data.supportEmail)}</a>.</p></td></tr><tr><td style="background:#073e35;padding:24px 36px;color:#dce8e3;font-size:12px;line-height:19px;">This transactional email confirms your Noir Haus reservation.<br>Booking reference: ${escapeHtml(data.bookingReference)}</td></tr></table></td></tr></table></body></html>`;

  const textBody = [
    "NOIR HAUS",
    "",
    "YOUR STAY IS CONFIRMED",
    "",
    `Dear ${data.guestName},`,
    "",
    "Thank you for choosing Noir Haus. We have received your payment and secured your reservation.",
    "",
    `SUITE: ${data.propertyName}`,
    `GUESTS: ${guestLabel}`,
    `CHECK-IN: ${checkinDate} · ${checkinTime}`,
    `CHECK-OUT: ${checkoutDate} · ${checkoutTime}`,
    "",
    "PAYMENT RECEIPT",
    "PAYMENT STATUS: Paid",
    `TOTAL PAID: ${amount}`,
    `PAYMENT REFERENCE: ${data.paymentId}`,
    `BOOKING REFERENCE: ${data.bookingReference}`,
    "",
    "Please keep your booking reference handy. If your arrival details change or you need assistance, our team will be happy to help.",
    `Support: ${data.supportEmail}`,
  ].join("\n");

  return {
    subject: `Your Noir Haus booking is confirmed — ${data.bookingReference}`,
    htmlBody,
    textBody,
  };
}
```

- [ ] **Step 5: Restrict the generic renderer to unrelated templates**

In `src/features/email/templates.ts`, retain `"booking_confirmation"` in `EmailTemplateKey` because the outbox stores that key, but add:

```ts
export type GenericEmailTemplateKey = Exclude<EmailTemplateKey, "booking_confirmation">;
```

Change `copy` and `renderEmailTemplate` to accept `GenericEmailTemplateKey`, and remove the `booking_confirmation` entry from `copy`. In `src/features/email/templates.test.ts`, remove `"booking_confirmation"` from the table-driven generic test. This makes accidental use of the bare template for a guest confirmation a compile-time error.

- [ ] **Step 6: Run focused unit tests**

Run:

```bash
npx vitest run src/features/email/booking-confirmation-template.test.ts src/features/email/templates.test.ts
```

Expected: 2 test files pass with the professional and generic renderers both covered.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/features/email/email-config.ts src/features/email/booking-confirmation-template.ts src/features/email/booking-confirmation-template.test.ts src/features/email/templates.ts src/features/email/templates.test.ts
git commit -m "Add professional booking confirmation template"
```

### Task 2: Add a verified Reply-To address to ZeptoMail

**Files:**
- Modify: `src/features/email/zeptomail-client.ts`
- Modify: `src/features/email/zeptomail-client.test.ts`
- Modify: `src/features/bookings/job-runner.ts`
- Modify: `.env.example`
- Modify: `docs/booking-test-mode-runbook.md`

- [ ] **Step 1: Write the failing ZeptoMail payload assertion**

In the successful test in `src/features/email/zeptomail-client.test.ts`, construct the client with:

```ts
replyToAddress: "hello@noirhaus.in",
```

and extend the parsed-body assertion with:

```ts
reply_to: [{ address: "hello@noirhaus.in", name: "Noir Haus" }],
```

Also add `replyToAddress` to the error-path client construction so the option is required in every call.

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
npx vitest run src/features/email/zeptomail-client.test.ts
```

Expected: FAIL because the payload does not yet include `reply_to`.

- [ ] **Step 3: Add Reply-To to the client and configured worker**

In `src/features/email/zeptomail-client.ts`, add `replyToAddress: string` to the options type and add this property to the JSON request body, matching the official ZeptoMail API:

```ts
reply_to: [{ address: options.replyToAddress, name: options.senderName }],
```

In `src/features/bookings/job-runner.ts`, import `resolveGuestSupportEmail` and pass:

```ts
replyToAddress: resolveGuestSupportEmail(),
```

to `createZeptoMailClient`.

- [ ] **Step 4: Document the optional environment override**

Add to `.env.example` beneath the ZeptoMail sender values:

```text
# Optional; defaults to hello@noirhaus.in.
GUEST_SUPPORT_EMAIL=hello@noirhaus.in
```

Add `GUEST_SUPPORT_EMAIL` to the admin environment list in `docs/booking-test-mode-runbook.md`. In the ZeptoMail setup steps, state that the address must use a domain verified in the Agent and that guest replies route to it. The application default means no new production secret is required.

- [ ] **Step 5: Run focused delivery tests**

Run:

```bash
npx vitest run src/features/email/zeptomail-client.test.ts src/features/bookings/job-runner.test.ts
```

Expected: both test files pass and the outgoing ZeptoMail JSON includes Reply-To.

- [ ] **Step 6: Commit Task 2**

```bash
git add .env.example docs/booking-test-mode-runbook.md src/features/email/zeptomail-client.ts src/features/email/zeptomail-client.test.ts src/features/bookings/job-runner.ts
git commit -m "Configure guest email reply address"
```

### Task 3: Enqueue the professional message after payment confirmation

**Files:**
- Modify: `src/features/payments/payment-reconciliation.ts`
- Modify: `src/features/payments/payment-reconciliation.db.test.ts`

- [ ] **Step 1: Strengthen the captured-payment database test**

In `src/features/payments/payment-reconciliation.db.test.ts`, expand the outbox query in `confirms captured payment once...` to select `subject`, `html_body`, and `text_body`. Preserve the existing recipient/template assertion by mapping those two fields, then add:

```ts
const guestMessage = messages.find((message) => message.recipient_kind === "guest");
expect(guestMessage).toMatchObject({
  subject: `Your Noir Haus booking is confirmed — ${booking.public_reference}`,
});
expect(guestMessage?.html_body).toContain("Payment Suite");
expect(guestMessage?.html_body).toContain("2 guests");
expect(guestMessage?.html_body).toContain("1:00 PM");
expect(guestMessage?.html_body).toContain("11:00 AM");
expect(guestMessage?.html_body).toContain("pay_captured");
expect(guestMessage?.html_body).toContain("hello@noirhaus.in");
expect(guestMessage?.text_body).toContain("PAYMENT STATUS: Paid");
```

The existing double reconciliation in this test continues to prove that the deduplication key creates one guest message.

- [ ] **Step 2: Run the database test and verify the expected failure**

Run:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test TEST_SKIP_PGCRYPTO_EXTENSION=1 npm run test:db -- src/features/payments/payment-reconciliation.db.test.ts
```

Expected: FAIL because the current guest message has the old subject and bare HTML.

- [ ] **Step 3: Enrich the booking and property records**

In `src/features/payments/payment-reconciliation.ts`:

1. Add `guest_count: number` to `BookingRow`.
2. Add `guest_count` to every booking `select` and `returning` list in `bookingByReference`, `bookingByOrder`, `applyState`, the confirmation update, and the post-update fallback query.
3. Change the property query to:

```ts
const [property] = await tx<{
  name: string;
  default_checkin_time: string;
  default_checkout_time: string;
}[]>`
  select name, default_checkin_time::text, default_checkout_time::text
  from public.properties where id = ${current.property_id}
`;
if (!property) throw new PaymentReconciliationError("PROPERTY_NOT_FOUND");
```

- [ ] **Step 4: Render guest and admin messages through separate boundaries**

Import:

```ts
import { renderBookingConfirmationEmail } from "@/features/email/booking-confirmation-template";
import { resolveGuestSupportEmail } from "@/features/email/email-config";
```

Replace the shared confirmation/admin rendering block with:

```ts
const genericTemplateData = {
  guestName: current.guest_name,
  propertyName: property.name,
  bookingReference: current.public_reference,
  checkin: current.checkin,
  checkout: current.checkout,
  amountPaise: current.amount_paise,
};
await enqueueNotification(tx, {
  bookingId: current.id,
  recipientKind: "guest",
  recipientEmail: current.guest_email,
  templateKey: "booking_confirmation",
  deduplicationKey: `booking-confirmed:${current.id}:guest`,
  ...renderBookingConfirmationEmail({
    ...genericTemplateData,
    checkinTime: property.default_checkin_time,
    checkoutTime: property.default_checkout_time,
    guestCount: current.guest_count,
    paymentId: state.payment.id,
    supportEmail: resolveGuestSupportEmail(),
  }),
});
const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
if (adminEmail) await enqueueNotification(tx, {
  bookingId: current.id,
  recipientKind: "admin",
  recipientEmail: adminEmail,
  templateKey: "admin_new_booking",
  deduplicationKey: `booking-confirmed:${current.id}:admin`,
  ...renderEmailTemplate("admin_new_booking", genericTemplateData),
});
```

Do not change booking confirmation state, inventory conversion, calendar entry creation, or the existing outbox deduplication key.

- [ ] **Step 5: Run focused reconciliation and email tests**

Run:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test TEST_SKIP_PGCRYPTO_EXTENSION=1 npm run test:db -- src/features/payments/payment-reconciliation.db.test.ts
npx vitest run src/features/email/booking-confirmation-template.test.ts src/features/email/templates.test.ts src/features/email/zeptomail-client.test.ts
```

Expected: the reconciliation database test and all focused unit tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/features/payments/payment-reconciliation.ts src/features/payments/payment-reconciliation.db.test.ts
git commit -m "Send professional guest booking confirmations"
```

### Task 4: Verify the complete feature

**Files:**
- Verify all modified files

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
git diff --check
npm run lint
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the full unit suite**

Run:

```bash
npm test
```

Expected: all unit test files pass with no failures.

- [ ] **Step 3: Run the relevant database suite**

Run:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test TEST_SKIP_PGCRYPTO_EXTENSION=1 npm run test:db -- src/features/payments/payment-reconciliation.db.test.ts src/features/email/outbox-service.db.test.ts
```

Expected: both database test files pass.

- [ ] **Step 4: Run the production build**

Run:

```bash
npm run build
```

Expected: Next.js production build exits 0. Outside Vercel production, the migration prebuild is a no-op.

- [ ] **Step 5: Review the final diff and status**

Run:

```bash
git status --short
git diff HEAD~3 --stat
git log --oneline -5
```

Expected: only the planned email, reconciliation, configuration, test, and documentation files changed; the feature commits are visible and there are no uncommitted source changes.
