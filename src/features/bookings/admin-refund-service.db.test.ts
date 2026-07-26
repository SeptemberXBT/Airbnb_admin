import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService } from "@/features/inventory/inventory-service";
import { createAdminRefundService } from "./admin-refund-service";
import { createPaymentReconciliationService } from "@/features/payments/payment-reconciliation";

const USER_ID = "10000000-0000-4000-8000-000000000001";
let propertyId: string;
let bookingId: string;
const RAZORPAY_KEY_ID = "rzp_test_adminrefund";

function refundService(keyId = RAZORPAY_KEY_ID) {
  return createAdminRefundService(testSql, {
    paymentAccount: {
      publicKeyId: keyId,
      fetchOrderPayments: async () => [{ id: "pay_admin_refund", status: "captured", amount: 1250000 }],
    },
  });
}

describe("admin refund, cancellation, and archive", () => {
  beforeEach(async () => {
    await resetDb();
    await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Refund Suite') returning id`;
    propertyId = property.id;
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
        checkin, checkout, status, amount_paise, razorpay_order_id, razorpay_payment_id,
        razorpay_key_id, confirmed_at
      ) values (
        'NH-ADMINREFUND1234', ${propertyId}, 'Refund Guest', 'refund@example.test', '+919999999999', 2,
        '2026-08-14', '2026-08-16', 'confirmed', 1250000, 'order_admin_refund', 'pay_admin_refund',
        ${RAZORPAY_KEY_ID}, now()
      ) returning id
    `;
    bookingId = booking.id;
    await testSql`
      insert into public.booking_night_prices (booking_id, stay_date, price_paise, price_source)
      values
        (${bookingId}, '2026-08-14', 625000, 'weekday'),
        (${bookingId}, '2026-08-15', 625000, 'weekday')
    `;
    await createInventoryService(testSql).withPropertyInventory(propertyId, async (tx) => {
      await claimStayNights(tx, {
        propertyId, stayDates: ["2026-08-14", "2026-08-15"], sourceKind: "website_booking", sourceId: bookingId,
      });
      await tx`
        insert into public.local_calendar_entries (
          property_id, entry_type, start_date, end_date, private_booking_name,
          sync_to_airbnb, booking_id, created_by
        ) values (${propertyId}, 'direct_reservation', '2026-08-14', '2026-08-16', 'Refund Guest', true, ${bookingId}, null)
      `;
    });
  });

  it("atomically releases dates, archives history, and enqueues one full refund", async () => {
    const service = refundService();
    await expect(service.refundCancelAndArchiveBooking(USER_ID, bookingId, "NH-ADMINREFUND1234"))
      .resolves.toMatchObject({ archived: true, refundStatus: "pending", idempotent: false });
    await expect(service.refundCancelAndArchiveBooking(USER_ID, bookingId, "NH-ADMINREFUND1234"))
      .resolves.toMatchObject({ archived: true, refundStatus: "pending", idempotent: true });

    const [booking] = await testSql<{ status: string; refund_status: string; archived_by: string; cancellation_reason: string }[]>`
      select status, refund_status, archived_by, cancellation_reason from public.bookings where id = ${bookingId}
    `;
    expect(booking).toEqual({ status: "cancelled", refund_status: "pending", archived_by: USER_ID, cancellation_reason: "admin_refund" });
    expect(await testSql`select id from public.inventory_nights where booking_id = ${bookingId} and status = 'active'`).toHaveLength(0);
    expect(await testSql`select id from public.payment_jobs where booking_id = ${bookingId} and job_kind = 'refund'`).toHaveLength(1);
    expect(await testSql`select id from public.audit_log where entity_id = ${bookingId} and action = 'admin_refund_started'`).toHaveLength(1);
    const [entry] = await testSql<{ active: boolean }[]>`select active from public.local_calendar_entries where booking_id = ${bookingId}`;
    expect(entry.active).toBe(false);

    const reconciliation = createPaymentReconciliationService(testSql, {
      razorpay: {
        publicKeyId: RAZORPAY_KEY_ID,
        fetchOrder: async () => ({
          id: "order_admin_refund",
          amount: 1250000,
          currency: "INR" as const,
          receipt: "nh_NH-ADMINREFUND1234",
          status: "paid",
        }),
        fetchOrderPayments: async () => [{ id: "pay_admin_refund", status: "captured", amount: 1250000 }],
      },
    });
    await reconciliation.applyVerifiedPayment("order_admin_refund", {
      id: "pay_admin_refund", status: "captured", amount: 1250000,
    });
    expect(await testSql`select id from public.payment_jobs where booking_id = ${bookingId} and job_kind = 'refund'`).toHaveLength(1);
  });

  it("requires property membership and the exact reference", async () => {
    const service = refundService();
    await expect(service.refundCancelAndArchiveBooking(USER_ID, bookingId, "NH-WRONGREFERENCE1"))
      .rejects.toMatchObject({ code: "BOOKING_REFERENCE_MISMATCH" });
    await expect(service.refundCancelAndArchiveBooking("10000000-0000-4000-8000-000000000099", bookingId, "NH-ADMINREFUND1234"))
      .rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
  });

  it("blocks a refund before release when the configured Razorpay account does not match", async () => {
    const service = createAdminRefundService(testSql, {
      paymentAccount: { publicKeyId: "rzp_live_wrongaccount", fetchOrderPayments: async () => [] },
    });
    await expect(service.refundCancelAndArchiveBooking(USER_ID, bookingId, "NH-ADMINREFUND1234"))
      .rejects.toMatchObject({ code: "RAZORPAY_ACCOUNT_MISMATCH" });
    const [booking] = await testSql<{ status: string; archived_at: string | null }[]>`
      select status, archived_at::text from public.bookings where id = ${bookingId}
    `;
    expect(booking).toEqual({ status: "confirmed", archived_at: null });
  });

  it("verifies and audits a same-account Razorpay key rotation before refunding", async () => {
    const rotatedKeyId = "rzp_test_adminrotated";
    const result = await refundService(rotatedKeyId)
      .refundCancelAndArchiveBooking(USER_ID, bookingId, "NH-ADMINREFUND1234");
    expect(result).toMatchObject({ archived: true, refundStatus: "pending" });
    const [booking] = await testSql<{ razorpay_key_id: string }[]>`
      select razorpay_key_id from public.bookings where id = ${bookingId}
    `;
    expect(booking.razorpay_key_id).toBe(rotatedKeyId);
    expect(await testSql`select id from public.audit_log where entity_id = ${bookingId} and action = 'razorpay_account_rebound'`).toHaveLength(1);
  });

  it("requeues the canonical refund after an audited admin retry", async () => {
    const service = refundService();
    await service.refundCancelAndArchiveBooking(USER_ID, bookingId, "NH-ADMINREFUND1234");
    await testSql`update public.bookings set refund_status = 'failed' where id = ${bookingId}`;
    await testSql`update public.payment_jobs set status = 'definitive_failure' where idempotency_identity = ${`refund:${bookingId}`}`;
    await expect(service.refundCancelAndArchiveBooking(USER_ID, bookingId, "NH-ADMINREFUND1234"))
      .resolves.toMatchObject({ archived: true, refundStatus: "pending", retried: true });
    const [job] = await testSql<{ status: string; idempotency_identity: string }[]>`
      select status, idempotency_identity from public.payment_jobs where booking_id = ${bookingId} and job_kind = 'refund'
    `;
    expect(job).toEqual({ status: "pending", idempotency_identity: `refund:${bookingId}` });
  });
});
