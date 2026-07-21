import "server-only";
import { expandStayDates } from "./date-range";
import type { InventoryTransaction } from "./inventory-types";

export type InventoryOccupancyMismatch = {
  stayDate: string;
  rawOccupied: boolean;
  ledgerOccupied: boolean;
};

export function compareInventoryOccupancy(rawDates: string[], ledgerDates: string[]) {
  const raw = new Set(rawDates);
  const ledger = new Set(ledgerDates);
  const dates = [...new Set([...raw, ...ledger])].sort();
  return dates.flatMap((stayDate): InventoryOccupancyMismatch[] => {
    const rawOccupied = raw.has(stayDate);
    const ledgerOccupied = ledger.has(stayDate);
    return rawOccupied === ledgerOccupied ? [] : [{ stayDate, rawOccupied, ledgerOccupied }];
  });
}

export function shadowMismatchAuditPayload(mismatches: InventoryOccupancyMismatch[]) {
  return {
    mismatchCount: mismatches.length,
    dates: mismatches.map((mismatch) => mismatch.stayDate),
  };
}

export async function recordPropertyShadowMismatches(
  tx: InventoryTransaction,
  propertyId: string,
  startDate: string,
  endDate: string,
) {
  const dates = expandStayDates(startDate, endDate);
  const rawRows = await tx<{ stay_date: string }[]>`
    select distinct stay_date::text from (
      select d::date as stay_date
      from public.local_calendar_entries l
      cross join lateral generate_series(l.start_date, l.end_date - 1, interval '1 day') d
      where l.property_id = ${propertyId} and l.active = true and l.archived_at is null
      union
      select d::date as stay_date
      from public.external_calendar_events e
      join public.listings l on l.id = e.listing_id
      cross join lateral generate_series(e.start_date, e.end_date - 1, interval '1 day') d
      where l.property_id = ${propertyId} and e.active = true and e.archived_at is null
    ) raw
    where stay_date in ${tx(dates)}
  `;
  const ledgerRows = await tx<{ stay_date: string }[]>`
    select stay_date::text from public.inventory_nights
    where property_id = ${propertyId} and stay_date in ${tx(dates)} and status = 'active'
  `;
  const mismatches = compareInventoryOccupancy(
    rawRows.map((row) => row.stay_date),
    ledgerRows.map((row) => row.stay_date),
  );
  if (mismatches.length > 0) {
    await tx`
      insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
      values (
        ${propertyId}, 'inventory_shadow_mismatch', 'property_inventory', ${propertyId},
        ${tx.json(shadowMismatchAuditPayload(mismatches))}
      )
    `;
  }
  return mismatches.length;
}
