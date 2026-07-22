import type { AdminBookingRecord } from "./admin-booking-service";
import { BookingRefundAction } from "./booking-refund-action";
import { BookingTestCleanupAction } from "./booking-test-cleanup-action";

export type AdminBooking = AdminBookingRecord;

function money(paise: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

function date(value: string) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function dateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function identifier(value: string | null) {
  return value || "—";
}

export function BookingList({ bookings }: { bookings: AdminBooking[] }) {
  if (bookings.length === 0) return <div className="list-empty">No bookings match this search.</div>;

  return (
    <div className="booking-list">
      {bookings.map((booking) => {
        const isTestBooking = booking.razorpayKeyId?.startsWith("rzp_test_") ?? false;
        return <article className="booking-card" aria-label={`Booking ${booking.publicReference}`} key={booking.id}>
          <header className="booking-card__header">
            <div><span>{booking.propertyName}</span><h2>{booking.publicReference}</h2></div>
            <span className={`booking-status booking-status--${booking.status}`}>{booking.archivedAt ? "archived" : booking.status.replaceAll("_", " ")}</span>
          </header>
          <div className="booking-card__summary">
            <div><span>Guest</span><strong>{booking.guestName}</strong><small><span>{booking.guestEmail}</span> · <span>{booking.guestPhone}</span></small></div>
            <div><span>Stay</span><strong>{date(booking.checkin)} – {date(booking.checkout)}</strong><small>{booking.guestCount} guest{booking.guestCount === 1 ? "" : "s"}</small></div>
            <div><span>Total</span><strong>{money(booking.amountPaise)}</strong><small>{booking.nights.length} night{booking.nights.length === 1 ? "" : "s"}</small></div>
            <div><span>Created</span><strong>{dateTime(booking.createdAt)}</strong><small>Confirmed {dateTime(booking.confirmedAt)}</small></div>
          </div>
          <details className="booking-detail" open>
            <summary>Payment, nightly price, and event detail</summary>
            <div className="booking-detail__grid">
              <section><h3>Payment</h3><dl><dt>Account key</dt><dd>{identifier(booking.razorpayKeyId)}</dd><dt>Order ID</dt><dd>{identifier(booking.razorpayOrderId)}</dd><dt>Payment ID</dt><dd>{identifier(booking.razorpayPaymentId)}</dd><dt>Refund</dt><dd>{booking.refundStatus}</dd><dt>Refund ID</dt><dd>{identifier(booking.razorpayRefundId)}</dd></dl></section>
              <section><h3>Immutable nightly prices</h3>{booking.nights.length ? <ul>{booking.nights.map((night) => <li key={night.stayDate}><span>{date(night.stayDate)}</span><strong>{money(night.pricePaise)} · {night.priceSource}</strong></li>)}</ul> : <p>No nightly snapshot recorded.</p>}</section>
              <section><h3>Email outbox</h3>{booking.notifications.length ? <ul>{booking.notifications.map((notification, index) => <li key={`${notification.templateKey}-${index}`}><span>{notification.recipientKind}</span><strong>{notification.templateKey} · {notification.status}</strong><small>{identifier(notification.providerMessageId)}{notification.lastErrorCode ? ` · ${notification.lastErrorCode}` : ""}</small></li>)}</ul> : <p>No email events yet.</p>}</section>
              <section><h3>Booking events</h3>{booking.events.length ? <ul>{booking.events.map((event, index) => <li key={`${event.eventType}-${index}`}><span>{dateTime(event.createdAt)}</span><strong>{event.eventType}</strong></li>)}</ul> : <p>No booking events yet.</p>}</section>
              <section><h3>Guest requests</h3><dl><dt>Booker</dt><dd>{[booking.bookerFirstName, booking.bookerLastName].filter(Boolean).join(" ") || booking.guestName}</dd><dt>Country</dt><dd>{booking.countryCode}</dd><dt>Requests</dt><dd>{booking.specialRequests || "—"}</dd></dl></section>
            </div>
          </details>
          {!booking.archivedAt && isTestBooking
            ? <BookingTestCleanupAction bookingId={booking.id} publicReference={booking.publicReference} />
            : null}
          {!booking.archivedAt && !isTestBooking && booking.status === "confirmed" && booking.razorpayPaymentId
            ? <BookingRefundAction bookingId={booking.id} publicReference={booking.publicReference} />
            : null}
          {booking.archivedAt && booking.cancellationReason === "admin_refund"
            && booking.refundStatus === "failed" && booking.razorpayPaymentId
            ? <BookingRefundAction bookingId={booking.id} publicReference={booking.publicReference} retry />
            : null}
        </article>;
      })}
    </div>
  );
}
