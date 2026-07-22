export type BookingConfirmationEmailData = {
  guestName: string;
  propertyName: string;
  bookingReference: string;
  checkin: string;
  checkout: string;
  checkinTime: string;
  checkoutTime: string;
  guestCount: number;
  amountPaise: number;
  paymentId: string;
  supportEmail: string;
};

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] as string);
}

function formatStayDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return dateFormatter.format(new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  )));
}

function formatStayTime(value: string) {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = match[2];
  const period = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${minute} ${period}`;
}

function detailRow(label: string, value: string) {
  return `<tr><td style="padding:8px 0;color:#66716d;font-size:13px;line-height:20px;vertical-align:top;width:42%;">${escapeHtml(label)}</td><td style="padding:8px 0;color:#102f2a;font-size:14px;font-weight:600;line-height:20px;vertical-align:top;">${escapeHtml(value)}</td></tr>`;
}

export function renderBookingConfirmationEmail(data: BookingConfirmationEmailData) {
  const checkinDate = formatStayDate(data.checkin);
  const checkoutDate = formatStayDate(data.checkout);
  const checkinTime = formatStayTime(data.checkinTime);
  const checkoutTime = formatStayTime(data.checkoutTime);
  const amount = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(data.amountPaise / 100);
  const guestLabel = `${data.guestCount} ${data.guestCount === 1 ? "guest" : "guests"}`;
  const preheader = `Your reservation at ${data.propertyName} is confirmed for ${checkinDate} to ${checkoutDate}.`;
  const rows = [
    detailRow("Suite", data.propertyName),
    detailRow("Guests", guestLabel),
    detailRow("Check-in", `${checkinDate} · ${checkinTime}`),
    detailRow("Check-out", `${checkoutDate} · ${checkoutTime}`),
  ].join("");
  const receiptRows = [
    detailRow("Payment status", "Paid"),
    detailRow("Total paid", amount),
    detailRow("Payment reference", data.paymentId),
    detailRow("Booking reference", data.bookingReference),
  ].join("");

  const htmlBody = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Booking confirmed</title></head><body style="margin:0;background:#f4f0e9;color:#102f2a;font-family:Arial,Helvetica,sans-serif;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f0e9;"><tr><td align="center" style="padding:28px 12px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-collapse:collapse;"><tr><td style="background:#073e35;padding:28px 36px;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:4px;">NOIR HAUS</td></tr><tr><td style="padding:40px 36px 20px;"><div style="color:#b85b49;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Reservation confirmed</div><h1 style="margin:12px 0 18px;color:#073e35;font-size:32px;line-height:40px;">Your stay is confirmed</h1><p style="margin:0 0 12px;color:#30433f;font-size:16px;line-height:26px;">Dear ${escapeHtml(data.guestName)},</p><p style="margin:0;color:#30433f;font-size:16px;line-height:26px;">Thank you for choosing Noir Haus. We have received your payment and secured your reservation.</p></td></tr><tr><td style="padding:12px 36px 20px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f8f6;border:1px solid #dfe7e3;border-collapse:separate;padding:18px 22px;"><tr><td colspan="2" style="padding:0 0 10px;color:#073e35;font-size:17px;font-weight:700;">Your stay</td></tr>${rows}</table></td></tr><tr><td style="padding:0 36px 20px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;"><tr><td colspan="2" style="padding:12px 0;border-bottom:1px solid #dfe7e3;color:#073e35;font-size:17px;font-weight:700;">Payment receipt</td></tr>${receiptRows}</table></td></tr><tr><td style="padding:4px 36px 36px;"><h2 style="margin:0 0 10px;color:#073e35;font-size:18px;line-height:26px;">Arrival and support</h2><p style="margin:0 0 12px;color:#30433f;font-size:15px;line-height:24px;">Please keep your booking reference handy. If your arrival details change or you need assistance, our team will be happy to help.</p><p style="margin:0;color:#30433f;font-size:15px;line-height:24px;">Email us at <a href="mailto:${escapeHtml(data.supportEmail)}" style="color:#164896;font-weight:700;">${escapeHtml(data.supportEmail)}</a>.</p></td></tr><tr><td style="background:#073e35;padding:24px 36px;color:#dce8e3;font-size:12px;line-height:19px;">This transactional email confirms your Noir Haus reservation.<br>Booking reference: ${escapeHtml(data.bookingReference)}</td></tr></table></td></tr></table></body></html>`;

  const textBody = [
    "NOIR HAUS",
    "",
    "YOUR STAY IS CONFIRMED",
    "",
    `Dear ${data.guestName},`,
    "",
    "Thank you for choosing Noir Haus. We have received your payment and secured your reservation.",
    "",
    `SUITE: ${data.propertyName}`,
    `GUESTS: ${guestLabel}`,
    `CHECK-IN: ${checkinDate} · ${checkinTime}`,
    `CHECK-OUT: ${checkoutDate} · ${checkoutTime}`,
    "",
    "PAYMENT RECEIPT",
    "PAYMENT STATUS: Paid",
    `TOTAL PAID: ${amount}`,
    `PAYMENT REFERENCE: ${data.paymentId}`,
    `BOOKING REFERENCE: ${data.bookingReference}`,
    "",
    "Please keep your booking reference handy. If your arrival details change or you need assistance, our team will be happy to help.",
    `Support: ${data.supportEmail}`,
  ].join("\n");

  return {
    subject: `Your Noir Haus booking is confirmed — ${data.bookingReference}`,
    htmlBody,
    textBody,
  };
}
