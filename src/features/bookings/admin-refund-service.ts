import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { createInventoryService, reconcilePropertyNights, releaseSourceNights } from "@/features/inventory/inventory-service";
import { createRazorpayClient, RazorpayClientError, type RazorpayPayment } from "@/features/payments/razorpay-client";

type BookingSql = postgres.Sql;
type PaymentAccount = {
  publicKeyId: string;
  fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]>;
};

export class AdminRefundError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number) {
    super(code);
    this.name = "AdminRefundError";
  }
}

export function createAdminRefundService(sql: BookingSql, dependencies: { paymentAccount?: PaymentAccount } = {}) {
  const inventory = createInventoryService(sql);
  return {
    async refundCancelAndArchiveBooking(userId: string, bookingId: string, expectedReference: string) {
      const [authorized] = await sql<{
        property_id: string;
        public_reference: string;
        razorpay_order_id: string | null;
        razorpay_payment_id: string | null;
        razorpay_key_id: string | null;
        amount_paise: number;
      }[]>`
        select b.property_id, b.public_reference, b.razorpay_order_id, b.razorpay_payment_id,
          b.razorpay_key_id, b.amount_paise
        from public.bookings b
        join public.property_members pm on pm.property_id = b.property_id and pm.user_id = ${userId}
        where b.id = ${bookingId}
      `;
      if (!authorized) throw new AdminRefundError("BOOKING_NOT_FOUND", 404);
      if (authorized.public_reference !== expectedReference) {
        throw new AdminRefundError("BOOKING_REFERENCE_MISMATCH", 409);
      }
      if (!authorized.razorpay_order_id || !authorized.razorpay_payment_id) {
        throw new AdminRefundError("BOOKING_NOT_REFUNDABLE", 409);
      }

      const paymentAccount = dependencies.paymentAccount;
      if (!paymentAccount) throw new AdminRefundError("RAZORPAY_ACCOUNT_UNVERIFIED", 503);
      if (authorized.razorpay_key_id !== paymentAccount.publicKeyId) {
        let payments: RazorpayPayment[];
        try {
          payments = await paymentAccount.fetchOrderPayments(authorized.razorpay_order_id);
        } catch (error) {
          if (error instanceof RazorpayClientError && error.kind === "definitive") {
            throw new AdminRefundError("RAZORPAY_ACCOUNT_MISMATCH", 409);
          }
          throw new AdminRefundError("RAZORPAY_ACCOUNT_UNAVAILABLE", 503);
        }
        const captured = payments.find((payment) => payment.id === authorized.razorpay_payment_id
          && payment.status === "captured" && payment.amount === authorized.amount_paise);
        if (!captured) throw new AdminRefundError("RAZORPAY_ACCOUNT_MISMATCH", 409);
      }

      return inventory.withPropertyInventory(authorized.property_id, async (tx) => {
        const [booking] = await tx<{
          id: string;
          property_id: string;
          public_reference: string;
          checkin: string;
          checkout: string;
          status: string;
          razorpay_payment_id: string | null;
          refund_status: string;
          cancellation_reason: string | null;
          archived_at: string | null;
          razorpay_key_id: string | null;
        }[]>`
          select b.id, b.property_id, b.public_reference, b.checkin::text, b.checkout::text,
            b.status, b.razorpay_payment_id, b.refund_status, b.cancellation_reason, b.archived_at::text,
            b.razorpay_key_id
          from public.bookings b
          join public.property_members pm on pm.property_id = b.property_id and pm.user_id = ${userId}
          where b.id = ${bookingId} for update of b
        `;
        if (!booking || booking.public_reference !== expectedReference) {
          throw new AdminRefundError("BOOKING_REFERENCE_MISMATCH", 409);
        }
        if (booking.razorpay_key_id !== authorized.razorpay_key_id) {
          throw new AdminRefundError("BOOKING_STATE_CHANGED", 409);
        }
        const [accountBound] = await tx`
          update public.bookings set razorpay_key_id = ${paymentAccount.publicKeyId},
            updated_at = now()
          where id = ${booking.id}
            and razorpay_key_id is not distinct from ${authorized.razorpay_key_id}
          returning id
        `;
        if (!accountBound) throw new AdminRefundError("RAZORPAY_ACCOUNT_MISMATCH", 409);
        if (booking.razorpay_key_id !== paymentAccount.publicKeyId) {
          await tx`
            insert into public.booking_events (property_id, booking_id, event_type, metadata)
            values (${booking.property_id}, ${booking.id}, 'razorpay_account_rebound',
              ${tx.json({ previousKeyId: booking.razorpay_key_id, currentKeyId: paymentAccount.publicKeyId, source: "admin_refund" })})
          `;
          await tx`
            insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
            values (${booking.property_id}, ${userId}, 'razorpay_account_rebound', 'website_booking', ${booking.id},
              ${tx.json({ previousKeyId: booking.razorpay_key_id, currentKeyId: paymentAccount.publicKeyId, source: "admin_refund" })})
          `;
        }
        if (booking.archived_at && booking.cancellation_reason === "admin_refund") {
          if (booking.refund_status === "failed") {
            const [retried] = await tx`
              insert into public.payment_jobs (booking_id, job_kind, idempotency_identity, status, next_attempt_at)
              values (${booking.id}, 'refund', ${`refund:${booking.id}`}, 'pending', now())
              on conflict (idempotency_identity) do update set
                status = 'pending', next_attempt_at = now(), last_error_code = null,
                lease_token = null, lease_expires_at = null, updated_at = now()
              where public.payment_jobs.status = 'definitive_failure'
              returning id
            `;
            if (!retried) {
              const [existing] = await tx<{ status: string }[]>`
                select status from public.payment_jobs where idempotency_identity = ${`refund:${booking.id}`}
              `;
              if (existing?.status === "succeeded") {
                await tx`update public.bookings set refund_status = 'processed', updated_at = now() where id = ${booking.id}`;
                return { archived: true, refundStatus: "processed", idempotent: true };
              }
              return { archived: true, refundStatus: "pending", idempotent: true };
            }
            await tx`update public.bookings set refund_status = 'pending', updated_at = now() where id = ${booking.id}`;
            await tx`
              insert into public.booking_events (property_id, booking_id, event_type, metadata)
              values (${booking.property_id}, ${booking.id}, 'admin_refund_retried', ${tx.json({ actorId: userId })})
            `;
            await tx`
              insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
              values (${booking.property_id}, ${userId}, 'admin_refund_retried', 'website_booking', ${booking.id},
                ${tx.json({ publicReference: booking.public_reference, fullRefund: true })})
            `;
            return { archived: true, refundStatus: "pending", idempotent: false, retried: true };
          }
          return { archived: true, refundStatus: booking.refund_status, idempotent: true };
        }
        if (booking.status !== "confirmed" || !booking.razorpay_payment_id) {
          throw new AdminRefundError("BOOKING_NOT_REFUNDABLE", 409);
        }
        if (booking.refund_status !== "not_required") {
          throw new AdminRefundError("REFUND_ALREADY_STARTED", 409);
        }

        await tx`
          update public.bookings set status = 'cancelled', cancellation_reason = 'admin_refund',
            refund_status = 'pending', cancelled_at = coalesce(cancelled_at, now()),
            archived_at = now(), archived_by = ${userId}, updated_at = now()
          where id = ${booking.id}
        `;
        await releaseSourceNights(tx, "website_hold", booking.id, "admin_refund");
        await releaseSourceNights(tx, "website_booking", booking.id, "admin_refund");
        await tx`
          update public.local_calendar_entries
          set active = false, archived_at = coalesce(archived_at, now()), updated_at = now()
          where booking_id = ${booking.id} and active = true
        `;
        await tx`
          insert into public.payment_jobs (booking_id, job_kind, idempotency_identity, status, next_attempt_at)
          values (${booking.id}, 'refund', ${`refund:${booking.id}`}, 'pending', now())
          on conflict (booking_id) where job_kind = 'refund' do nothing
        `;
        await tx`
          insert into public.booking_events (property_id, booking_id, event_type, metadata)
          values (${booking.property_id}, ${booking.id}, 'admin_refund_started', ${tx.json({ actorId: userId })})
        `;
        await tx`
          insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
          values (${booking.property_id}, ${userId}, 'admin_refund_started', 'website_booking', ${booking.id},
            ${tx.json({ publicReference: booking.public_reference, fullRefund: true, archived: true })})
        `;
        await reconcilePropertyNights(tx, booking.property_id, booking.checkin, booking.checkout);
        return { archived: true, refundStatus: "pending", idempotent: false };
      });
    },
  };
}

export function refundCancelAndArchiveBooking(userId: string, bookingId: string, expectedReference: string) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new AdminRefundError("RAZORPAY_ACCOUNT_UNVERIFIED", 503);
  return createAdminRefundService(getDb(), {
    paymentAccount: createRazorpayClient({ keyId, keySecret }),
  }).refundCancelAndArchiveBooking(userId, bookingId, expectedReference);
}
