import "server-only";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { createInventoryService, releaseSourceNights } from "@/features/inventory/inventory-service";
import { createRazorpayClient, type RazorpayPayment } from "./razorpay-client";
import type { ParsedRazorpayWebhook } from "./razorpay-webhook";
import { enqueueNotification } from "@/features/email/outbox-service";
import { renderEmailTemplate } from "@/features/email/templates";

type PaymentSql = postgres.Sql;
type PaymentLookup = { fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> };
export type ReconciliationTrigger = "client_callback" | "checkout_dismissed" | "hold_expiry" | "webhook";

type BookingRow = {
  id: string;
  property_id: string;
  public_reference: string;
  guest_name: string;
  guest_email: string;
  guest_phone: string;
  checkin: string;
  checkout: string;
  status: string;
  amount_paise: number;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  refund_status: string;
};

export class PaymentReconciliationError extends Error {
  constructor(public readonly code: string, public readonly httpStatus = 503) {
    super(code);
    this.name = "PaymentReconciliationError";
  }
}

function publicState(booking: { status: string; refund_status: string }) {
  return { status: booking.status, refundStatus: booking.refund_status };
}

function choosePaymentState(payments: RazorpayPayment[]) {
  const captured = payments.find((payment) => payment.status === "captured");
  if (captured) return { kind: "captured" as const, payment: captured };
  const authorized = payments.find((payment) => payment.status === "authorized");
  if (authorized) return { kind: "authorized" as const, payment: authorized };
  if (payments.length > 0 && payments.every((payment) => payment.status === "failed")) {
    return { kind: "failed" as const, payment: payments[0] };
  }
  if (payments.length === 0) return { kind: "none" as const, payment: null };
  return { kind: "unknown" as const, payment: null };
}

