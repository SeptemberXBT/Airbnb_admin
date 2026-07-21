import { z } from "zod";

export const PUBLIC_ROOM_SLUGS = [
  "sage-sunlight-studio",
  "ink-ivory-suite",
  "shade-of-love",
  "midnight-espresso-suite",
  "luxe-urban-nest",
  "emerald-suite",
  "linen-lace-suite",
  "silk-sage",
] as const;

export const publicRoomSlugSchema = z.enum(PUBLIC_ROOM_SLUGS);
export const stayDateSchema = z.iso.date();

export const baseRateInputSchema = z.object({
  propertyId: z.uuid(),
  publicRoomSlug: publicRoomSlugSchema,
  maxGuests: z.coerce.number().int().min(1).max(20),
  weekdayPricePaise: z.coerce.number().int().positive(),
  weekendPricePaise: z.coerce.number().int().positive(),
  bookingEnabled: z.boolean(),
}).strict();

export const baseRateBatchSchema = z.object({
  rates: z.array(baseRateInputSchema).min(1).max(PUBLIC_ROOM_SLUGS.length),
}).strict().superRefine(({ rates }, context) => {
  const slugs = new Set<string>();
  const propertyIds = new Set<string>();
  rates.forEach((rate, index) => {
    if (slugs.has(rate.publicRoomSlug)) {
      context.addIssue({ code: "custom", message: "Duplicate public room slug", path: ["rates", index, "publicRoomSlug"] });
    }
    if (propertyIds.has(rate.propertyId)) {
      context.addIssue({ code: "custom", message: "Duplicate property", path: ["rates", index, "propertyId"] });
    }
    slugs.add(rate.publicRoomSlug);
    propertyIds.add(rate.propertyId);
  });
});

const quoteRequestFields = {
  publicRoomSlug: publicRoomSlugSchema,
  checkin: stayDateSchema,
  checkout: stayDateSchema,
};

export function createQuoteRequestSchema(maxGuests = 20) {
  return z.object({
    ...quoteRequestFields,
    guests: z.coerce.number().int().min(1).max(maxGuests),
  }).strict().refine(({ checkin, checkout }) => checkout > checkin, {
    message: "Checkout must be after check-in",
    path: ["checkout"],
  });
}

export const quoteRequestSchema = createQuoteRequestSchema();

export const dateOverrideInputSchema = z.object({
  propertyId: z.uuid(),
  stayDate: stayDateSchema,
  pricePaise: z.coerce.number().int().positive(),
}).strict();

export const clearDateOverrideInputSchema = dateOverrideInputSchema.omit({ pricePaise: true });

export const pricingMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_base_rates"), rate: baseRateInputSchema }).strict(),
  z.object({
    action: z.literal("save_override"),
    propertyId: z.uuid(),
    stayDate: stayDateSchema,
    pricePaise: z.coerce.number().int().positive(),
  }).strict(),
  z.object({
    action: z.literal("clear_override"),
    propertyId: z.uuid(),
    stayDate: stayDateSchema,
  }).strict(),
]);

export type BaseRateInput = z.infer<typeof baseRateInputSchema>;
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type DateOverrideInput = z.infer<typeof dateOverrideInputSchema>;
export type ClearDateOverrideInput = z.infer<typeof clearDateOverrideInputSchema>;
export type PricingMutation = z.infer<typeof pricingMutationSchema>;
