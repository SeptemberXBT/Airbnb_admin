import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "./templates";

const booking = {
  guestName: "A & B",
  propertyName: "Shade <Love>",
  bookingReference: "NH-EMAILTEST001",
  checkin: "2026-08-14",
  checkout: "2026-08-16",
  amountPaise: 1200000,
};

describe("transactional email templates", () => {
  it.each([
    "admin_new_booking",
    "collision_no_refund",
    "collision_refund_initiated",
    "refund_processed",
    "late_payment_refund",
    "refund_failed_admin",
  ] as const)("renders HTML and text for %s without unescaped guest HTML", (templateKey) => {
    const message = renderEmailTemplate(templateKey, booking);
    expect(message.subject).toContain("NH-EMAILTEST001");
    expect(message.textBody).toContain("A & B");
    expect(message.htmlBody).toContain("A &amp; B");
    expect(message.htmlBody).not.toContain("Shade <Love>");
  });
});
