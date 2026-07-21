import "server-only";

export type RazorpayOrder = {
  id: string;
  amount: number;
  currency: "INR";
  receipt: string;
  status: string;
};

export type RazorpayPayment = {
  id: string;
  status: string;
  amount: number;
};

export class RazorpayClientError extends Error {
  constructor(
    public readonly kind: "definitive" | "ambiguous",
    public readonly code: "RAZORPAY_REJECTED" | "RAZORPAY_UNAVAILABLE" | "RAZORPAY_INVALID_RESPONSE",
  ) {
    super(code);
    this.name = "RazorpayClientError";
  }
}

type RazorpayOptions = {
  keyId: string;
  keySecret: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

function parseOrder(value: unknown): RazorpayOrder {
  if (!value || typeof value !== "object") throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
  const order = value as Record<string, unknown>;
  if (
    typeof order.id !== "string"
    || !Number.isSafeInteger(order.amount)
    || order.currency !== "INR"
    || typeof order.receipt !== "string"
    || typeof order.status !== "string"
  ) throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
  return order as RazorpayOrder;
}

function parsePayments(value: unknown): RazorpayPayment[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) {
    throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
  }
  return (value as { items: unknown[] }).items.map((item) => {
    if (!item || typeof item !== "object") throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
    const payment = item as Record<string, unknown>;
    if (typeof payment.id !== "string" || typeof payment.status !== "string" || !Number.isSafeInteger(payment.amount)) {
      throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
    }
    return payment as RazorpayPayment;
  });
}

export function createRazorpayClient(options: RazorpayOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.razorpay.com";
  const authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`;

  async function request(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: authorization,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 8_000),
      });
    } catch {
      throw new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE");
    }
    if (!response.ok) {
      const ambiguous = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new RazorpayClientError(ambiguous ? "ambiguous" : "definitive", ambiguous ? "RAZORPAY_UNAVAILABLE" : "RAZORPAY_REJECTED");
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
    }
  }

  return {
    publicKeyId: options.keyId,

    async createOrder(input: { amountPaise: number; receipt: string }) {
      if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0 || !input.receipt || input.receipt.length > 40) {
        throw new Error("INVALID_RAZORPAY_ORDER");
      }
      return parseOrder(await request("/v1/orders", {
        method: "POST",
        body: JSON.stringify({
          amount: input.amountPaise,
          currency: "INR",
          receipt: input.receipt,
          partial_payment: false,
        }),
      }));
    },

    async findOrderByReceipt(receipt: string): Promise<RazorpayOrder | null> {
      const value = await request(`/v1/orders?receipt=${encodeURIComponent(receipt)}`);
      if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) {
        throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
      }
      const matches = (value as { items: unknown[] }).items
        .map(parseOrder)
        .filter((order) => order.receipt === receipt);
      if (matches.length > 1) throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
      return matches[0] ?? null;
    },

    async fetchOrderPayments(orderId: string) {
      return parsePayments(await request(`/v1/orders/${encodeURIComponent(orderId)}/payments`));
    },
  };
}

export type RazorpayClient = ReturnType<typeof createRazorpayClient>;
