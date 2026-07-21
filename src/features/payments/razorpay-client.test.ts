import { describe, expect, it, vi } from "vitest";
import { createRazorpayClient, RazorpayClientError } from "./razorpay-client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Razorpay adapter", () => {
  it("creates an INR order with Basic auth, integer paise, no partial payment, and a unique receipt", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      id: "order_test_1", amount: 1250000, currency: "INR", receipt: "nh_NH-TESTBOOKING01", status: "created",
    }));
    const client = createRazorpayClient({ keyId: "rzp_test_key", keySecret: "test_secret", fetchImpl });

    const order = await client.createOrder({ amountPaise: 1250000, receipt: "nh_NH-TESTBOOKING01" });

    expect(order.id).toBe("order_test_1");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("rzp_test_key:test_secret").toString("base64")}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      amount: 1250000, currency: "INR", receipt: "nh_NH-TESTBOOKING01", partial_payment: false,
    });
  });

  it("recovers and validates an order by receipt and fetches its payments", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ items: [
        { id: "order_other", amount: 1, currency: "INR", receipt: "other", status: "created" },
        { id: "order_match", amount: 900000, currency: "INR", receipt: "receipt-1", status: "created" },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "pay_1", status: "authorized", amount: 900000 }] }));
    const client = createRazorpayClient({ keyId: "key", keySecret: "secret", fetchImpl });
    expect(await client.findOrderByReceipt("receipt-1")).toMatchObject({ id: "order_match" });
    expect(await client.fetchOrderPayments("order_match")).toEqual([{ id: "pay_1", status: "authorized", amount: 900000 }]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.razorpay.com/v1/orders?receipt=receipt-1");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://api.razorpay.com/v1/orders/order_match/payments");
  });

  it("classifies HTTP rejection as definitive and network ambiguity without leaking provider bodies", async () => {
    const rejected = createRazorpayClient({
      keyId: "key", keySecret: "secret",
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("card-secret-provider-message", { status: 400 })),
    });
    await expect(rejected.createOrder({ amountPaise: 100, receipt: "receipt" })).rejects.toMatchObject({
      kind: "definitive", code: "RAZORPAY_REJECTED", message: "RAZORPAY_REJECTED",
    });

    const ambiguous = createRazorpayClient({
      keyId: "key", keySecret: "secret",
      fetchImpl: vi.fn<typeof fetch>(async () => { throw new TypeError("network leaked detail"); }),
    });
    await expect(ambiguous.createOrder({ amountPaise: 100, receipt: "receipt" })).rejects.toBeInstanceOf(RazorpayClientError);
    await expect(ambiguous.createOrder({ amountPaise: 100, receipt: "receipt" })).rejects.toMatchObject({
      kind: "ambiguous", code: "RAZORPAY_UNAVAILABLE", message: "RAZORPAY_UNAVAILABLE",
    });
  });
});
