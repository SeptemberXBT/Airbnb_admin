import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional();

export const cleaningUpdateSchema = z.object({
  taskId: z.uuid(),
  action: z.enum(["start", "ready", "delay", "skip", "edit", "requeue"]),
  delayMinutes: z.number().int().min(0).max(720).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  expectedCheckoutTime: time,
  expectedCheckinTime: time,
});
