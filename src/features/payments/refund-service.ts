import "server-only";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { enqueueNotification } from "@/features/email/outbox-service";
import { renderEmailTemplate } from "@/features/email/templates";
import type { RazorpayPayment } from "./razorpay-client";

export type ProviderRefund = { id: string; status: "pending" | "processed" | "failed" };

export class RefundProviderError extends Error {
  constructor(
    public readonly kind: "definitive" | "ambiguous",
    public readonly code: "REFUND_REJECTED" | "REFUND_UNAVAILABLE" | "REFUND_INVALID_RESPONSE",
  ) {
    super(code);
    this.name = "RefundProviderError";
  }
}

function parseRefund(value: unknown): ProviderRefund {
  if (!value || typeof value !== "object") throw new RefundProviderError("ambiguous", "REFUND_INVALID_RESPONSE");
  const refund = value as Record<string, unknown>;
  if (typeof refund.id !== "string" || !["pending", "processed", "failed"].includes(String(refund.status))) {
    throw new RefundProviderError("ambiguous", "REFUND_INVALID_RESPONSE");
  }
  return { id: refund.id, status: refund.status as ProviderRefund["status"] };
}

function parsePayments(value: unknown): RazorpayPayment[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) {
    throw new RefundProviderError("ambiguous", "REFUND_INVALID_RESPONSE");
  }
  return (value as { items: unknown[] }).items.map((item) => {
    if (!item || typeof item !== "object") throw new RefundProviderError("ambiguous", "REFUND_INVALID_RESPONSE");
    const payment = item as Record<string, unknown>;
    if (typeof payment.id !== "string" || typeof payment.status !== "string" || !Number.isSafeInteger(payment.amount)) {
      throw new RefundProviderError("ambiguous", "REFUND_INVALID_RESPONSE");
    }
    return payment as RazorpayPayment;
  });
}

