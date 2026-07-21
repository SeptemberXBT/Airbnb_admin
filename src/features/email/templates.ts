export type EmailTemplateKey =
  | "booking_confirmation"
  | "admin_new_booking"
  | "collision_no_refund"
  | "collision_refund_initiated"
  | "refund_processed"
  | "late_payment_refund"
  | "refund_failed_admin";

export type EmailTemplateData = {
  guestName: string;
  propertyName: string;
  bookingReference: string;
  checkin: string;
  checkout: string;
  amountPaise: number;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",
  })[character] as string);
}

function copy(key: EmailTemplateKey) {
  const values: Record<EmailTemplateKey, { title: string; message: string }> = {
    booking_confirmation: { title: "Booking confirmed", message: "Your stay is confirmed." },
    admin_new_booking: { title: "New website booking", message: "A website booking has been confirmed." },
    collision_no_refund: { title: "Booking cancelled", message: "An Airbnb calendar conflict means we cannot host this stay. No payment was captured." },
    collision_refund_initiated: { title: "Booking cancelled — refund initiated", message: "An Airbnb calendar conflict means we cannot host this stay. Your full refund has been initiated." },
    refund_processed: { title: "Refund processed", message: "Your full refund has been processed by the payment provider." },
    late_payment_refund: { title: "Late payment refund initiated", message: "A payment arrived after the hold expired, so it is being returned in full." },
    refund_failed_admin: { title: "Refund needs attention", message: "The automatic refund failed and requires admin follow-up." },
  };
  return values[key];
}

export function renderEmailTemplate(key: EmailTemplateKey, data: EmailTemplateData) {
  const content = copy(key);
  const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(data.amountPaise / 100);
  const details = [
    `Guest: ${data.guestName}`,
    `Room: ${data.propertyName}`,
    `Reference: ${data.bookingReference}`,
    `Stay: ${data.checkin} to ${data.checkout}`,
    `Amount: ${amount}`,
  ];
  const textBody = `${content.message}\n\n${details.join("\n")}`;
  const htmlBody = `<p>${escapeHtml(content.message)}</p><dl>${details.map((detail) => {
    const [label, ...rest] = detail.split(": ");
    return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(rest.join(": "))}</dd>`;
  }).join("")}</dl>`;
  return {
    subject: `${content.title} — ${data.bookingReference}`,
    htmlBody,
    textBody,
  };
}
