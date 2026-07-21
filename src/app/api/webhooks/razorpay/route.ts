import { NextResponse } from "next/server";
import { processRazorpayWebhookEvent } from "@/features/payments/payment-reconciliation";
import { parseRazorpayWebhook, verifyRazorpayWebhookSignature } from "@/features/payments/razorpay-webhook";

export async function POST(request: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "webhook_not_configured" }, { status: 503 });
  const signature = request.headers.get("X-Razorpay-Signature") ?? "";
  const eventId = request.headers.get("X-Razorpay-Event-Id")?.trim();
  const rawBody = await request.text();
  if (!eventId || !verifyRazorpayWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  try {
    const event = parseRazorpayWebhook(rawBody);
    await processRazorpayWebhookEvent(eventId, event, rawBody);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && ["INVALID_RAZORPAY_WEBHOOK", "UNSUPPORTED_RAZORPAY_EVENT"].includes(error.message)) {
      return NextResponse.json({ error: "invalid_event" }, { status: 400 });
    }
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
