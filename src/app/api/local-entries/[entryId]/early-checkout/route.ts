import {
  completeEarlyCheckout,
  EarlyCheckoutError,
} from "@/features/calendar/early-checkout-service";
import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from "next/server";
import { z } from "zod";

function earlyCheckoutErrorResponse(error: EarlyCheckoutError) {
  const responseError = error.code === "FORBIDDEN"
    ? "forbidden"
    : error.code === "NOT_FOUND"
      ? "not_found"
      : "ineligible_early_checkout";
  return NextResponse.json({ error: responseError }, { status: error.status });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ entryId: string }> },
) {
  try {
    const user = await requireUser();
    const entryId = z.uuid().parse((await params).entryId);
    const result = await completeEarlyCheckout(entryId, user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof EarlyCheckoutError) return earlyCheckoutErrorResponse(error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_entry_id" }, { status: 400 });
    }
    return NextResponse.json({ error: "operation_failed" }, { status: 500 });
  }
}
