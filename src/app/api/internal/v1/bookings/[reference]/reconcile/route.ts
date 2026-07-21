import { z } from "zod";
import { NextResponse } from "next/server";
import { authenticateInternalRequest, InternalRequestAuthError } from "@/features/internal-api/request-auth";
import { PaymentReconciliationError, reconcileBooking } from "@/features/payments/payment-reconciliation";

const referenceSchema = z.string().regex(/^NH-[A-Z0-9]{12,32}$/);
const reconcileSchema = z.object({
  trigger: z.enum(["client_callback", "checkout_dismissed"]),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ reference: string }> }) {
  try {
    const { rawBody } = await authenticateInternalRequest(request);
    const { reference } = await context.params;
    const input = reconcileSchema.parse(JSON.parse(rawBody));
    return NextResponse.json(await reconcileBooking(referenceSchema.parse(reference), input.trigger));
  } catch (error) {
    if (error instanceof InternalRequestAuthError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    if (error instanceof PaymentReconciliationError) {
      return NextResponse.json({ error: error.code.toLowerCase() }, { status: error.httpStatus });
    }
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
}
