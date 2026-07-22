import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createNotificationOutboxService, enqueueNotification } from "./outbox-service";

const NOW = new Date("2026-07-21T23:00:00.000Z");
let bookingId: string;

async function makeOutboxReady() {
  await testSql`update public.notification_outbox set next_attempt_at = ${NOW}`;
}

describe("notification outbox", () => {
  beforeEach(async () => {
    await resetDb();
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Email Suite') returning id`;
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise
      ) values ('NH-OUTBOXTEST001', ${property.id}, 'Email Guest', 'guest@example.test', '+919999999999', 1,
        '2026-08-14', '2026-08-15', 'confirmed', 500000) returning id
    `;
    bookingId = booking.id;
  });

  it("deduplicates messages and marks a successful leased send", async () => {
    const message = {
      bookingId, recipientKind: "guest" as const, recipientEmail: "guest@example.test",
      templateKey: "booking_confirmation", deduplicationKey: `booking-confirmed:${bookingId}:guest`,
      subject: "Confirmed", htmlBody: "<p>Confirmed</p>", textBody: "Confirmed",
    };
    await enqueueNotification(testSql, message);
    await enqueueNotification(testSql, message);
    await makeOutboxReady();
    const mailer = { send: vi.fn(async () => ({ providerMessageId: "zepto-message-1" })) };
    const service = createNotificationOutboxService(testSql, { mailer, clock: () => NOW });
    expect(await service.processBatch(10)).toEqual({ sent: 1, failed: 0 });
    expect(mailer.send).toHaveBeenCalledOnce();
    const [row] = await testSql<{ status: string; provider_message_id: string }[]>`select status, provider_message_id from public.notification_outbox`;
    expect(row).toEqual({ status: "sent", provider_message_id: "zepto-message-1" });
  });

  it("backs off a retryable failure without blocking another message", async () => {
    for (const suffix of ["one", "two"]) await enqueueNotification(testSql, {
      bookingId, recipientKind: "admin", recipientEmail: "admin@example.test",
      templateKey: "admin_new_booking", deduplicationKey: `admin:${bookingId}:${suffix}`,
      subject: suffix, htmlBody: suffix, textBody: suffix,
    });
    await makeOutboxReady();
    const mailer = { send: vi.fn()
      .mockRejectedValueOnce(new Error("provider detail"))
      .mockResolvedValueOnce({ providerMessageId: "zepto-message-2" }) };
    const service = createNotificationOutboxService(testSql, { mailer, clock: () => NOW });
    expect(await service.processBatch(10)).toEqual({ sent: 1, failed: 1 });
    const rows = await testSql<{ status: string; attempt_count: number; last_error_code: string | null }[]>`
      select status, attempt_count, last_error_code from public.notification_outbox order by subject
    `;
    expect(rows).toContainEqual({ status: "retryable_failure", attempt_count: 1, last_error_code: "mail_unavailable" });
    expect(rows).toContainEqual({ status: "sent", attempt_count: 1, last_error_code: null });
  });

  it("marks the eighth provider failure terminal and emits an admin-visible booking event", async () => {
    await enqueueNotification(testSql, {
      bookingId, recipientKind: "guest", recipientEmail: "guest@example.test",
      templateKey: "booking_confirmation", deduplicationKey: `terminal-mail:${bookingId}`,
      subject: "Confirmed", htmlBody: "<p>Confirmed</p>", textBody: "Confirmed",
    });
    await testSql`update public.notification_outbox set attempt_count = 7, next_attempt_at = ${NOW}`;
    const service = createNotificationOutboxService(testSql, {
      mailer: { send: vi.fn(async () => { throw new Error("provider unavailable"); }) },
      clock: () => NOW,
    });

    expect(await service.processBatch(10)).toEqual({ sent: 0, failed: 1 });
    await expect(testSql`select status, attempt_count, last_error_code from public.notification_outbox`).resolves.toEqual([
      { status: "failed", attempt_count: 8, last_error_code: "mail_retry_exhausted" },
    ]);
    await expect(testSql`select event_type from public.booking_events`).resolves.toEqual([
      { event_type: "notification_delivery_failed" },
    ]);
  });
});
