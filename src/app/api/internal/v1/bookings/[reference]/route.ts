import { z } from "zod";
import { NextResponse } from "next/server";
import { authenticateInternalRequest, InternalRequestAuthError } from "@/features/internal-api/request-auth";
import { BookingServiceError, getPublicBookingStatus } from "@/features/bookings/booking-service";

const referenceSchema = z.string().regex(/^NH-[A-Z0-9]{12,32}$/);

export async function GET(request: Request, context: { params: Promise<{ reference: string }> }) {
  if (process.env.PUBLIC_BOOKING_ENABLED !== "true") {
    return NextResponse.json({ error: "booking_disabled" }, { status: 503 });
  }
  try {
    await authenticateInternalRequest(request);
    const { reference } = await context.params;
    const status = await getPublicBookingStatus(referenceSchema.parse(reference));
    return NextResponse.json(request.headers.get("X-Noir-Api-Version") === "2"
      ? status
      : { status: status.status, refundStatus: status.refundStatus });
  } catch (error) {
    if (error instanceof InternalRequestAuthError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    if (error instanceof BookingServiceError) return NextResponse.json({ error: error.code.toLowerCase() }, { status: error.httpStatus });
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
}
