import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { generateOutboundCalendar } from "@/lib/ical/outbound";
import { generatePublicToken, hashToken } from "@/lib/security/secrets";

export function createOutboundService(sql: postgres.Sql) {
  return {
    async getOutboundCalendar(routeToken: string) {
      const [listing] = await sql<{ id: string; property_id: string }[]>`
        select id, property_id from public.listings
        where outbound_token_hash = ${hashToken(routeToken)} and outbound_enabled and active and archived_at is null
      `;
      if (!listing) return null;
      const entries = await sql<{ id: string; start_date: string; end_date: string }[]>`
        select id, start_date::text, end_date::text from public.local_calendar_entries
        where property_id = ${listing.property_id} and active and archived_at is null and sync_to_airbnb
          and (listing_id is null or listing_id = ${listing.id})
        order by start_date, end_date, id
      `;
      return generateOutboundCalendar(entries.map((entry) => ({
        id: entry.id, startDate: entry.start_date, endDate: entry.end_date,
      })), routeToken);
    },
  };
}

export async function getOutboundCalendar(routeToken: string) {
  return createOutboundService(getDb()).getOutboundCalendar(routeToken);
}

async function assertListingAccess(listingId: string, userId: string) {
  const sql = getDb();
  const [listing] = await sql<{ property_id: string }[]>`
    select l.property_id from public.listings l join public.property_members pm
      on pm.property_id = l.property_id and pm.user_id = ${userId}
    where l.id = ${listingId} and l.archived_at is null
  `;
  if (!listing) throw new Error("NOT_FOUND");
  return listing.property_id;
}

export async function rotateOutboundToken(listingId: string, userId: string) {
  const propertyId = await assertListingAccess(listingId, userId);
  const sql = getDb();
  const token = generatePublicToken();
  await sql.begin(async (tx) => {
    await tx`update public.listings set outbound_token_hash = ${hashToken(token)}, outbound_enabled = true, updated_at = now() where id = ${listingId}`;
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id)
      values (${propertyId}, ${userId}, 'outbound_token_rotated', 'listing', ${listingId})
    `;
  });
  return token;
}

export async function setOutboundFeedEnabled(listingId: string, enabled: boolean, userId: string) {
  const propertyId = await assertListingAccess(listingId, userId);
  const sql = getDb();
  await sql.begin(async (tx) => {
    await tx`update public.listings set outbound_enabled = ${enabled}, updated_at = now() where id = ${listingId}`;
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
      values (${propertyId}, ${userId}, ${enabled ? "outbound_feed_enabled" : "outbound_feed_disabled"}, 'listing', ${listingId}, ${tx.json({ enabled })})
    `;
  });
}