export function createRazorpayRefundProvider(options: {
  keyId: string;
  keySecret: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.razorpay.com";
  const authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`;
  async function request(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { Authorization: authorization, "content-type": "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new RefundProviderError("ambiguous", "REFUND_UNAVAILABLE");
    }
    if (!response.ok) {
      const ambiguous = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new RefundProviderError(ambiguous ? "ambiguous" : "definitive", ambiguous ? "REFUND_UNAVAILABLE" : "REFUND_REJECTED");
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new RefundProviderError("ambiguous", "REFUND_INVALID_RESPONSE");
    }
  }
  return {
    publicKeyId: options.keyId,

    async fetchOrderPayments(orderId: string) {
      return parsePayments(await request(`/v1/orders/${encodeURIComponent(orderId)}/payments`));
    },

    async findRefund(paymentId: string, identity: string) {
      const value = await request(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`);
      if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) {
        throw new RefundProviderError("ambiguous", "REFUND_INVALID_RESPONSE");
      }
      const matching = (value as { items: unknown[] }).items.filter((item) => (
        item && typeof item === "object"
        && (item as { notes?: { noirhaus_identity?: unknown } }).notes?.noirhaus_identity === identity
      ));
      if (matching.length > 1) throw new RefundProviderError("ambiguous", "REFUND_INVALID_RESPONSE");
      return matching[0] ? parseRefund(matching[0]) : null;
    },
    async createFullRefund(paymentId: string, identity: string) {
      return parseRefund(await request(`/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
        method: "POST",
        body: JSON.stringify({ notes: { noirhaus_identity: identity } }),
      }));
    },
  };
}

type RefundProvider = ReturnType<typeof createRazorpayRefundProvider>;

export function createRefundService(
  sql: postgres.Sql,
  dependencies: { provider: Pick<RefundProvider, "publicKeyId" | "fetchOrderPayments" | "findRefund" | "createFullRefund">; clock?: () => Date },
) {
  const clock = dependencies.clock ?? (() => new Date());

  async function enqueueTemplate(row: {
    booking_id: string;
    guest_name: string;
    guest_email: string;
    property_name: string;
    public_reference: string;
    checkin: string;
    checkout: string;
    amount_paise: number;
    idempotency_identity: string;
  }, key: "refund_processed" | "late_payment_refund" | "refund_failed_admin", recipient: "guest" | "admin") {
    const email = recipient === "guest" ? row.guest_email : process.env.ADMIN_NOTIFICATION_EMAIL;
    if (!email) return;
    const message = renderEmailTemplate(key, {
      guestName: row.guest_name,
      propertyName: row.property_name,
      bookingReference: row.public_reference,
      checkin: row.checkin,
      checkout: row.checkout,
      amountPaise: row.amount_paise,
    });
    await enqueueNotification(sql, {
      bookingId: row.booking_id,
      recipientKind: recipient,
      recipientEmail: email,
      templateKey: key,
      deduplicationKey: `${key}:${row.idempotency_identity}:${recipient}`,
      ...message,
    });
  }

  return {
    async processBatch(limit = 25) {
      const now = clock();
      const leaseToken = randomUUID();
      const rows = await sql<{
        id: string;
        booking_id: string;
        property_id: string;
        idempotency_identity: string;
        guest_name: string;
        guest_email: string;
        property_name: string;
        public_reference: string;
        checkin: string;
        checkout: string;
        amount_paise: number;
        razorpay_payment_id: string | null;
        razorpay_order_id: string;
        razorpay_key_id: string | null;
        cancellation_reason: string | null;
        late_payment_refund: boolean;
        attempt_count: number;
      }[]>`
        with ready as (
          select id from public.payment_jobs
          where job_kind = 'refund' and status in ('pending', 'retryable_failure') and next_attempt_at <= ${now}
          order by next_attempt_at, created_at limit ${limit} for update skip locked
        )
        update public.payment_jobs j
        set status = 'processing', lease_token = ${leaseToken}, lease_expires_at = ${new Date(now.getTime() + 60_000)},
          attempt_count = attempt_count + 1, updated_at = ${now}
        from ready, public.bookings b, public.properties p
        where j.id = ready.id and b.id = j.booking_id and p.id = b.property_id
        returning j.id, j.booking_id, b.property_id, j.idempotency_identity,
          b.guest_name, b.guest_email,
          p.name as property_name, b.public_reference, b.checkin::text, b.checkout::text,
          b.amount_paise, b.razorpay_payment_id, b.razorpay_order_id, b.razorpay_key_id,
          b.cancellation_reason, j.attempt_count,
          exists (
            select 1 from public.booking_events e
            where e.booking_id = b.id and e.event_type = 'late_payment_after_expiry'
          ) as late_payment_refund
      `;
      let processed = 0;
      let retryable = 0;
      let failed = 0;
      for (const row of rows) {
        if (!row.razorpay_payment_id) {
          await sql`
            update public.payment_jobs set status = 'definitive_failure', last_error_code = 'payment_id_missing',
              lease_token = null, lease_expires_at = null, updated_at = ${clock()}
            where id = ${row.id} and lease_token = ${leaseToken}
          `;
          failed += 1;
          continue;
        }
        if (row.razorpay_key_id !== dependencies.provider.publicKeyId) {
          let payments: RazorpayPayment[];
          try {
            payments = await dependencies.provider.fetchOrderPayments(row.razorpay_order_id);
          } catch {
            await sql`
              update public.payment_jobs set status = 'retryable_failure',
                next_attempt_at = ${new Date(clock().getTime() + 5 * 60_000)},
                last_error_code = 'razorpay_account_mismatch', lease_token = null,
                lease_expires_at = null, updated_at = ${clock()}
              where id = ${row.id} and lease_token = ${leaseToken}
            `;
            retryable += 1;
            continue;
          }
          const exactPayment = payments.find((payment) => payment.id === row.razorpay_payment_id
            && payment.status === "captured" && payment.amount === row.amount_paise);
          if (!exactPayment) {
            await sql`
              update public.payment_jobs set status = 'retryable_failure',
                next_attempt_at = ${new Date(clock().getTime() + 5 * 60_000)},
                last_error_code = 'razorpay_account_mismatch', lease_token = null,
                lease_expires_at = null, updated_at = ${clock()}
              where id = ${row.id} and lease_token = ${leaseToken}
            `;
            retryable += 1;
            continue;
          }
          const rebound = await sql.begin(async (tx) => {
            const [bound] = await tx`
              update public.bookings set razorpay_key_id = ${dependencies.provider.publicKeyId}, updated_at = ${clock()}
              where id = ${row.booking_id} and razorpay_order_id = ${row.razorpay_order_id}
                and razorpay_payment_id = ${row.razorpay_payment_id} and amount_paise = ${row.amount_paise}
              returning id
            `;
            if (!bound) return false;
            await tx`
              insert into public.booking_events (property_id, booking_id, event_type, metadata)
              values (${row.property_id}, ${row.booking_id}, 'razorpay_account_rebound',
                ${tx.json({ previousKeyId: row.razorpay_key_id, currentKeyId: dependencies.provider.publicKeyId, source: "refund_worker" })})
            `;
            await tx`
              insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
              values (${row.property_id}, 'razorpay_account_rebound', 'website_booking', ${row.booking_id},
                ${tx.json({ previousKeyId: row.razorpay_key_id, currentKeyId: dependencies.provider.publicKeyId, source: "refund_worker" })})
            `;
            return true;
          });
          if (!rebound) {
            await sql`
              update public.payment_jobs set status = 'retryable_failure',
                next_attempt_at = ${new Date(clock().getTime() + 5 * 60_000)},
                last_error_code = 'razorpay_account_rebind_failed', lease_token = null,
                lease_expires_at = null, updated_at = ${clock()}
              where id = ${row.id} and lease_token = ${leaseToken}
            `;
            retryable += 1;
            continue;
          }
          row.razorpay_key_id = dependencies.provider.publicKeyId;
        }
        let refund: ProviderRefund;
        try {
          const aliases = await sql<{ idempotency_identity: string }[]>`
            select idempotency_identity from public.payment_refund_job_aliases
            where booking_id = ${row.booking_id}
            order by (status = 'succeeded') desc, (provider_id is not null) desc, created_at, original_job_id
          `;
          const refundIdentities = [row.idempotency_identity, ...aliases.map((alias) => alias.idempotency_identity)];
          let discovered: ProviderRefund | null = null;
          const rank = { processed: 0, pending: 1, failed: 2 } as const;
          for (const identity of refundIdentities) {
            const candidate = await dependencies.provider.findRefund(row.razorpay_payment_id, identity);
            if (candidate && (!discovered || rank[candidate.status] < rank[discovered.status])) discovered = candidate;
          }
          refund = discovered
            ?? await dependencies.provider.createFullRefund(row.razorpay_payment_id, row.idempotency_identity);
        } catch (error) {
          const definitive = error instanceof RefundProviderError && error.kind === "definitive";
          if (definitive) {
            await sql.begin(async (tx) => {
              await tx`update public.payment_jobs set status = 'definitive_failure', last_error_code = 'refund_rejected', lease_token = null, lease_expires_at = null, updated_at = ${clock()} where id = ${row.id} and lease_token = ${leaseToken}`;
              await tx`update public.bookings set refund_status = 'failed', updated_at = ${clock()} where id = ${row.booking_id}`;
            });
            await enqueueTemplate(row, "refund_failed_admin", "admin");
            failed += 1;
          } else {
            const delayMinutes = Math.min(60, 2 ** Math.min(row.attempt_count, 6));
            await sql`update public.payment_jobs set status = 'retryable_failure', next_attempt_at = ${new Date(clock().getTime() + delayMinutes * 60_000)}, last_error_code = 'refund_unavailable', lease_token = null, lease_expires_at = null, updated_at = ${clock()} where id = ${row.id} and lease_token = ${leaseToken}`;
            retryable += 1;
          }
          continue;
        }

        if (refund.status === "failed") {
          await sql.begin(async (tx) => {
            await tx`update public.payment_jobs set status = 'definitive_failure', provider_id = ${refund.id}, last_error_code = 'refund_failed', lease_token = null, lease_expires_at = null, updated_at = ${clock()} where id = ${row.id} and lease_token = ${leaseToken}`;
            await tx`update public.bookings set refund_status = 'failed', razorpay_refund_id = ${refund.id}, updated_at = ${clock()} where id = ${row.booking_id}`;
          });
          await enqueueTemplate(row, "refund_failed_admin", "admin");
          failed += 1;
        } else if (refund.status === "processed") {
          await sql.begin(async (tx) => {
            await tx`update public.payment_jobs set status = 'succeeded', provider_id = ${refund.id}, terminal_result = ${tx.json({ status: "processed" })}, lease_token = null, lease_expires_at = null, updated_at = ${clock()} where id = ${row.id} and lease_token = ${leaseToken}`;
            await tx`update public.bookings set refund_status = 'processed', razorpay_refund_id = ${refund.id}, updated_at = ${clock()} where id = ${row.booking_id}`;
          });
          await enqueueTemplate(row, "refund_processed", "guest");
          processed += 1;
        } else {
          await sql.begin(async (tx) => {
            await tx`update public.payment_jobs set status = 'retryable_failure', provider_id = ${refund.id}, next_attempt_at = ${new Date(clock().getTime() + 5 * 60_000)}, last_error_code = null, lease_token = null, lease_expires_at = null, updated_at = ${clock()} where id = ${row.id} and lease_token = ${leaseToken}`;
            await tx`update public.bookings set refund_status = 'pending', razorpay_refund_id = ${refund.id}, updated_at = ${clock()} where id = ${row.booking_id}`;
          });
          if (row.late_payment_refund) {
            await enqueueTemplate(row, "late_payment_refund", "guest");
          }
          retryable += 1;
        }
      }
      return { processed, retryable, failed };
    },
  };
}
