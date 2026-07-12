import "server-only";
import { getDb } from "@/lib/db/client";
import { workspaceVersion } from "./workspace-version";

export async function getWorkspaceVersion(userId: string) {
  const sql = getDb();
  const rows = await sql<{ source: string; changed_at: string | null }[]>`
    with accessible_properties as (
      select p.id from public.properties p
      join public.property_members pm on pm.property_id = p.id and pm.user_id = ${userId}
    ), changes as (
      select 'properties'::text as source, p.updated_at as changed_at
      from public.properties p join accessible_properties ap on ap.id = p.id
      union all
      select 'listings', l.updated_at from public.listings l join accessible_properties ap on ap.id = l.property_id
      union all
      select 'external_events', e.last_seen_at from public.external_calendar_events e
        join public.listings l on l.id = e.listing_id join accessible_properties ap on ap.id = l.property_id
      union all
      select 'local_entries', e.updated_at from public.local_calendar_entries e
        join accessible_properties ap on ap.id = e.property_id
      union all
      select 'overrides', o.updated_at from public.operation_overrides o
        left join public.external_calendar_events ee on ee.id = o.external_event_id
        left join public.listings l on l.id = ee.listing_id
        left join public.local_calendar_entries le on le.id = o.local_entry_id
        join accessible_properties ap on ap.id = coalesce(l.property_id, le.property_id)
      union all
      select 'cleaning_tasks', t.updated_at from public.cleaning_tasks t
        join accessible_properties ap on ap.id = t.property_id
    )
    select source, max(changed_at)::text as changed_at
    from changes group by source order by source
  `;
  return workspaceVersion(rows.map((row) => `${row.source}:${row.changed_at ?? ""}`));
}
