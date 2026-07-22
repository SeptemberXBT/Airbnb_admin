import { describe, expect, it } from "vitest";
import { renderBookingConfirmationEmail } from "./booking-confirmation-template";

const booking = {
  guestName: "A & <B>",
  propertyName: "Shade <of> Love",
  bookingReference: "NH-EMAILTEST001",
  checkin: "2026-08-14",
  checkout: "2026-08-16",
  checkinTime: "13:00:00",
  checkoutTime: "11:00:00",
  guestCount: 2,
  amountPaise: 1200000,
  paymentId: "pay_confirmed_123",
  supportEmail: "hello@noirhaus.in",
};

describe("professional booking confirmation email", () => {
  it("renders a complete branded HTML and plain-text confirmation", () => {
    const message = renderBookingConfirmationEmail(booking);

    expect(message.subject).toBe("Your Noir Haus booking is confirmed — NH-EMAILTEST001");
    expect(message.htmlBody).toContain("Your stay is confirmed");
    expect(message.htmlBody).toContain("Friday, 14 August 2026");
    expect(message.htmlBody).toContain("Sunday, 16 August 2026");
    expect(message.htmlBody).toContain("1:00 PM");
    expect(message.htmlBody).toContain("11:00 AM");
    expect(message.htmlBody).toContain("2 guests");
    expect(message.htmlBody).toContain("₹12,000.00");
    expect(message.htmlBody).toContain("pay_confirmed_123");
    expect(message.htmlBody).toContain("mailto:hello@noirhaus.in");
    expect(message.textBody).toContain("BOOKING REFERENCE: NH-EMAILTEST001");
    expect(message.textBody).toContain("PAYMENT STATUS: Paid");
  });

  it("escapes dynamic HTML and remains text-led without external images", () => {
    const message = renderBookingConfirmationEmail(booking);

    expect(message.htmlBody).toContain("A &amp; &lt;B&gt;");
    expect(message.htmlBody).toContain("Shade &lt;of&gt; Love");
    expect(message.htmlBody).not.toContain("A & <B>");
    expect(message.htmlBody).not.toMatch(/<img\b/i);
    expect(message.htmlBody).not.toMatch(/rzp_(?:test|live)_/i);
  });
});
