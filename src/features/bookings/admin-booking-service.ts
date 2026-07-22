import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";

type BookingSql = postgres.Sql;
export type BookingArchiveView = "active" | "archived" | "all";

export type AdminBookingNight = {
  stayDate: string;
  pricePaise: number;
  priceSource: "override" | "weekend" | "weekday";
};

export type AdminBookingNotification = {
  recipientKind: "guest" | "admin";
  templateKey: string;
  status: string;
  providerMessageId: string | null;
  lastErrorCode: string | null;
};

export type AdminBookingEvent = {
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AdminBookingRecord = {
  id: string;
  publicReference: string;
  propertyId: string;
  propertyName: string;
  guestName: string;
  bookerFirstName: string | null;
  bookerLastName: string | null;
  guestEmail: string;
  guestPhone: string;
  countryCode: string;
  specialRequests: string | null;
  guestCount: number;
  checkin: string;
  checkout: string;
  status: string;
  holdExpiresAt: string | null;
  amountPaise: number;
  currency: "INR";
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  razorpayKeyId: string | null;
  cancellationReason: string | null;
  refundStatus: string;
  razorpayRefundId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  nights: AdminBookingNight[];
  notifications: AdminBookingNotification[];
  events: AdminBookingEvent[];
};

function searchPattern(search: string | undefined) {
  const value = search?.trim().slice(0, 200);
  if (!value) return null;
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function createAdminBookingService(sql: BookingSql) {
  return {
    async listBookingsForUser(userId: string, search?: string, view: BookingArchiveView = "active"): Promise<AdminBookingRecord[]> {
      const pattern = searchPattern(search);
      const bookings = await sql<{
        id: string;
        public_reference: string;
        property_id: string;
        property_name: string;
        guest_name: string;
        booker_first_name: string | null;
        booker_last_name: string | null;
        guest_email: string;
        guest_phone: string;
        country_code: string;
        special_requests: string | null;
        guest_count: number;
        checkin: string;
        checkout: string;
        status: string;
        hold_expires_at: string | null;
        amount_paise: number;
        currency: "INR";
        razorpay_order_id: string | null;
        razorpay_payment_id: string | null;
        razorpay_key_id: string | null;
        cancellation_reason: string | null;
        refund_status: string;
        razorpay_refund_id: string | null;
        created_at: string;
        confirmed_at: string | null;
        cancelled_at: string | null;
        archived_at: string | null;
        archived_by: string | null;
      }[]>`
        select b.id, b.public_reference, b.property_id, p.name as property_name,
          b.guest_name, b.booker_first_name, b.booker_last_name,
          b.guest_email, b.guest_phone, b.country_code, b.special_requests, b.guest_count,
          b.checkin::text, b.checkout::text, b.status, b.hold_expires_at::text,
          b.amount_paise, b.currency, b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_key_id,
          b.cancellation_reason, b.refund_status, b.razorpay_refund_id,
          b.created_at::text, b.confirmed_at::text, b.cancelled_at::text,
          b.archived_at::text, b.archived_by
        from public.bookings b
        join public.properties p on p.id = b.property_id
        join public.property_members pm on pm.property_id = b.property_id and pm.user_id = ${userId}
        where (${view} = 'all'
          or (${view} = 'active' and b.archived_at is null)
          or (${view} = 'archived' and b.archived_at is not null))
          and (${pattern}::text is null or b.public_reference ilike ${pattern} escape '\\'
          or b.guest_name ilike ${pattern} escape '\\'
          or b.guest_email ilike ${pattern} escape '\\')
        order by b.created_at desc, b.id
        limit 200
      `;
      if (bookings.length === 0) return [];

      const bookingIds = bookings.map((booking) => booking.id);
      const [nights, notifications, events] = await Promise.all([
        sql<{ booking_id: string; stay_date: string; price_paise: number; price_source: AdminBookingNight["priceSource"] }[]>`
          select booking_id, stay_date::text, price_paise, price_source
          from public.booking_night_prices
          where booking_id in ${sql(bookingIds)}
          order by stay_date
        `,
        sql<{ booking_id: string; recipient_kind: AdminBookingNotification["recipientKind"]; template_key: string; status: string; provider_message_id: string | null; last_error_code: string | null }[]>`
          select booking_id, recipient_kind, template_key, status, provider_message_id, last_error_code
          from public.notification_outbox
          where booking_id in ${sql(bookingIds)}
          order by created_at, id
        `,
        sql<{ booking_id: string; event_type: string; metadata: Record<string, unknown>; created_at: string }[]>`
          select booking_id, event_type, metadata, created_at::text
          from public.booking_events
          where booking_id in ${sql(bookingIds)}
          order by created_at, id
        `,
      ]);

      return bookings.map((booking) => ({
        id: booking.id,
        publicReference: booking.public_reference,
        propertyId: booking.property_id,
        propertyName: booking.property_name,
        guestName: booking.guest_name,
        bookerFirstName: booking.booker_first_name,
        bookerLastName: booking.booker_last_name,
        guestEmail: booking.guest_email,
        guestPhone: booking.guest_phone,
        countryCode: booking.country_code,
        specialRequests: booking.special_requests,
        guestCount: booking.guest_count,
        checkin: booking.checkin,
        checkout: booking.checkout,
        status: booking.status,
        holdExpiresAt: booking.hold_expires_at,
        amountPaise: booking.amount_paise,
        currency: booking.currency,
        razorpayOrderId: booking.razorpay_order_id,
        razorpayPaymentId: booking.razorpay_payment_id,
        razorpayKeyId: booking.razorpay_key_id,
        cancellationReason: booking.cancellation_reason,
        refundStatus: booking.refund_status,
        razorpayRefundId: booking.razorpay_refund_id,
        createdAt: booking.created_at,
        confirmedAt: booking.confirmed_at,
        cancelledAt: booking.cancelled_at,
        archivedAt: booking.archived_at,
        archivedBy: booking.archived_by,
        nights: nights.filter((night) => night.booking_id === booking.id).map((night) => ({
          stayDate: night.stay_date,
          pricePaise: night.price_paise,
          priceSource: night.price_source,
        })),
        notifications: notifications.filter((notification) => notification.booking_id === booking.id).map((notification) => ({
          recipientKind: notification.recipient_kind,
          templateKey: notification.template_key,
          status: notification.status,
          providerMessageId: notification.provider_message_id,
          lastErrorCode: notification.last_error_code,
        })),
        events: events.filter((event) => event.booking_id === booking.id).map((event) => ({
          eventType: event.event_type,
          metadata: event.metadata,
          createdAt: event.created_at,
        })),
      }));
    },
  };
}

export function listBookingsForUser(userId: string, search?: string, view: BookingArchiveView = "active") {
  return createAdminBookingService(getDb()).listBookingsForUser(userId, search, view);
}
