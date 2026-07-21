import { z } from "zod";
import { NextResponse } from "next/server";
import { authenticateInternalRequest, InternalRequestAuthError } from "@/features/internal-api/request-auth";
import { bookingRequestSchema } from "@/features/bookings/booking-schema";
import { BookingServiceError, createBooking } from "@/features/bookings/booking-service";

const idempotencyKeySchema = z.uuid();

function errorResponse(error: unknown) {
  if (error instanceof InternalRequestAuthError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (error instanceof BookingServiceError) {
    const headers = error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : undefined;
    if (error.httpStatus === 202) return NextResponse.json({ status: "processing" }, { status: 202, headers });
    return NextResponse.json({ error: error.code.toLowerCase() }, { status: error.httpStatus, headers });
  }
  return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
}

export async function POST(request: Request) {
  if (process.env.PUBLIC_BOOKING_ENABLED !== "true") {
    return NextResponse.json({ error: "booking_disabled" }, { status: 503 });
  }
  try {
    const { rawBody } = await authenticateInternalRequest(request);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers.get("Idempotency-Key"));
    const input = bookingRequestSchema.parse(JSON.parse(rawBody));
    return NextResponse.json(await createBooking(input, idempotencyKey), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
