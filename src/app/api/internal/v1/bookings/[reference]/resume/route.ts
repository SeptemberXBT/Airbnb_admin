import { z } from "zod";
import { NextResponse } from "next/server";

import {
  authenticateInternalRequest,
  InternalRequestAuthError,
} from "@/features/internal-api/request-auth";
import {
  configuredBookingRecoveryService,
} from "@/features/bookings/booking-recovery-service";
import { getPublicBookingStatus } from "@/features/bookings/booking-service";
import {
  BookingResumeServiceError,
} from "@/features/bookings/booking-resume-service";
import {
  PaymentReconciliationError,
} from "@/features/payments/payment-reconciliation";
import { scheduleBookingJobs } from "@/features/bookings/schedule-jobs";

const referenceSchema = z.string().regex(/^NH-[A-Z0-9]{12,32}$/);
const resumeSchema = z.object({
  resumeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ reference: string }> },
) {
  try {
    const { rawBody } = await authenticateInternalRequest(request);
    const { reference } = await context.params;
    const parsedReference = referenceSchema.parse(reference);
    const { resumeToken } = resumeSchema.parse(JSON.parse(rawBody));
    const result = await configuredBookingRecoveryService().resume(
      parsedReference,
      resumeToken,
    );
    scheduleBookingJobs();
    return NextResponse.json(
      request.headers.get("X-Noir-Api-Version") === "2"
        && !("kind" in result && result.kind === "resumable")
        ? await getPublicBookingStatus(parsedReference)
        : result,
    );
  } catch (error) {
    if (error instanceof InternalRequestAuthError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    if (error instanceof BookingResumeServiceError) {
      return NextResponse.json(
        { error: "booking_recovery_unavailable" },
        { status: error.httpStatus },
      );
    }
    if (error instanceof PaymentReconciliationError) {
      return NextResponse.json(
        { error: error.code.toLowerCase() },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "service_unavailable" },
      { status: 503 },
    );
  }
}
