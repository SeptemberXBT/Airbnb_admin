import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { createInventoryService, reconcilePropertyNights } from "./inventory-service";

type BackfillSql = postgres.Sql;

export function createBackfillService(sql: BackfillSql) {
  const inventory = createInventoryService(sql);
  return {
    async backfillInventory() {
      const ranges = await sql<{ property_id: string; start_date: string; end_date: string }[]>`
        select property_id, min(start_date)::text as start_date, max(end_date)::text as end_date
        from (
          select m.property_id, m.start_date, m.end_date
          from public.local_calendar_entries m
          where m.active = true and m.archived_at is null
          union all
          select l.property_id, e.start_date, e.end_date
          from public.external_calendar_events e
          join public.listings l on l.id = e.listing_id
          where e.active = true and e.archived_at is null
        ) active_sources
        group by property_id
        order by property_id
      `;
      for (const range of ranges) {
        await inventory.withPropertyInventory(range.property_id, (tx) => reconcilePropertyNights(
          tx,
          range.property_id,
          range.start_date,
          range.end_date,
        ));
      }
      const [{ count }] = await sql<{ count: number }[]>`
        select count(*)::int as count from public.inventory_nights where status = 'active'
      `;
      return { properties: ranges.length, activeNights: count };
    },
  };
}

export function backfillInventory() {
  return createBackfillService(getDb()).backfillInventory();
}
