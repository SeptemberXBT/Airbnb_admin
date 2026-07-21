import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createBookingReadiness } from "./route";

const NOW = new Date("2026-07-21T10:15:00.000Z");

describe("health readiness", () => {
  beforeEach(resetDb);

  it("reports coarse database and stale worker state without configuration names", async () => {
    const readiness = await createBookingReadiness(testSql, () => NOW);
    expect(readiness).toEqual({ status: "degraded", timezone: "Asia/Kolkata", database: "ready", bookingWorker: "stale" });
    expect(JSON.stringify(readiness)).not.toMatch(/secret|razorpay|zeptomail|database_url/i);
  });

  it("reports ready only after a recent durable worker run", async () => {
    await testSql`
      insert into public.audit_log (action, entity_type, entity_id, created_at)
      values ('booking_worker_run', 'booking_worker', 'scheduled', '2026-07-21T10:13:01Z')
    `;
    await expect(createBookingReadiness(testSql, () => NOW)).resolves.toEqual({
      status: "ok", timezone: "Asia/Kolkata", database: "ready", bookingWorker: "fresh",
    });
  });

  it("stays degraded while a terminal notification failure needs admin attention", async () => {
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Health Suite') returning id`;
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise
      ) values ('NH-HEALTHFAILURE12', ${property.id}, 'Health Guest', 'health@example.test', '+919999999999', 1,
        '2026-08-14', '2026-08-15', 'confirmed', 500000) returning id
    `;
    await testSql`
      insert into public.notification_outbox (
        booking_id, recipient_kind, recipient_email, template_key, deduplication_key,
        subject, html_body, text_body, status
      ) values (${booking.id}, 'guest', 'health@example.test', 'test', 'health-failed', 'Test', '<p>Test</p>', 'Test', 'failed')
    `;
    await testSql`
      insert into public.audit_log (action, entity_type, entity_id, created_at)
      values ('booking_worker_run', 'booking_worker', 'scheduled', '2026-07-21T10:14:00Z')
    `;

    await expect(createBookingReadiness(testSql, () => NOW)).resolves.toEqual({
      status: "degraded", timezone: "Asia/Kolkata", database: "ready", bookingWorker: "degraded",
    });
  });

  it("reports the latest worker batch as degraded when a bounded stage returned failures", async () => {
    await testSql`
      insert into public.audit_log (action, entity_type, entity_id, changes, created_at)
      values ('booking_worker_run', 'booking_worker', 'scheduled', ${testSql.json({ stageFailures: 1 })}, '2026-07-21T10:14:00Z')
    `;
    await expect(createBookingReadiness(testSql, () => NOW)).resolves.toEqual({
      status: "degraded", timezone: "Asia/Kolkata", database: "ready", bookingWorker: "degraded",
    });
  });
});
