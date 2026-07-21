import { describe, expect, it, vi } from "vitest";
import { createRazorpayRefundProvider } from "./refund-service";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

describe("Razorpay full refund adapter", () => {
  it("creates a full-source refund without accepting an amount", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ id: "rfnd_1", status: "pending", notes: { noirhaus_identity: "collision-refund:1" } }));
    const provider = createRazorpayRefundProvider({ keyId: "key", keySecret: "secret", fetchImpl });
    expect(await provider.createFullRefund("pay_1", "collision-refund:1")).toMatchObject({ id: "rfnd_1", status: "pending" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/payments/pay_1/refund");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ notes: { noirhaus_identity: "collision-refund:1" } });
    expect(body).not.toHaveProperty("amount");
  });

  it("finds a prior refund by idempotency identity before retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ items: [
      { id: "rfnd_other", status: "processed", notes: { noirhaus_identity: "other" } },
      { id: "rfnd_match", status: "processed", notes: { noirhaus_identity: "collision-refund:1" } },
    ] }));
    const provider = createRazorpayRefundProvider({ keyId: "key", keySecret: "secret", fetchImpl });
    expect(await provider.findRefund("pay_1", "collision-refund:1")).toMatchObject({ id: "rfnd_match", status: "processed" });
  });
});
