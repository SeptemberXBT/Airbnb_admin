import { createHmac, timingSafeEqual } from "node:crypto";

export type ParsedRazorpayWebhook = {
  eventType: "payment.authorized" | "payment.captured" | "payment.failed" | "order.paid";
  orderId: string;
  paymentId: string | null;
  paymentStatus: string;
  amountPaise: number;
};

export function verifyRazorpayWebhookSignature(rawBody: string, signature: string, secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"), "hex");
  const provided = Buffer.from(signature, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function parseRazorpayWebhook(rawBody: string): ParsedRazorpayWebhook {
  let value: unknown;
  try {
    value = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("INVALID_RAZORPAY_WEBHOOK");
  }
  if (!value || typeof value !== "object") throw new Error("INVALID_RAZORPAY_WEBHOOK");
  const event = value as { event?: unknown; payload?: Record<string, { entity?: unknown }> };
  if (![
    "payment.authorized", "payment.captured", "payment.failed", "order.paid",
  ].includes(String(event.event))) throw new Error("UNSUPPORTED_RAZORPAY_EVENT");

  if (event.event === "order.paid") {
    const entity = event.payload?.order?.entity;
    if (!entity || typeof entity !== "object") throw new Error("INVALID_RAZORPAY_WEBHOOK");
    const order = entity as Record<string, unknown>;
    if (typeof order.id !== "string" || order.status !== "paid" || !Number.isSafeInteger(order.amount)) {
      throw new Error("INVALID_RAZORPAY_WEBHOOK");
    }
    return {
      eventType: "order.paid",
      orderId: order.id,
      paymentId: null,
      paymentStatus: "paid",
      amountPaise: order.amount as number,
    };
  }

  const entity = event.payload?.payment?.entity;
  if (!entity || typeof entity !== "object") throw new Error("INVALID_RAZORPAY_WEBHOOK");
  const payment = entity as Record<string, unknown>;
  if (
    typeof payment.id !== "string"
    || typeof payment.order_id !== "string"
    || typeof payment.status !== "string"
    || !Number.isSafeInteger(payment.amount)
  ) throw new Error("INVALID_RAZORPAY_WEBHOOK");
  return {
    eventType: event.event as ParsedRazorpayWebhook["eventType"],
    orderId: payment.order_id,
    paymentId: payment.id,
    paymentStatus: payment.status,
    amountPaise: payment.amount as number,
  };
}
