import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRazorpayWebhook, verifyRazorpayWebhookSignature } from "./razorpay-webhook";

const secret = "webhook_test_secret";
const rawBody = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_test", order_id: "order_test", status: "captured", amount: 950000 } } },
});
const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

describe("Razorpay webhook verification", () => {
  it("verifies the exact raw body and extracts a supported payment event", () => {
    expect(verifyRazorpayWebhookSignature(rawBody, signature, secret)).toBe(true);
    expect(parseRazorpayWebhook(rawBody)).toEqual({
      eventType: "payment.captured",
      orderId: "order_test",
      paymentId: "pay_test",
      paymentStatus: "captured",
      amountPaise: 950000,
    });
  });

  it("rejects altered bodies and malformed signatures", () => {
    expect(verifyRazorpayWebhookSignature(`${rawBody} `, signature, secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(rawBody, "not-hex", secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(rawBody, "00", secret)).toBe(false);
  });

  it.each(["payment.authorized", "payment.failed"])("parses %s", (eventType) => {
    const status = eventType.split(".")[1];
    const parsed = parseRazorpayWebhook(JSON.stringify({
      event: eventType,
      payload: { payment: { entity: { id: `pay_${status}`, order_id: "order_test", status, amount: 950000 } } },
    }));
    expect(parsed).toMatchObject({ eventType, paymentStatus: status });
  });

  it("parses order.paid for provider reconciliation", () => {
    expect(parseRazorpayWebhook(JSON.stringify({
      event: "order.paid",
      payload: { order: { entity: { id: "order_paid", status: "paid", amount: 950000 } } },
    }))).toEqual({
      eventType: "order.paid", orderId: "order_paid", paymentId: null, paymentStatus: "paid", amountPaise: 950000,
    });
  });
});
