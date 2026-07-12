import "server-only";
import { getDb } from "@/lib/db/client";
import { generatePublicToken, hashToken, sealSecret } from "@/lib/security/secrets";
import type { PropertyListingInput } from "./property-schema";

export type PropertySummary = {
  id: string;
  name: string;
  active: boolean;
  defaultCheckinTime: string;
  defaultCheckoutTime: string;
  defaultCleaningMinutes: number;
  listingId: string;
  listingName: string;
  listingActive: boolean;
  outboundEnabled: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
};

export async function listPropertiesForUser(userId: string): Promise<PropertySummary[]> {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") return [];
  const sql = getDb();
  const rows = await sql<{
    id: string; name: string; active: boolean; default_checkin_time: string;
    default_checkout_time: string; default_cleaning_minutes: number; listing_id: string;
    listing_name: string; listing_active: boolean; outbound_enabled: boolean;
    last_sync_at: string | null; last_sync_status: string | null;
  }[]>`
    select p.id, p.name, p.active, p.default_checkin_time::text,
      p.default_checkout_time::text, p.default_cleaning_minutes,
      l.id as listing_id, l.display_name as listing_name, l.active as listing_active,
      l.outbound_enabled, l.last_sync_at::text, l.last_sync_status::text
    from public.properties p
    join public.property_members pm on pm.property_id = p.id and pm.user_id = ${userId}
    join public.listings l on l.property_id = p.id and l.archived_at is null
    where p.archived_at is null
    order by p.name, l.display_name
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    defaultCheckinTime: row.default_checkin_time.slice(0, 5),
    defaultCheckoutTime: row.default_checkout_time.slice(0, 5),
    defaultCleaningMinutes: row.default_cleaning_minutes,
    listingId: row.listing_id,
    listingName: row.listing_name,
    listingActive: row.listing_active,
    outboundEnabled: row.outbound_enabled,
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
  }));
}

export async function createPropertyWithListing(input: PropertyListingInput, userId: string) {
  const sql = getDb();
  const encryptionKey = process.env.ICAL_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("ICAL_ENCRYPTION_KEY is not configured");
  const publicToken = generatePublicToken();
  const encryptedFeed = sealSecret(input.inboundIcalUrl, encryptionKey);

  const result = await sql.begin(async (tx) => {
    const [property] = await tx<{ id: string }[]>`
      insert into public.properties (
        name, timezone, default_checkin_time, default_checkout_time,
        default_cleaning_minutes, checkout_buffer_minutes, checkin_buffer_minutes
      ) values (
        ${input.name}, ${input.timezone}, ${input.defaultCheckinTime}, ${input.defaultCheckoutTime},
        ${input.defaultCleaningMinutes}, ${input.checkoutBufferMinutes}, ${input.checkinBufferMinutes}
      ) returning id
    `;
    await tx`insert into public.property_members (property_id, user_id, role) values (${property.id}, ${userId}, 'owner')`;
    const [listing] = await tx<{ id: string }[]>`
      insert into public.listings (
        property_id, display_name, inbound_ical_url_encrypted, outbound_token_hash
      ) values (${property.id}, ${input.displayName}, ${encryptedFeed}, ${hashToken(publicToken)})
      returning id
    `;
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
      values (${property.id}, ${userId}, 'created', 'property', ${property.id}, ${tx.json({ name: input.name, listingId: listing.id })})
    `;
    return { propertyId: property.id, listingId: listing.id };
  });
  return { ...result, publicToken };
}

export async function updateProperty(input: PropertyListingInput & { propertyId: string; listingId: string }, userId: string) {
  const sql = getDb();
  const encryptionKey = process.env.ICAL_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("ICAL_ENCRYPTION_KEY is not configured");
  await sql.begin(async (tx) => {
    const [allowed] = await tx`select 1 from public.property_members where property_id = ${input.propertyId} and user_id = ${userId}`;
    if (!allowed) throw new Error("FORBIDDEN");
    await tx`
      update public.properties set name = ${input.name}, timezone = ${input.timezone},
        default_checkin_time = ${input.defaultCheckinTime}, default_checkout_time = ${input.defaultCheckoutTime},
        default_cleaning_minutes = ${input.defaultCleaningMinutes}, checkout_buffer_minutes = ${input.checkoutBufferMinutes},
        checkin_buffer_minutes = ${input.checkinBufferMinutes}, updated_at = now()
      where id = ${input.propertyId}
    `;
    await tx`
      update public.listings set display_name = ${input.displayName},
        inbound_ical_url_encrypted = ${sealSecret(input.inboundIcalUrl, encryptionKey)}, updated_at = now()
      where id = ${input.listingId} and property_id = ${input.propertyId}
    `;
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
      values (${input.propertyId}, ${userId}, 'updated', 'property', ${input.propertyId}, ${tx.json({ defaultsUpdated: true, listingUpdated: true })})
    `;
  });
}
