import "server-only";
import type postgres from "postgres";
import type { PaymentReconciliationService } from "@/features/payments/payment-reconciliation";

export async function processExpiredHolds(
  sql: postgres.Sql,
  reconciliation: Pick<PaymentReconciliationService, "reconcileBooking">,
  options: { now?: Date; limit?: number } = {},
) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_HOLD_EXPIRY_LIMIT");
  const bookings = await sql<{ public_reference: string }[]>`
    select public_reference from public.bookings
    where status in ('processing', 'held', 'payment_pending')
      and hold_expires_at is not null and hold_expires_at <= ${now}
    order by hold_expires_at, created_at
    limit ${limit}
  `;
  let processed = 0;
  let failed = 0;
  for (const booking of bookings) {
    try {
      await reconciliation.reconcileBooking(booking.public_reference, "hold_expiry");
      processed += 1;
    } catch {
      failed += 1;
    }
  }
  return { processed, failed };
}
