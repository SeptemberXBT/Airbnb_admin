import { z } from "zod";
import { NextResponse } from "next/server";
import { authenticateInternalRequest, InternalRequestAuthError } from "@/features/internal-api/request-auth";
import { PaymentReconciliationError } from "@/features/payments/payment-reconciliation";
import { scheduleBookingJobs } from "@/features/bookings/schedule-jobs";
import { getPublicBookingStatus } from "@/features/bookings/booking-service";
import { configuredBookingRecoveryService } from "@/features/bookings/booking-recovery-service";
import { BookingResumeServiceError } from "@/features/bookings/booking-resume-service";

const referenceSchema = z.string().regex(/^NH-[A-Z0-9]{12,32}$/);
const reconcileSchema = z.object({
  trigger: z.enum(["client_callback", "checkout_dismissed"]),
  resumeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ reference: string }> }) {
  try {
    const { rawBody } = await authenticateInternalRequest(request);
    const { reference } = await context.params;
    const input = reconcileSchema.parse(JSON.parse(rawBody));
    const parsedReference = referenceSchema.parse(reference);
    const result = await configuredBookingRecoveryService().reconcile(
      parsedReference,
      input.resumeToken,
      input.trigger,
    );
    scheduleBookingJobs();
    return NextResponse.json(request.headers.get("X-Noir-Api-Version") === "2"
      ? await getPublicBookingStatus(parsedReference)
      : result);
  } catch (error) {
    if (error instanceof InternalRequestAuthError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    if (error instanceof BookingResumeServiceError) {
      return NextResponse.json({ error: "booking_recovery_unavailable" }, { status: error.httpStatus });
    }
    if (error instanceof PaymentReconciliationError) {
      return NextResponse.json({ error: error.code.toLowerCase() }, { status: error.httpStatus });
    }
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
}
