import "server-only";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { createInventoryService, releaseSourceNights } from "@/features/inventory/inventory-service";
import {
  createRazorpayClient,
  RazorpayClientError,
  type RazorpayOrder,
  type RazorpayPayment,
} from "./razorpay-client";
import type { ParsedRazorpayWebhook } from "./razorpay-webhook";
import { enqueueNotification } from "@/features/email/outbox-service";
import { renderEmailTemplate } from "@/features/email/templates";
import { renderBookingConfirmationEmail } from "@/features/email/booking-confirmation-template";
import { resolveGuestSupportEmail } from "@/features/email/email-config";
import { orderReceipt } from "./order-recovery";

type PaymentSql = postgres.Sql;
type PaymentLookup = {
  publicKeyId: string;
  fetchOrder(orderId: string): Promise<RazorpayOrder>;
  fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]>;
};
export type ReconciliationTrigger =
  | "client_callback"
  | "checkout_dismissed"
  | "hold_expiry"
  | "resume"
  | "webhook"
  | "worker";

type BookingRow = {
  id: string;
  property_id: string;
  public_reference: string;
  guest_name: string;
  guest_email: string;
  guest_phone: string;
  guest_count: number;
  checkin: string;
  checkout: string;
  status: string;
  amount_paise: number;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  razorpay_key_id: string | null;
  refund_status: string;
  cancellation_reason: string | null;
};

type CapturedPaymentEvidence = {
  order: RazorpayOrder;
  webhookPaymentAmountPaise: number;
  providerPaymentAmountPaise: number;
};

