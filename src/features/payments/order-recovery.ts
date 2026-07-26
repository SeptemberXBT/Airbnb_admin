import "server-only";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createInventoryService, releaseSourceNights } from "@/features/inventory/inventory-service";
import type { InventoryTransaction } from "@/features/inventory/inventory-types";
import { createBookingResumeService } from "@/features/bookings/booking-resume-service";
import type { RazorpayOrder } from "./razorpay-client";

type RecoveryProvider = {
  publicKeyId: string;
  findOrderByReceipt(receipt: string): Promise<RazorpayOrder | null>;
};

type RecoveryRow = {
  job_id: string;
  attempt_count: number;
  booking_id: string;
  property_id: string;
  public_reference: string;
  amount_paise: number;
  currency: "INR";
  hold_expires_at: Date | string;
  razorpay_order_id: string | null;
  razorpay_key_id: string | null;
};

type CurrentRecoveryState = {
  status: string;
  hold_expires_at: Date | string;
  razorpay_order_id: string | null;
  razorpay_key_id: string | null;
  has_active_hold: boolean;
};

export function orderReceipt(reference: string) {
  return `nh_${reference}`;
}

function validateOrder(order: RazorpayOrder, booking: RecoveryRow) {
  if (order.amount !== booking.amount_paise || order.currency !== "INR" || order.receipt !== orderReceipt(booking.public_reference)) {
    throw new Error("INVALID_RECOVERED_ORDER");
  }
  return order;
}

function checkoutResponse(booking: RecoveryRow, orderId: string, publicKeyId: string) {
  return {
    kind: "created",
    bookingReference: booking.public_reference,
    orderId,
    amountPaise: booking.amount_paise,
    currency: booking.currency,
    razorpayKeyId: publicKeyId,
    holdExpiresAt: new Date(booking.hold_expires_at).toISOString(),
  };
}

async function markRecoveryDefinitive(
  tx: InventoryTransaction,
  row: RecoveryRow,
  leaseToken: string,
  now: Date,
  code: string,
  providerId: string | null = null,
) {
  const [job] = await tx<{ id: string }[]>`
    update public.payment_jobs set status = 'definitive_failure', provider_id = coalesce(${providerId}, provider_id),
      last_error_code = ${code}, lease_token = null, lease_expires_at = null, updated_at = ${now}
    where id = ${row.job_id} and lease_token = ${leaseToken}
    returning id
  `;
  if (!job) throw new Error("ORDER_RECOVERY_LEASE_LOST");
  await tx`
    update public.booking_attempts set status = 'definitive_failure', terminal_http_status = 409,
      terminal_response = ${tx.json({ error: code })}, replay_until = ${new Date(now.getTime() + 30 * 60_000)},
      lease_token = null, lease_expires_at = null, updated_at = ${now}
    where booking_id = ${row.booking_id} and status in ('processing', 'retryable_failure')
  `;
}

async function currentRecoveryState(tx: InventoryTransaction, row: RecoveryRow) {
  const [state] = await tx<CurrentRecoveryState[]>`
    select b.status, b.hold_expires_at, b.razorpay_order_id, b.razorpay_key_id,
      exists (
        select 1 from public.inventory_nights i
        where i.booking_id = b.id and i.property_id = b.property_id
          and i.source_kind = 'website_hold' and i.status = 'active'
      ) as has_active_hold
    from public.bookings b where b.id = ${row.booking_id}
    for update of b
  `;
  return state ?? null;
}

function isRecoverableState(state: CurrentRecoveryState | null) {
  return Boolean(state && ["processing", "held"].includes(state.status) && state.has_active_hold);
}

async function closeInactiveRecovery(
  sql: postgres.Sql,
  row: RecoveryRow,
  leaseToken: string,
  now: Date,
) {
  const inventory = createInventoryService(sql);
  return inventory.withPropertyInventory(row.property_id, async (tx) => {
    const state = await currentRecoveryState(tx, row);
    if (isRecoverableState(state)) return false;
    await markRecoveryDefinitive(tx, row, leaseToken, now, "booking_no_longer_active");
    return true;
  });
}

