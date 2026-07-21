import { z } from "zod";
import { NextResponse } from "next/server";
import { authenticateInternalRequest, InternalRequestAuthError } from "@/features/internal-api/request-auth";
import { availabilityRequestSchema } from "@/features/bookings/booking-schema";
import { BookingServiceError, quoteAvailability } from "@/features/bookings/booking-service";

function errorResponse(error: unknown) {
  if (error instanceof InternalRequestAuthError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (error instanceof BookingServiceError) return NextResponse.json({ error: error.code.toLowerCase() }, { status: error.httpStatus });
  return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
}

export async function POST(request: Request) {
  if (process.env.PUBLIC_BOOKING_ENABLED !== "true") {
    return NextResponse.json({ error: "booking_disabled" }, { status: 503 });
  }
  try {
    const { rawBody } = await authenticateInternalRequest(request);
    const input = availabilityRequestSchema.parse(JSON.parse(rawBody));
    return NextResponse.json(await quoteAvailability(input));
  } catch (error) {
    return errorResponse(error);
  }
}
