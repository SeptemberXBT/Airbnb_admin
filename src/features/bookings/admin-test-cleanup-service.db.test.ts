import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService } from "@/features/inventory/inventory-service";
import { createPaymentReconciliationService } from "@/features/payments/payment-reconciliation";
import { createAdminTestCleanupService } from "./admin-test-cleanup-service";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const TEST_KEY_ID = "rzp_test_admindelete";
let propertyId: string;
let bookingId: string;

describe("admin test-booking cleanup", () => {
  beforeEach(async () => {
    await resetDb();
    await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
    const [property] = await testSql<{ id: string }[]>`
      insert into public.properties (name) values ('Test Cleanup Suite') returning id
    `;
    propertyId = property.id;
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise, razorpay_order_id, razorpay_payment_id,
        razorpay_key_id, confirmed_at
      ) values (
        'NH-TESTCLEANUP1234', ${propertyId}, 'Test Guest', 'test@example.test', '+919999999999', 1,
        '2026-08-20', '2026-08-22', 'confirmed', 1000, 'order_test_cleanup', 'pay_test_cleanup',
        ${TEST_KEY_ID}, now()
      ) returning id
    `;
    bookingId = booking.id;
    await createInventoryService(testSql).withPropertyInventory(propertyId, async (tx) => {
      await claimStayNights(tx, {
        propertyId,
        stayDates: ["2026-08-20", "2026-08-21"],
        sourceKind: "website_booking",
        sourceId: bookingId,
      });
      await tx`
        insert into public.local_calendar_entries (
          property_id, entry_type, start_date, end_date, private_booking_name,
          sync_to_airbnb, booking_id, created_by
        ) values (${propertyId}, 'direct_reservation', '2026-08-20', '2026-08-22', 'Test Guest', true, ${bookingId}, null)
      `;
    });
  });

  it("archives an authorized test booking, releases its dates, and never creates a refund", async () => {
    const service = createAdminTestCleanupService(testSql);
    await expect(service.removeTestBooking(USER_ID, bookingId, "NH-TESTCLEANUP1234"))
      .resolves.toMatchObject({ archived: true, refundStatus: "not_required", idempotent: false });
    await expect(service.removeTestBooking(USER_ID, bookingId, "NH-TESTCLEANUP1234"))
      .resolves.toMatchObject({ archived: true, refundStatus: "not_required", idempotent: true });

    const [booking] = await testSql<{
      status: string;
      cancellation_reason: string;
      refund_status: string;
      archived_by: string;
    }[]>`
      select status, cancellation_reason, refund_status, archived_by
      from public.bookings where id = ${bookingId}
    `;
    expect(booking).toEqual({
      status: "cancelled",
      cancellation_reason: "admin_test_cleanup",
      refund_status: "not_required",
      archived_by: USER_ID,
    });
    expect(await testSql`select id from public.inventory_nights where booking_id = ${bookingId} and status = 'active'`).toHaveLength(0);
    expect(await testSql`select id from public.payment_jobs where booking_id = ${bookingId} and job_kind = 'refund'`).toHaveLength(0);
    expect(await testSql`select id from public.booking_events where booking_id = ${bookingId} and event_type = 'admin_test_booking_removed'`).toHaveLength(1);
    expect(await testSql`select id from public.audit_log where entity_id = ${bookingId} and action = 'admin_test_booking_removed'`).toHaveLength(1);
    const [entry] = await testSql<{ active: boolean }[]>`
      select active from public.local_calendar_entries where booking_id = ${bookingId}
    `;
    expect(entry.active).toBe(false);

    const reconciliation = createPaymentReconciliationService(testSql, {
      razorpay: {
        publicKeyId: TEST_KEY_ID,
        fetchOrderPayments: async () => [{ id: "pay_test_cleanup", status: "captured", amount: 1000 }],
      },
    });
    await reconciliation.applyVerifiedPayment("order_test_cleanup", {
      id: "pay_test_cleanup",
      status: "captured",
      amount: 1000,
    });
    expect(await testSql`select id from public.payment_jobs where booking_id = ${bookingId} and job_kind = 'refund'`).toHaveLength(0);
  });

  it("rejects live-mode bookings before changing inventory", async () => {
    await testSql`update public.bookings set razorpay_key_id = 'rzp_live_realbooking' where id = ${bookingId}`;
    await expect(createAdminTestCleanupService(testSql).removeTestBooking(USER_ID, bookingId, "NH-TESTCLEANUP1234"))
      .rejects.toMatchObject({ code: "BOOKING_NOT_TEST_MODE" });
    expect(await testSql`select id from public.inventory_nights where booking_id = ${bookingId} and status = 'active'`).toHaveLength(2);
  });

  it("requires property membership and the exact booking reference", async () => {
    const service = createAdminTestCleanupService(testSql);
    await expect(service.removeTestBooking(USER_ID, bookingId, "NH-WRONGREFERENCE1"))
      .rejects.toMatchObject({ code: "BOOKING_REFERENCE_MISMATCH" });
    await expect(service.removeTestBooking("10000000-0000-4000-8000-000000000099", bookingId, "NH-TESTCLEANUP1234"))
      .rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
  });
});
