import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { createInventoryService, reconcilePropertyNights, releaseSourceNights } from "@/features/inventory/inventory-service";

type BookingSql = postgres.Sql;

export class AdminTestCleanupError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number) {
    super(code);
    this.name = "AdminTestCleanupError";
  }
}

function isTestKey(keyId: string | null) {
  return Boolean(keyId?.startsWith("rzp_test_"));
}

export function createAdminTestCleanupService(sql: BookingSql) {
  const inventory = createInventoryService(sql);

  return {
    async removeTestBooking(userId: string, bookingId: string, expectedReference: string) {
      const [authorized] = await sql<{
        property_id: string;
        public_reference: string;
        razorpay_key_id: string | null;
      }[]>`
        select b.property_id, b.public_reference, b.razorpay_key_id
        from public.bookings b
        join public.property_members pm on pm.property_id = b.property_id and pm.user_id = ${userId}
        where b.id = ${bookingId}
      `;
      if (!authorized) throw new AdminTestCleanupError("BOOKING_NOT_FOUND", 404);
      if (authorized.public_reference !== expectedReference) {
        throw new AdminTestCleanupError("BOOKING_REFERENCE_MISMATCH", 409);
      }
      if (!isTestKey(authorized.razorpay_key_id)) {
        throw new AdminTestCleanupError("BOOKING_NOT_TEST_MODE", 409);
      }

      return inventory.withPropertyInventory(authorized.property_id, async (tx) => {
        const [booking] = await tx<{
          id: string;
          property_id: string;
          public_reference: string;
          checkin: string;
          checkout: string;
          razorpay_key_id: string | null;
          razorpay_refund_id: string | null;
          refund_status: string;
          cancellation_reason: string | null;
          archived_at: string | null;
        }[]>`
          select b.id, b.property_id, b.public_reference, b.checkin::text, b.checkout::text,
            b.razorpay_key_id, b.razorpay_refund_id, b.refund_status,
            b.cancellation_reason, b.archived_at::text
          from public.bookings b
          join public.property_members pm on pm.property_id = b.property_id and pm.user_id = ${userId}
          where b.id = ${bookingId}
          for update of b
        `;
        if (!booking) throw new AdminTestCleanupError("BOOKING_NOT_FOUND", 404);
        if (booking.public_reference !== expectedReference) {
          throw new AdminTestCleanupError("BOOKING_REFERENCE_MISMATCH", 409);
        }
        if (!isTestKey(booking.razorpay_key_id)) {
          throw new AdminTestCleanupError("BOOKING_NOT_TEST_MODE", 409);
        }
        if (booking.archived_at) {
          if (booking.cancellation_reason === "admin_test_cleanup") {
            return { archived: true, refundStatus: "not_required", idempotent: true };
          }
          throw new AdminTestCleanupError("BOOKING_ALREADY_ARCHIVED", 409);
        }
        if (booking.refund_status !== "not_required" || booking.razorpay_refund_id) {
          throw new AdminTestCleanupError("BOOKING_REFUND_ALREADY_STARTED", 409);
        }
        const [refundJob] = await tx`
          select id from public.payment_jobs where booking_id = ${booking.id} and job_kind = 'refund' limit 1
        `;
        if (refundJob) throw new AdminTestCleanupError("BOOKING_REFUND_ALREADY_STARTED", 409);

        await tx`
          update public.bookings
          set status = 'cancelled', cancellation_reason = 'admin_test_cleanup',
            refund_status = 'not_required', cancelled_at = coalesce(cancelled_at, now()),
            archived_at = now(), archived_by = ${userId}, updated_at = now()
          where id = ${booking.id}
        `;
        await releaseSourceNights(tx, "website_hold", booking.id, "admin_test_cleanup");
        await releaseSourceNights(tx, "website_booking", booking.id, "admin_test_cleanup");
        await tx`
          update public.local_calendar_entries
          set active = false, archived_at = coalesce(archived_at, now()), updated_at = now()
          where booking_id = ${booking.id} and active = true
        `;
        await tx`
          update public.payment_jobs
          set status = 'definitive_failure', last_error_code = 'admin_test_cleanup',
            lease_token = null, lease_expires_at = null, updated_at = now()
          where booking_id = ${booking.id} and job_kind <> 'refund'
            and status in ('pending', 'processing', 'retryable_failure')
        `;
        await tx`
          update public.notification_outbox
          set status = 'failed', last_error_code = 'admin_test_cleanup',
            lease_token = null, lease_expires_at = null, updated_at = now()
          where booking_id = ${booking.id}
            and status in ('pending', 'processing', 'retryable_failure')
        `;
        await tx`
          insert into public.booking_events (property_id, booking_id, event_type, metadata)
          values (${booking.property_id}, ${booking.id}, 'admin_test_booking_removed',
            ${tx.json({ actorId: userId, noRefund: true, razorpayMode: "test" })})
        `;
        await tx`
          insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
          values (${booking.property_id}, ${userId}, 'admin_test_booking_removed', 'website_booking', ${booking.id},
            ${tx.json({ publicReference: booking.public_reference, noRefund: true, archived: true })})
        `;
        await reconcilePropertyNights(tx, booking.property_id, booking.checkin, booking.checkout);
        return { archived: true, refundStatus: "not_required", idempotent: false };
      });
    },
  };
}

export function removeTestBooking(userId: string, bookingId: string, expectedReference: string) {
  return createAdminTestCleanupService(getDb()).removeTestBooking(userId, bookingId, expectedReference);
}