async function finishRecoveredOrder(
  sql: postgres.Sql,
  row: RecoveryRow,
  leaseToken: string,
  orderId: string,
  publicKeyId: string,
  now: Date,
  resumeTokens: ReturnType<typeof createBookingResumeService> | null,
) {
  const inventory = createInventoryService(sql);
  return inventory.withPropertyInventory(row.property_id, async (tx) => {
    const state = await currentRecoveryState(tx, row);
    if (!isRecoverableState(state)) {
      await markRecoveryDefinitive(tx, row, leaseToken, now, "booking_no_longer_active", orderId);
      return false;
    }
    if (new Date(state!.hold_expires_at).getTime() <= now.getTime()) {
      await tx`
        update public.bookings set status = 'payment_failed', updated_at = ${now}
        where id = ${row.booking_id} and status in ('processing', 'held')
      `;
      await releaseSourceNights(tx, "website_hold", row.booking_id, "hold_expired_before_checkout");
      await markRecoveryDefinitive(tx, row, leaseToken, now, "booking_no_longer_active", orderId);
      return false;
    }
    if (state!.razorpay_order_id && state!.razorpay_order_id !== orderId) throw new Error("ORDER_ID_CONFLICT");
    const response = checkoutResponse(row, orderId, publicKeyId);
    const [saved] = await tx<{ razorpay_order_id: string }[]>`
      update public.bookings set razorpay_order_id = coalesce(razorpay_order_id, ${orderId}),
        razorpay_key_id = ${publicKeyId}, updated_at = ${now}
      where id = ${row.booking_id} and status in ('processing', 'held')
        and hold_expires_at > ${now}
        and (razorpay_order_id is null or razorpay_order_id = ${orderId})
        and exists (
          select 1 from public.inventory_nights i where i.booking_id = ${row.booking_id}
            and i.property_id = ${row.property_id} and i.source_kind = 'website_hold' and i.status = 'active'
        )
      returning razorpay_order_id
    `;
    if (!saved || saved.razorpay_order_id !== orderId) throw new Error("ORDER_RECOVERY_STATE_CHANGED");
    if (!resumeTokens) throw new Error("BOOKING_RESUME_NOT_CONFIGURED");
    await resumeTokens.issue(
      row.booking_id,
      new Date(row.hold_expires_at),
      tx as unknown as postgres.Sql,
    );
    if (state!.razorpay_key_id !== publicKeyId) {
      const changes = tx.json({ previousKeyId: state!.razorpay_key_id, currentKeyId: publicKeyId, source: "order_recovery" });
      await tx`
        insert into public.booking_events (property_id, booking_id, event_type, metadata)
        values (${row.property_id}, ${row.booking_id}, 'razorpay_account_rebound', ${changes})
      `;
      await tx`
        insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
        values (${row.property_id}, 'razorpay_account_rebound', 'website_booking', ${row.booking_id}, ${changes})
      `;
    }
    const [job] = await tx<{ id: string }[]>`
      update public.payment_jobs set status = 'succeeded', provider_id = ${orderId},
        terminal_result = ${tx.json(response)}, lease_token = null, lease_expires_at = null,
        last_error_code = null, updated_at = ${now}
      where id = ${row.job_id} and lease_token = ${leaseToken}
      returning id
    `;
    if (!job) throw new Error("ORDER_RECOVERY_LEASE_LOST");
    await tx`
      update public.booking_attempts set status = 'succeeded', durable_step = 'razorpay_order_created',
        terminal_http_status = 201, terminal_response = ${tx.json(response)},
        replay_until = ${new Date(now.getTime() + 30 * 60_000)}, lease_token = null,
        lease_expires_at = null, updated_at = ${now}
      where booking_id = ${row.booking_id}
        and (status = 'retryable_failure' or (status = 'processing' and lease_expires_at <= ${now}))
    `;
    return true;
  });
}

