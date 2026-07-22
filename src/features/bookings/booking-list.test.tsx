import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BookingList, type AdminBooking } from "./booking-list";

const booking: AdminBooking = {
  id: "booking-1",
  publicReference: "NH-BOOKING123456",
  propertyId: "property-1",
  propertyName: "Shade of Love",
  guestName: "Riya Sharma",
  bookerFirstName: "Riya",
  bookerLastName: "Sharma",
  guestEmail: "riya@example.test",
  guestPhone: "+919999999999",
  countryCode: "IN",
  specialRequests: "Late arrival",
  guestCount: 2,
  checkin: "2026-08-14",
  checkout: "2026-08-16",
  status: "confirmed",
  holdExpiresAt: null,
  amountPaise: 1_250_000,
  currency: "INR",
  razorpayOrderId: "order_test_123",
  razorpayPaymentId: "pay_test_123",
  razorpayKeyId: "rzp_live_example",
  cancellationReason: null,
  refundStatus: "not_required",
  razorpayRefundId: null,
  createdAt: "2026-07-21T10:00:00.000Z",
  confirmedAt: "2026-07-21T10:02:00.000Z",
  cancelledAt: null,
  archivedAt: null,
  archivedBy: null,
  nights: [
    { stayDate: "2026-08-14", pricePaise: 600_000, priceSource: "weekday" },
    { stayDate: "2026-08-15", pricePaise: 650_000, priceSource: "weekend" },
  ],
  notifications: [
    { recipientKind: "guest", templateKey: "booking_confirmation_guest", status: "sent", providerMessageId: "zepto-1", lastErrorCode: null },
  ],
  events: [
    { eventType: "booking_confirmed", metadata: { source: "razorpay" }, createdAt: "2026-07-21T10:02:00.000Z" },
  ],
};

describe("BookingList", () => {
  it("shows premium guest detail and exposes the guarded full refund action", () => {
    render(<BookingList bookings={[booking]} />);

    const cards = screen.getAllByRole("article", { name: /NH-BOOKING123456/i });
    const card = cards[cards.length - 1];
    expect(within(card).getAllByText("Riya Sharma")[0]).toBeVisible();
    expect(within(card).getByText("riya@example.test")).toBeVisible();
    expect(within(card).getByText("₹12,500")).toBeVisible();
    expect(within(card).getByText("order_test_123")).toBeVisible();
    expect(within(card).getByText("pay_test_123")).toBeVisible();
    expect(within(card).getByText("14 Aug 2026")).toBeVisible();
    expect(within(card).getByText("₹6,000 · weekday")).toBeVisible();
    expect(within(card).getByText(/booking_confirmation_guest · sent/i)).toBeVisible();
    expect(within(card).getByText(/booking_confirmed/i)).toBeVisible();
    expect(within(card).getByText("Late arrival")).toBeVisible();
    expect(within(card).getByRole("button", { name: /refund, cancel & archive/i })).toBeVisible();
  });

  it("does not offer another refund for archived bookings", () => {
    render(<BookingList bookings={[{ ...booking, status: "cancelled", refundStatus: "processed", archivedAt: "2026-07-22T10:00:00Z" }]} />);
    const cards = screen.getAllByRole("article", { name: /NH-BOOKING123456/i });
    const card = cards[cards.length - 1];
    expect(within(card).queryByRole("button", { name: /refund, cancel & archive/i })).not.toBeInTheDocument();
    expect(within(card).getByText(/archived/i)).toBeVisible();
  });

  it("offers test cleanup instead of a live refund for a test-mode booking", () => {
    render(<BookingList bookings={[{ ...booking, razorpayKeyId: "rzp_test_example" }]} />);
    const cards = screen.getAllByRole("article", { name: /NH-BOOKING123456/i });
    const card = cards[cards.length - 1];
    expect(within(card).getByRole("button", { name: /remove test booking/i })).toBeVisible();
    expect(within(card).queryByRole("button", { name: /refund, cancel & archive/i })).not.toBeInTheDocument();
  });

  it("offers an audited retry when an archived admin refund failed", () => {
    render(<BookingList bookings={[{
      ...booking,
      status: "cancelled",
      cancellationReason: "admin_refund",
      refundStatus: "failed",
      archivedAt: "2026-07-22T10:00:00Z",
    }]} />);
    expect(screen.getByRole("button", { name: /retry full refund/i })).toBeVisible();
  });

  it("renders an empty search result", () => {
    render(<BookingList bookings={[]} />);
    expect(screen.getByText("No bookings match this search.")).toBeVisible();
  });
});
