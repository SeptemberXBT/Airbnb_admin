import "server-only";
import { reconcilePropertyNights, releaseSourceNights } from "@/features/inventory/inventory-service";
import type { InventoryTransaction } from "@/features/inventory/inventory-types";
import { enqueueNotification } from "@/features/email/outbox-service";
import { renderEmailTemplate } from "@/features/email/templates";

export async function cancelWebsiteBookingForAirbnbCollision(
  tx: InventoryTransaction,
  bookingId: string,
  externalEventId: string,
) {
  const [booking] = await tx<{
    id: string;
    property_id: string;
    property_name: string;
    public_reference: string;
    guest_name: string;
    guest_email: string;
    checkin: string;
    checkout: string;
    status: string;
    amount_paise: number;
    razorpay_payment_id: string | null;
    cancellation_reason: string | null;
  }[]>`
    select b.id, b.property_id, p.name as property_name, b.public_reference,
      b.guest_name, b.guest_email, b.checkin::text, b.checkout::text,
      b.status, b.amount_paise, b.razorpay_payment_id, b.cancellation_reason
    from public.bookings b join public.properties p on p.id = b.property_id
    where b.id = ${bookingId}
  `;
  if (!booking) throw new Error("BOOKING_NOT_FOUND");
  const [external] = await tx<{ id: string }[]>`
    select e.id from public.external_calendar_events e
    join public.listings l on l.id = e.listing_id
    where e.id = ${externalEventId} and l.property_id = ${booking.property_id}
      and e.event_type = 'reservation' and e.active = true and e.archived_at is null
      and e.start_date < ${booking.checkout} and e.end_date > ${booking.checkin}
  `;
  if (!external) throw new Error("INVALID_AIRBNB_COLLISION");

  const alreadyCancelled = booking.status === "cancelled" && booking.cancellation_reason === "airbnb_collision";
  if (!alreadyCancelled) {
    const refundRequired = Boolean(booking.razorpay_payment_id);
    await tx`
      update public.bookings
      set status = 'cancelled', cancellation_reason = 'airbnb_collision',
        refund_status = ${refundRequired ? "pending" : "not_required"},
        cancelled_at = coalesce(cancelled_at, now()), updated_at = now()
      where id = ${booking.id}
    `;
    await releaseSourceNights(tx, "website_hold", booking.id, "airbnb_collision");
    await releaseSourceNights(tx, "website_booking", booking.id, "airbnb_collision");
    await tx`
      update public.local_calendar_entries
      set active = false, archived_at = coalesce(archived_at, now()), updated_at = now()
      where booking_id = ${booking.id} and active = true
    `;
    if (refundRequired) await tx`
      insert into public.payment_jobs (
        booking_id, job_kind, idempotency_identity, status, next_attempt_at
      ) values (${booking.id}, 'refund', ${`refund:${booking.id}`}, 'pending', now())
      on conflict (booking_id) where job_kind = 'refund' do nothing
    `;
    await tx`
      insert into public.booking_events (property_id, booking_id, event_type, metadata)
      values (
        ${booking.property_id}, ${booking.id}, 'airbnb_collision',
        ${tx.json({ externalEventId, refundRequired })}
      )
    `;
    await tx`
      insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
      values (
        ${booking.property_id}, 'airbnb_collision', 'website_booking', ${booking.id},
        ${tx.json({ externalEventId, refundRequired })}
      )
    `;

    const templateKey = refundRequired ? "collision_refund_initiated" : "collision_no_refund";
    const message = renderEmailTemplate(templateKey, {
      guestName: booking.guest_name,
      propertyName: booking.property_name,
      bookingReference: booking.public_reference,
      checkin: booking.checkin,
      checkout: booking.checkout,
      amountPaise: booking.amount_paise,
    });
    await enqueueNotification(tx, {
      bookingId: booking.id,
      recipientKind: "guest",
      recipientEmail: booking.guest_email,
      templateKey,
      deduplicationKey: `airbnb-collision:${booking.id}:guest`,
      ...message,
    });
    const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    if (adminEmail) await enqueueNotification(tx, {
      bookingId: booking.id,
      recipientKind: "admin",
      recipientEmail: adminEmail,
      templateKey,
      deduplicationKey: `airbnb-collision:${booking.id}:admin`,
      ...message,
    });
  }

  await reconcilePropertyNights(tx, booking.property_id, booking.checkin, booking.checkout);
  return { cancelled: !alreadyCancelled, refundRequired: Boolean(booking.razorpay_payment_id) };
}