export function createPaymentReconciliationService(
  sql: PaymentSql,
  dependencies: { razorpay: PaymentLookup; clock?: () => Date },
) {
  const clock = dependencies.clock ?? (() => new Date());
  const inventory = createInventoryService(sql);

  async function bookingByReference(reference: string) {
    const [booking] = await sql<BookingRow[]>`
      select id, property_id, public_reference, guest_name, guest_email, guest_phone,
        checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
        razorpay_payment_id, refund_status
      from public.bookings where public_reference = ${reference}
    `;
    if (!booking) throw new PaymentReconciliationError("BOOKING_NOT_FOUND", 404);
    return booking;
  }

  async function bookingByOrder(orderId: string) {
    const [booking] = await sql<BookingRow[]>`
      select id, property_id, public_reference, guest_name, guest_email, guest_phone,
        checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
        razorpay_payment_id, refund_status
      from public.bookings where razorpay_order_id = ${orderId}
    `;
    if (!booking) throw new PaymentReconciliationError("BOOKING_NOT_FOUND", 404);
    return booking;
  }

  async function recordRetryableJob(bookingId: string) {
    await sql`
      insert into public.payment_jobs (booking_id, job_kind, idempotency_identity, status, last_error_code)
      values (${bookingId}, 'payment_reconciliation', ${`reconcile:${bookingId}`}, 'retryable_failure', 'provider_unavailable')
      on conflict (idempotency_identity) do update set
        status = 'retryable_failure', last_error_code = 'provider_unavailable',
        next_attempt_at = now(), updated_at = now()
    `;
  }

  async function applyState(
    booking: BookingRow,
    state: ReturnType<typeof choosePaymentState>,
    trigger: ReconciliationTrigger,
  ) {
    return inventory.withPropertyInventory(booking.property_id, async (tx) => {
      const [current] = await tx<BookingRow[]>`
        select id, property_id, public_reference, guest_name, guest_email, guest_phone,
          checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
          razorpay_payment_id, refund_status
        from public.bookings where id = ${booking.id}
      `;
      if (!current) throw new PaymentReconciliationError("BOOKING_NOT_FOUND", 404);

      if (state.kind === "captured") {
        if (state.payment.amount !== current.amount_paise) {
          throw new PaymentReconciliationError("PAYMENT_AMOUNT_MISMATCH");
        }
        if (current.status === "confirmed") return publicState(current);
        const [activeHold] = await tx`
          select 1 from public.inventory_nights
          where booking_id = ${current.id} and source_kind = 'website_hold' and status = 'active'
          limit 1
        `;
        if (!activeHold || ["expired", "cancelled", "payment_failed"].includes(current.status)) {
          const [job] = await tx<{ id: string }[]>`
            insert into public.payment_jobs (
              booking_id, job_kind, idempotency_identity, status, next_attempt_at
            ) values (
              ${current.id}, 'refund', ${`late-payment:${state.payment.id}`}, 'pending', ${clock()}
            ) on conflict (idempotency_identity) do nothing returning id
          `;
          await tx`
            update public.bookings set razorpay_payment_id = coalesce(razorpay_payment_id, ${state.payment.id}),
              refund_status = 'pending', updated_at = ${clock()}
            where id = ${current.id}
          `;
          if (job) await tx`
            insert into public.booking_events (property_id, booking_id, event_type, metadata)
            values (${current.property_id}, ${current.id}, 'late_payment_after_expiry', ${tx.json({ paymentId: state.payment.id })})
          `;
          return { status: current.status, refundStatus: "pending" };
        }

        const [confirmed] = await tx<BookingRow[]>`
          update public.bookings
          set status = 'confirmed', razorpay_payment_id = ${state.payment.id},
            confirmed_at = coalesce(confirmed_at, ${clock()}), updated_at = ${clock()}
          where id = ${current.id} and status in ('processing', 'held', 'payment_pending')
          returning id, property_id, public_reference, guest_name, guest_email, guest_phone,
            checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
            razorpay_payment_id, refund_status
        `;
        if (!confirmed) {
          const [latest] = await tx<BookingRow[]>`
            select id, property_id, public_reference, guest_name, guest_email, guest_phone,
              checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
              razorpay_payment_id, refund_status from public.bookings where id = ${current.id}
          `;
          return publicState(latest);
        }
        await tx`
          update public.inventory_nights
          set source_kind = 'website_booking', expires_at = null, updated_at = ${clock()}
          where booking_id = ${current.id} and source_kind = 'website_hold' and status = 'active'
        `;
        await tx`
          insert into public.local_calendar_entries (
            property_id, listing_id, entry_type, start_date, end_date,
            private_booking_name, payment_amount, private_contact, booking_source,
            sync_to_airbnb, booking_id, created_by
          ) values (
            ${current.property_id},
            (select id from public.listings where property_id = ${current.property_id} and archived_at is null order by created_at limit 1),
            'direct_reservation', ${current.checkin}, ${current.checkout}, ${current.guest_name},
            ${current.amount_paise / 100}, ${current.guest_phone}, 'website', true, ${current.id}, null
          ) on conflict (booking_id) do nothing
        `;
        await tx`
          insert into public.booking_events (property_id, booking_id, event_type, metadata)
          values (${current.property_id}, ${current.id}, 'payment_confirmed', ${tx.json({ trigger })})
        `;
        const [property] = await tx<{ name: string }[]>`
          select name from public.properties where id = ${current.property_id}
        `;
        const templateData = {
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
          ...renderEmailTemplate("booking_confirmation", templateData),
        });
        const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
        if (adminEmail) await enqueueNotification(tx, {
          bookingId: current.id,
          recipientKind: "admin",
          recipientEmail: adminEmail,
          templateKey: "admin_new_booking",
          deduplicationKey: `booking-confirmed:${current.id}:admin`,
          ...renderEmailTemplate("admin_new_booking", templateData),
        });
        return publicState(confirmed);
      }

      if (current.status === "confirmed" || current.status === "cancelled") return publicState(current);
      if (state.kind === "authorized") {
        if (state.payment.amount !== current.amount_paise) throw new PaymentReconciliationError("PAYMENT_AMOUNT_MISMATCH");
        const [pending] = await tx<BookingRow[]>`
          update public.bookings set status = 'payment_pending',
            razorpay_payment_id = ${state.payment.id}, updated_at = ${clock()}
          where id = ${current.id} and status in ('processing', 'held', 'payment_pending')
          returning id, property_id, public_reference, guest_name, guest_email, guest_phone,
            checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
            razorpay_payment_id, refund_status
        `;
        return publicState(pending ?? current);
      }

      const shouldRelease = state.kind === "failed"
        || (state.kind === "none" && (trigger === "checkout_dismissed" || trigger === "hold_expiry"));
      if (!shouldRelease) throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_RETRYABLE");
      const status = state.kind === "failed" ? "payment_failed" : "expired";
      const [releasedBooking] = await tx<BookingRow[]>`
        update public.bookings set status = ${status}, updated_at = ${clock()}
        where id = ${current.id} and status in ('processing', 'held', 'payment_pending')
        returning id, property_id, public_reference, guest_name, guest_email, guest_phone,
          checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
          razorpay_payment_id, refund_status
      `;
      if (releasedBooking) {
        await releaseSourceNights(tx, "website_hold", current.id, state.kind === "failed" ? "payment_failed" : "hold_expired");
        await tx`
          insert into public.booking_events (property_id, booking_id, event_type, metadata)
          values (${current.property_id}, ${current.id}, ${status}, ${tx.json({ trigger })})
        `;
      }
      return publicState(releasedBooking ?? current);
    });
  }

  return {
    async reconcileBooking(reference: string, trigger: ReconciliationTrigger) {
      const booking = await bookingByReference(reference);
      let payments: RazorpayPayment[];
      try {
        payments = await dependencies.razorpay.fetchOrderPayments(booking.razorpay_order_id);
      } catch {
        await recordRetryableJob(booking.id);
        throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_RETRYABLE");
      }
      return applyState(booking, choosePaymentState(payments), trigger);
    },

    async applyVerifiedPayment(orderId: string, payment: RazorpayPayment, trigger: ReconciliationTrigger = "webhook") {
      const booking = await bookingByOrder(orderId);
      return applyState(booking, choosePaymentState([payment]), trigger);
    },

    async processWebhookEvent(eventId: string, event: ParsedRazorpayWebhook, rawBody: string) {
      const payloadHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
      const [created] = await sql<{ id: string }[]>`
        insert into public.payment_events (razorpay_event_id, event_type, payload_sha256)
        values (${eventId}, ${event.eventType}, ${payloadHash})
        on conflict (razorpay_event_id) do nothing returning id
      `;
      if (!created) {
        const [existing] = await sql<{ status: string }[]>`
          select status from public.payment_events where razorpay_event_id = ${eventId}
        `;
        if (existing?.status === "processed" || existing?.status === "ignored") return { duplicate: true };
      }
      try {
        const booking = await bookingByOrder(event.orderId);
        const result = event.eventType === "order.paid"
          ? await this.reconcileBooking(booking.public_reference, "webhook")
          : await this.applyVerifiedPayment(event.orderId, {
              id: event.paymentId as string,
              status: event.paymentStatus,
              amount: event.amountPaise,
            });
        await sql`
          update public.payment_events set booking_id = ${booking.id},
            razorpay_payment_id = ${event.paymentId}, status = 'processed', processed_at = ${clock()}, updated_at = ${clock()}
          where razorpay_event_id = ${eventId}
        `;
        return { duplicate: false, result };
      } catch (error) {
        await sql`
          update public.payment_events set status = 'failed', error_code = 'reconciliation_failed', updated_at = ${clock()}
          where razorpay_event_id = ${eventId}
        `;
        throw error;
      }
    },
  };
}

function configuredService() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("RAZORPAY_NOT_CONFIGURED");
  return createPaymentReconciliationService(getDb(), {
    razorpay: createRazorpayClient({ keyId, keySecret }),
  });
}

export function reconcileBooking(reference: string, trigger: ReconciliationTrigger) {
  return configuredService().reconcileBooking(reference, trigger);
}

export function processRazorpayWebhookEvent(eventId: string, event: ParsedRazorpayWebhook, rawBody: string) {
  return configuredService().processWebhookEvent(eventId, event, rawBody);
}

export type PaymentReconciliationService = ReturnType<typeof createPaymentReconciliationService>;
