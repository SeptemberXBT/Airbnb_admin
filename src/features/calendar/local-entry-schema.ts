import { z } from "zod";

const optionalPrivateText = z.string().trim().max(1_000).optional().nullable();
const optionalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable();

export const localEntrySchema = z.object({
  propertyId: z.uuid(),
  listingId: z.uuid().optional().nullable(),
  entryType: z.enum(["direct_reservation", "blocked"]),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  privateBookingName: optionalPrivateText,
  privateContact: optionalPrivateText,
  privateNote: optionalPrivateText,
  bookingSource: z.string().trim().max(100).optional().nullable(),
  syncToAirbnb: z.boolean().default(false),
  expectedCheckinTime: optionalTime,
  expectedCheckoutTime: optionalTime,
  cleaningDurationMinutes: z.number().int().min(5).max(480).optional().nullable(),
  allowOverlap: z.boolean().default(false),
}).refine((input) => input.endDate > input.startDate, {
  message: "End date must follow start date",
  path: ["endDate"],
});

export type LocalEntryInput = z.infer<typeof localEntrySchema>;
