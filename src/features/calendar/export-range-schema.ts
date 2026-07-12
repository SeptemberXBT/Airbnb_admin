import { differenceInCalendarDays, parseISO } from "date-fns";
import { z } from "zod";

export const exportRangeSchema = z.object({ start: z.iso.date(), end: z.iso.date() })
  .refine(({ start, end }) => end >= start, { message: "End date must follow start date", path: ["end"] })
  .refine(({ start, end }) => differenceInCalendarDays(parseISO(end), parseISO(start)) <= 365, {
    message: "Export range cannot exceed 366 dates",
    path: ["end"],
  });
