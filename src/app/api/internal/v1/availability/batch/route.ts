import { z } from "zod";
import { NextResponse } from "next/server";
import {
  availabilityBatchRequestSchema,
} from "@/features/bookings/booking-schema";
import {
  BookingServiceError,
  quoteAvailabilityBatch,
} from "@/features/bookings/booking-service";
import {
  authenticateInternalRequest,
  InternalRequestAuthError,
} from "@/features/internal-api/request-auth";

const noStore = { "Cache-Control": "no-store" };

function json(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

function errorResponse(error: unknown) {
  if (error instanceof InternalRequestAuthError) return json({ error: "unauthorized" }, 401);
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return json({ error: "invalid_request" }, 400);
  }
  if (error instanceof BookingServiceError) {
    return json({ error: error.code.toLowerCase() }, error.httpStatus);
  }
  return json({ error: "service_unavailable" }, 503);
}

export async function POST(request: Request) {
  const availabilityEnabled =
    process.env.PUBLIC_AVAILABILITY_ENABLED === "true"
    || process.env.PUBLIC_BOOKING_ENABLED === "true";
  if (!availabilityEnabled) return json({ error: "booking_disabled" }, 503);

  try {
    const { rawBody } = await authenticateInternalRequest(request);
    const input = availabilityBatchRequestSchema.parse(JSON.parse(rawBody));
    return json(await quoteAvailabilityBatch(input));
  } catch (error) {
    return errorResponse(error);
  }
}