async function releaseExpiredOrderlessHold(
  sql: postgres.Sql,
  row: RecoveryRow,
  leaseToken: string,
  now: Date,
) {
  const inventory = createInventoryService(sql);
  await inventory.withPropertyInventory(row.property_id, async (tx) => {
    const state = await currentRecoveryState(tx, row);
    if (!isRecoverableState(state)) {
      await markRecoveryDefinitive(tx, row, leaseToken, now, "booking_no_longer_active");
      return;
    }
    const [released] = await tx<{ id: string }[]>`
      update public.bookings set status = 'payment_failed', updated_at = ${now}
      where id = ${row.booking_id} and razorpay_order_id is null
        and status in ('processing', 'held') and hold_expires_at <= ${now}
      returning id
    `;
    if (!released) throw new Error("ORDER_RECOVERY_STATE_CHANGED");
    await releaseSourceNights(tx, "website_hold", row.booking_id, "razorpay_order_not_found");
    await tx`
      update public.payment_jobs set status = 'definitive_failure', last_error_code = 'order_not_found',
        lease_token = null, lease_expires_at = null, updated_at = ${now}
      where id = ${row.job_id} and lease_token = ${leaseToken}
    `;
    await tx`
      update public.booking_attempts set status = 'definitive_failure', terminal_http_status = 503,
        terminal_response = ${tx.json({ error: "payment_order_failed" })},
        replay_until = ${new Date(now.getTime() + 30 * 60_000)}, lease_token = null,
        lease_expires_at = null, updated_at = ${now}
      where booking_id = ${row.booking_id}
    `;
    await tx`
      insert into public.booking_events (property_id, booking_id, event_type, metadata)
      values (${row.property_id}, ${row.booking_id}, 'payment_order_failed', ${tx.json({ reason: "order_not_found" })})
    `;
  });
}

export async function processOrderRecoveryJobs(
  sql: postgres.Sql,
  provider: RecoveryProvider,
  options: {
    now?: Date;
    limit?: number;
    resumeEncryptionKey?: string;
  } = {},
) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 25;
  const resumeTokens = options.resumeEncryptionKey
    ? createBookingResumeService(sql, {
        encryptionKey: options.resumeEncryptionKey,
        clock: () => now,
      })
    : null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_ORDER_RECOVERY_LIMIT");
  const leaseToken = randomUUID();
  const rows = await sql<RecoveryRow[]>`
    with ready as (
      select id from public.payment_jobs
      where job_kind = 'order_recovery' and status in ('pending', 'retryable_failure')
        and next_attempt_at <= ${now}
      order by next_attempt_at, created_at limit ${limit} for update skip locked
    )
    update public.payment_jobs j set status = 'processing', lease_token = ${leaseToken},
      lease_expires_at = ${new Date(now.getTime() + 60_000)}, attempt_count = attempt_count + 1,
      updated_at = ${now}
    from ready, public.bookings b
    where j.id = ready.id and b.id = j.booking_id
    returning j.id as job_id, j.attempt_count, b.id as booking_id, b.property_id,
      b.public_reference, b.amount_paise, b.currency, b.hold_expires_at,
      b.razorpay_order_id, b.razorpay_key_id
  `;
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (await closeInactiveRecovery(sql, row, leaseToken, now)) {
        processed += 1;
        continue;
      }
      if (row.razorpay_order_id) {
        if (row.razorpay_key_id !== provider.publicKeyId) {
          const recovered = await provider.findOrderByReceipt(orderReceipt(row.public_reference));
          if (!recovered || validateOrder(recovered, row).id !== row.razorpay_order_id) {
            throw new Error("RAZORPAY_ACCOUNT_MISMATCH");
          }
        }
        await finishRecoveredOrder(
          sql,
          row,
          leaseToken,
          row.razorpay_order_id,
          provider.publicKeyId,
          now,
          resumeTokens,
        );
        processed += 1;
        continue;
      }
      const order = await provider.findOrderByReceipt(orderReceipt(row.public_reference));
      if (order) {
        await finishRecoveredOrder(
          sql,
          row,
          leaseToken,
          validateOrder(order, row).id,
          provider.publicKeyId,
          now,
          resumeTokens,
        );
        processed += 1;
      } else if (new Date(row.hold_expires_at).getTime() <= now.getTime()) {
        await releaseExpiredOrderlessHold(sql, row, leaseToken, now);
        processed += 1;
      } else {
        await sql`
          update public.payment_jobs set status = 'retryable_failure', next_attempt_at = ${new Date(now.getTime() + 30_000)},
            lease_token = null, lease_expires_at = null, last_error_code = 'order_not_visible', updated_at = ${now}
          where id = ${row.job_id} and lease_token = ${leaseToken}
        `;
      }
    } catch {
      const delayMinutes = Math.min(10, 2 ** Math.min(row.attempt_count, 4));
      await sql`
        update public.payment_jobs set status = 'retryable_failure', next_attempt_at = ${new Date(now.getTime() + delayMinutes * 60_000)},
          lease_token = null, lease_expires_at = null, last_error_code = 'order_recovery_failed', updated_at = ${now}
        where id = ${row.job_id} and lease_token = ${leaseToken}
      `;
      failed += 1;
    }
  }
  return { processed, failed };
}
