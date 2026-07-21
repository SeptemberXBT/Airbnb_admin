import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";
import { publicRoomSlugSchema, stayDateSchema } from "@/features/pricing/pricing-schema";

const stayFields = {
  publicRoomSlug: publicRoomSlugSchema,
  checkin: stayDateSchema,
  checkout: stayDateSchema,
  guests: z.number().int().min(1).max(20),
};

export const MAX_PUBLIC_STAY_NIGHTS = 30;
export const MAX_PUBLIC_BOOKING_HORIZON_DAYS = 365;

function stayDay(value: string) {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

function validateStay<T extends z.ZodRawShape>(shape: T, todayDate: string) {
  return z.object(shape).strict().superRefine((value, context) => {
    const stay = value as { checkin: string; checkout: string };
    if (stay.checkin < todayDate) {
      context.addIssue({ code: "custom", message: "Check-in cannot be in the past", path: ["checkin"] });
    }
    if (stay.checkout <= stay.checkin) {
      context.addIssue({ code: "custom", message: "Checkout must be after check-in", path: ["checkout"] });
    }
    const checkinDay = stayDay(stay.checkin);
    const checkoutDay = stayDay(stay.checkout);
    const todayDay = stayDay(todayDate);
    if (Number.isFinite(checkinDay) && Number.isFinite(checkoutDay)
      && checkoutDay - checkinDay > MAX_PUBLIC_STAY_NIGHTS) {
      context.addIssue({ code: "custom", message: "Stay exceeds maximum length", path: ["checkout"] });
    }
    if (Number.isFinite(checkinDay) && Number.isFinite(todayDay)
      && checkinDay - todayDay > MAX_PUBLIC_BOOKING_HORIZON_DAYS) {
      context.addIssue({ code: "custom", message: "Check-in exceeds booking horizon", path: ["checkin"] });
    }
  });
}

export function currentIndiaStayDate(now = new Date()) {
  return formatInTimeZone(now, "Asia/Kolkata", "yyyy-MM-dd");
}

export function createAvailabilityRequestSchema(todayDate = currentIndiaStayDate()) {
  return validateStay(stayFields, todayDate);
}

export function createBookingRequestSchema(todayDate = currentIndiaStayDate()) {
  return validateStay({
    ...stayFields,
    guestName: z.string().trim().min(2).max(120),
    guestEmail: z.email().max(254),
    guestPhone: z.string().trim().min(7).max(32).regex(/^[+()\-\s0-9]+$/),
  }, todayDate);
}

export const availabilityRequestSchema = createAvailabilityRequestSchema();
export const bookingRequestSchema = createBookingRequestSchema();
export type AvailabilityRequest = z.infer<ReturnType<typeof createAvailabilityRequestSchema>>;
export type CreateBookingRequest = z.infer<ReturnType<typeof createBookingRequestSchema>>;
