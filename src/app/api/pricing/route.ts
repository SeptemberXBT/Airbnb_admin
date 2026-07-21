import { z } from "zod";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { pricingMutationSchema } from "@/features/pricing/pricing-schema";
import {
  clearDateOverride,
  listPricingForUser,
  saveBaseRates,
  saveDateOverride,
} from "@/features/pricing/pricing-service";

function pricingError(error: unknown) {
  if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_pricing", fields: z.flattenError(error).fieldErrors }, { status: 400 });
  if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (error instanceof Error && error.message === "FORBIDDEN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (error instanceof Error && error.message === "NOT_FOUND") return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ error: "operation_failed" }, { status: 500 });
}

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ pricing: await listPricingForUser(user.id) });
  } catch (error) {
    return pricingError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const mutation = pricingMutationSchema.parse(await request.json());
    if (mutation.action === "save_base_rates") await saveBaseRates(mutation.rate, user.id);
    if (mutation.action === "save_override") await saveDateOverride({
      propertyId: mutation.propertyId,
      stayDate: mutation.stayDate,
      pricePaise: mutation.pricePaise,
    }, user.id);
    if (mutation.action === "clear_override") await clearDateOverride({
      propertyId: mutation.propertyId,
      stayDate: mutation.stayDate,
    }, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return pricingError(error);
  }
}