type AmountIntegrityFailure = {
  integrityFailure: true;
  bookingId: string;
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

function isPositiveSafeInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function isAmountIntegrityFailure(
  value: { status: string; refundStatus: string } | AmountIntegrityFailure,
): value is AmountIntegrityFailure {
  return "integrityFailure" in value;
}

export function createPaymentReconciliationService(
  sql: PaymentSql,
  dependencies: { razorpay: PaymentLookup; clock?: () => Date },
) {
  const clock = dependencies.clock ?? (() => new Date());
  const inventory = createInventoryService(sql);

  async function bookingByReference(reference: string) {
    const [booking] = await sql<BookingRow[]>`
      select id, property_id, public_reference, guest_name, guest_email, guest_phone, guest_count,
        checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
        razorpay_payment_id, razorpay_key_id, refund_status, cancellation_reason
      from public.bookings where public_reference = ${reference}
    `;
    if (!booking) throw new PaymentReconciliationError("BOOKING_NOT_FOUND", 404);
    return booking;
  }

  async function bookingByOrder(orderId: string) {
    const [booking] = await sql<BookingRow[]>`
      select id, property_id, public_reference, guest_name, guest_email, guest_phone, guest_count,
        checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
        razorpay_payment_id, razorpay_key_id, refund_status, cancellation_reason
      from public.bookings where razorpay_order_id = ${orderId}
    `;
    if (!booking) throw new PaymentReconciliationError("BOOKING_NOT_FOUND", 404);
    return booking;
  }

  async function recordRetryableJob(bookingId: string, errorCode = "provider_unavailable") {
    await sql`
      insert into public.payment_jobs (booking_id, job_kind, idempotency_identity, status, last_error_code)
      values (${bookingId}, 'payment_reconciliation', ${`reconcile:${bookingId}`}, 'retryable_failure', ${errorCode})
      on conflict (idempotency_identity) do update set
        status = 'retryable_failure', last_error_code = ${errorCode},
        next_attempt_at = now(), updated_at = now()
      where payment_jobs.status <> 'definitive_failure'
    `;
  }

  async function revokeResumeToken(
    tx: postgres.Sql,
    bookingId: string,
  ) {
    const now = clock();
    await tx`
      update public.booking_resume_tokens
      set revoked_at = coalesce(revoked_at, ${now}), updated_at = ${now}
      where booking_id = ${bookingId}
    `;
  }

  async function applyState(
    booking: BookingRow,
    state: ReturnType<typeof choosePaymentState>,
    trigger: ReconciliationTrigger,
    capturedEvidence: CapturedPaymentEvidence | null = null,
  ) {
    return inventory.withPropertyInventory(booking.property_id, async (tx) => {
      const [current] = await tx<BookingRow[]>`
        select id, property_id, public_reference, guest_name, guest_email, guest_phone, guest_count,
          checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
          razorpay_payment_id, razorpay_key_id, refund_status, cancellation_reason
        from public.bookings where id = ${booking.id}
      `;
      if (!current) throw new PaymentReconciliationError("BOOKING_NOT_FOUND", 404);
      if (current.status === "cancelled"
        && current.cancellation_reason === "admin_test_cleanup"
        && current.razorpay_key_id?.startsWith("rzp_test_")) {
        return publicState(current);
      }

      if (state.kind === "captured") {
        if (!capturedEvidence) throw new PaymentReconciliationError("PAYMENT_INTEGRITY_EVIDENCE_MISSING");
        const [nightly] = await tx<{ night_count: number; total_paise: string }[]>`
          select count(*)::int as night_count,
            coalesce(sum(price_paise), 0)::bigint::text as total_paise
          from public.booking_night_prices
          where booking_id = ${current.id}
        `;
        const nightlyTotalPaise = Number(nightly?.total_paise ?? Number.NaN);
        const values = [
          capturedEvidence.webhookPaymentAmountPaise,
          capturedEvidence.order.amount,
          current.amount_paise,
          nightlyTotalPaise,
        ];
        const integrityReasons = [
          ...(!values.every(isPositiveSafeInteger) ? ["amount_not_positive_integer"] : []),
          ...(new Set(values).size !== 1 ? ["amount_mismatch"] : []),
          ...(!isPositiveSafeInteger(capturedEvidence.providerPaymentAmountPaise)
            || capturedEvidence.providerPaymentAmountPaise !== capturedEvidence.webhookPaymentAmountPaise
            ? ["provider_payment_amount_mismatch"]
            : []),
          ...(capturedEvidence.order.id !== current.razorpay_order_id ? ["order_id_mismatch"] : []),
          ...(capturedEvidence.order.currency !== "INR" ? ["order_currency_mismatch"] : []),
          ...(capturedEvidence.order.receipt !== orderReceipt(current.public_reference) ? ["order_receipt_mismatch"] : []),
          ...(!nightly || nightly.night_count < 1 ? ["nightly_prices_missing"] : []),
        ];
        if (integrityReasons.length > 0) {
          const metadata = {
            trigger,
            reasons: integrityReasons,
            paymentId: state.payment.id,
            orderId: current.razorpay_order_id,
            paymentAmountPaise: capturedEvidence.webhookPaymentAmountPaise,
            providerPaymentAmountPaise: capturedEvidence.providerPaymentAmountPaise,
            orderAmountPaise: capturedEvidence.order.amount,
            bookingAmountPaise: current.amount_paise,
            nightlyTotalPaise,
            orderCurrency: capturedEvidence.order.currency,
            orderReceipt: capturedEvidence.order.receipt,
          };
          await tx`
            insert into public.booking_events (property_id, booking_id, event_type, metadata)
            values (${current.property_id}, ${current.id}, 'AMOUNT_INTEGRITY_FAILURE', ${tx.json(metadata)})
          `;
          await tx`
            insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
            values (
              ${current.property_id}, 'amount_integrity_failure', 'website_booking',
              ${current.id}, ${tx.json(metadata)}
            )
          `;
          await tx`
            insert into public.payment_jobs (
              booking_id, job_kind, idempotency_identity, status, last_error_code
            ) values (
              ${current.id}, 'payment_reconciliation', ${`reconcile:${current.id}`},
              'definitive_failure', 'amount_integrity_failure'
            ) on conflict (idempotency_identity) do update set
              status = 'definitive_failure', last_error_code = 'amount_integrity_failure',
              lease_token = null, lease_expires_at = null, updated_at = ${clock()}
          `;
          const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
          if (adminEmail) {
            const [property] = await tx<{ name: string }[]>`
              select name from public.properties where id = ${current.property_id}
            `;
            if (!property) throw new PaymentReconciliationError("PROPERTY_NOT_FOUND");
            await enqueueNotification(tx, {
              bookingId: current.id,
              recipientKind: "admin",
              recipientEmail: adminEmail,
              templateKey: "amount_integrity_failure",
              deduplicationKey: `amount-integrity:${current.id}:${state.payment.id}:admin`,
              ...renderEmailTemplate("amount_integrity_failure", {
                guestName: current.guest_name,
                propertyName: property.name,
                bookingReference: current.public_reference,
                checkin: current.checkin,
                checkout: current.checkout,
                amountPaise: current.amount_paise,
              }),
            });
          }
          return { integrityFailure: true as const, bookingId: current.id };
        }
      }

      const previousKeyId = current.razorpay_key_id;
      const [accountBound] = await tx<{ razorpay_key_id: string }[]>`
        update public.bookings set razorpay_key_id = ${dependencies.razorpay.publicKeyId},
          updated_at = ${clock()}
        where id = ${current.id}
        returning razorpay_key_id
      `;
      if (!accountBound) throw new PaymentReconciliationError("PAYMENT_ACCOUNT_MISMATCH");
      current.razorpay_key_id = accountBound.razorpay_key_id;
      if (previousKeyId !== dependencies.razorpay.publicKeyId) {
        const changes = tx.json({ previousKeyId, currentKeyId: dependencies.razorpay.publicKeyId, source: trigger });
        await tx`
          insert into public.booking_events (property_id, booking_id, event_type, metadata)
          values (${current.property_id}, ${current.id}, 'razorpay_account_rebound', ${changes})
        `;
        await tx`
          insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
          values (${current.property_id}, 'razorpay_account_rebound', 'website_booking', ${current.id}, ${changes})
        `;
      }

      if (state.kind === "captured") {
        if (current.status === "confirmed") {
          await revokeResumeToken(tx as unknown as postgres.Sql, current.id);
          return publicState(current);
        }
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
              ${current.id}, 'refund', ${`refund:${current.id}`}, 'pending', ${clock()}
            ) on conflict (booking_id) where job_kind = 'refund' do nothing returning id
          `;
          await tx`
            update public.bookings set razorpay_payment_id = coalesce(razorpay_payment_id, ${state.payment.id}),
              refund_status = case when refund_status = 'not_required' then 'pending' else refund_status end,
              updated_at = ${clock()}
            where id = ${current.id}
          `;
          if (job) await tx`
            insert into public.booking_events (property_id, booking_id, event_type, metadata)
              values (${current.property_id}, ${current.id}, 'late_payment_after_expiry', ${tx.json({ paymentId: state.payment.id })})
          `;
          await revokeResumeToken(tx as unknown as postgres.Sql, current.id);
          return {
            status: current.status,
            refundStatus: current.refund_status === "not_required" ? "pending" : current.refund_status,
          };
        }

        const [confirmed] = await tx<BookingRow[]>`
          update public.bookings
          set status = 'confirmed', razorpay_payment_id = ${state.payment.id},
            confirmed_at = coalesce(confirmed_at, ${clock()}), updated_at = ${clock()}
          where id = ${current.id} and status in ('processing', 'held', 'payment_pending')
          returning id, property_id, public_reference, guest_name, guest_email, guest_phone, guest_count,
            checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
            razorpay_payment_id, razorpay_key_id, refund_status, cancellation_reason
        `;
        if (!confirmed) {
          const [latest] = await tx<BookingRow[]>`
            select id, property_id, public_reference, guest_name, guest_email, guest_phone, guest_count,
              checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
              razorpay_payment_id, razorpay_key_id, refund_status, cancellation_reason
            from public.bookings where id = ${current.id}
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
        const [property] = await tx<{
          name: string;
          default_checkin_time: string;
          default_checkout_time: string;
        }[]>`
          select name, default_checkin_time::text, default_checkout_time::text
          from public.properties where id = ${current.property_id}
        `;
        if (!property) throw new PaymentReconciliationError("PROPERTY_NOT_FOUND");
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
        await revokeResumeToken(tx as unknown as postgres.Sql, current.id);
        return publicState(confirmed);
      }

      if (["confirmed", "cancelled", "expired", "payment_failed"].includes(current.status)) {
        await revokeResumeToken(tx as unknown as postgres.Sql, current.id);
        return publicState(current);
      }
      if (state.kind === "authorized") {
        if (state.payment.amount !== current.amount_paise) throw new PaymentReconciliationError("PAYMENT_AMOUNT_MISMATCH");
        const [pending] = await tx<BookingRow[]>`
          update public.bookings set status = 'payment_pending',
            razorpay_payment_id = ${state.payment.id}, updated_at = ${clock()}
          where id = ${current.id} and status in ('processing', 'held', 'payment_pending')
          returning id, property_id, public_reference, guest_name, guest_email, guest_phone, guest_count,
            checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
            razorpay_payment_id, razorpay_key_id, refund_status, cancellation_reason
        `;
        return publicState(pending ?? current);
      }

      if (state.kind === "none" && trigger === "resume") {
        return publicState(current);
      }

      const shouldRelease = state.kind === "failed"
        || (state.kind === "none" && (trigger === "checkout_dismissed" || trigger === "hold_expiry"));
      if (!shouldRelease) throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_RETRYABLE");
      const status = state.kind === "failed" ? "payment_failed" : "expired";
      const [releasedBooking] = await tx<BookingRow[]>`
        update public.bookings set status = ${status}, updated_at = ${clock()}
        where id = ${current.id} and status in ('processing', 'held', 'payment_pending')
        returning id, property_id, public_reference, guest_name, guest_email, guest_phone, guest_count,
          checkin::text, checkout::text, status, amount_paise, razorpay_order_id,
          razorpay_payment_id, razorpay_key_id, refund_status, cancellation_reason
      `;
      if (releasedBooking) {
        await releaseSourceNights(tx, "website_hold", current.id, state.kind === "failed" ? "payment_failed" : "hold_expired");
        await tx`
          insert into public.booking_events (property_id, booking_id, event_type, metadata)
          values (${current.property_id}, ${current.id}, ${status}, ${tx.json({ trigger })})
        `;
        await revokeResumeToken(tx as unknown as postgres.Sql, current.id);
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
      } catch (error) {
        await recordRetryableJob(booking.id, error instanceof RazorpayClientError && error.kind === "definitive"
          ? "razorpay_account_mismatch"
          : "provider_unavailable");
        throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_RETRYABLE");
      }
      const state = choosePaymentState(payments);
      let capturedEvidence: CapturedPaymentEvidence | null = null;
      if (state.kind === "captured") {
        let order: RazorpayOrder;
        try {
          order = await dependencies.razorpay.fetchOrder(booking.razorpay_order_id);
        } catch (error) {
          await recordRetryableJob(booking.id, error instanceof RazorpayClientError && error.kind === "definitive"
            ? "razorpay_account_mismatch"
            : "provider_unavailable");
          throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_RETRYABLE");
        }
        capturedEvidence = {
          order,
          webhookPaymentAmountPaise: state.payment.amount,
          providerPaymentAmountPaise: state.payment.amount,
        };
      }
      const result = await applyState(booking, state, trigger, capturedEvidence);
      if (isAmountIntegrityFailure(result)) {
        throw new PaymentReconciliationError("AMOUNT_INTEGRITY_FAILURE", 409);
      }
      return result;
    },

    async applyVerifiedPayment(orderId: string, payment: RazorpayPayment, trigger: ReconciliationTrigger = "webhook") {
      const booking = await bookingByOrder(orderId);
      let order: RazorpayOrder;
      let payments: RazorpayPayment[];
      try {
        [order, payments] = await Promise.all([
          dependencies.razorpay.fetchOrder(orderId),
          dependencies.razorpay.fetchOrderPayments(orderId),
        ]);
      } catch {
        throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_RETRYABLE");
      }
      const providerPayment = payments.find((candidate) => candidate.id === payment.id);
      if (!providerPayment) throw new PaymentReconciliationError("PAYMENT_ACCOUNT_MISMATCH");
      if (payment.status === "captured" && providerPayment.status !== "captured") {
        throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_RETRYABLE");
      }
      const state = choosePaymentState([payment.status === "captured" ? providerPayment : payment]);
      const capturedEvidence = state.kind === "captured"
        ? {
            order,
            webhookPaymentAmountPaise: payment.amount,
            providerPaymentAmountPaise: providerPayment.amount,
          }
        : null;
      const result = await applyState(booking, state, trigger, capturedEvidence);
      if (isAmountIntegrityFailure(result)) {
        throw new PaymentReconciliationError("AMOUNT_INTEGRITY_FAILURE", 409);
      }
      return result;
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
      let booking: BookingRow | null = null;
      try {
        booking = await bookingByOrder(event.orderId);
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
        if (error instanceof PaymentReconciliationError && error.code === "AMOUNT_INTEGRITY_FAILURE" && booking) {
          await sql`
            update public.payment_events set booking_id = ${booking.id},
              razorpay_payment_id = ${event.paymentId}, status = 'ignored',
              error_code = 'amount_integrity_failure', processed_at = ${clock()}, updated_at = ${clock()}
            where razorpay_event_id = ${eventId}
          `;
          return { duplicate: false, integrityFailure: true };
        }
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
