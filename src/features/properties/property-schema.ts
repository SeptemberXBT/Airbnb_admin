import { z } from "zod";
import { isAllowedAirbnbCalendarUrl } from "@/lib/ical/feed-url";

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export const propertyListingSchema = z.object({
  name: z.string().trim().min(2).max(100),
  displayName: z.string().trim().min(2).max(120),
  timezone: z.literal("Asia/Kolkata"),
  defaultCheckinTime: z.string().regex(timePattern),
  defaultCheckoutTime: z.string().regex(timePattern),
  defaultCleaningMinutes: z.coerce.number().int().min(5).max(480),
  checkoutBufferMinutes: z.coerce.number().int().min(0).max(120),
  checkinBufferMinutes: z.coerce.number().int().min(0).max(120),
  inboundIcalUrl: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "Use an HTTPS calendar URL")
    .refine(isAllowedAirbnbCalendarUrl, "Use an Airbnb iCal export URL"),
});

export type PropertyListingInput = z.infer<typeof propertyListingSchema>;

type ListingRecord = {
  id: string;
  property_id: string;
  display_name: string;
  platform: string;
  inbound_ical_url_encrypted: string;
  outbound_token_hash: string;
  outbound_enabled: boolean;
  active: boolean;
  last_sync_at: string | null;
  last_sync_status: string | null;
};

export function toListingClient(listing: ListingRecord) {
  return {
    id: listing.id,
    propertyId: listing.property_id,
    displayName: listing.display_name,
    platform: listing.platform,
    outboundEnabled: listing.outbound_enabled,
    active: listing.active,
    lastSyncAt: listing.last_sync_at,
    lastSyncStatus: listing.last_sync_status,
  };
}
