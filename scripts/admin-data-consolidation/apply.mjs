import { tableColumns } from "./database.mjs";

const PRESERVED_AUDIT_ENTITY_TYPES = [
  "website_booking",
  "booking",
  "booking_worker",
  "payment_job",
  "payment_event",
];

function migrationTimestamp(rows, now) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value === "__MIGRATION_TIMESTAMP__" ? now : value,
  ])));
}

async function insertRows(tx, table, rows, options = {}) {
  if (!rows.length) return;
  const schema = await tableColumns(tx, table);
  const identityColumns = new Set(schema.filter((column) => column.is_identity === "YES").map((column) => column.column_name));
  const availableColumns = new Set(schema.map((column) => column.column_name));
  const omitted = new Set(options.omit ?? []);
  const columns = Object.keys(rows[0]).filter((column) => availableColumns.has(column)
    && !identityColumns.has(column) && !omitted.has(column));
  if (!columns.length) throw new Error(`NO_INSERTABLE_COLUMNS:${table}`);
  const records = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
  if (!options.conflict?.length) {
    await tx`insert into ${tx("public")}.${tx(table)} ${tx(records, columns)}`;
    return;
  }
  const conflictColumns = options.conflict;
  const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
  const updateClause = updateColumns.map((column) => `"${column}" = excluded."${column}"`).join(", ");
  await tx`
    insert into ${tx("public")}.${tx(table)} ${tx(records, columns)}
    on conflict (${tx(conflictColumns)}) do update set ${tx.unsafe(updateClause)}
  `;
}

async function assertSnapshotStillCurrent(tx, destinationSnapshot) {
  const checks = ["properties", "listings", "bookings", "local_calendar_entries", "external_calendar_events"];
  for (const table of checks) {
    const [current] = await tx`
      select count(*)::int as count from ${tx("public")}.${tx(table)}
    `;
    if (current.count !== destinationSnapshot[table].length) {
      throw new Error(`DESTINATION_CHANGED_AFTER_SNAPSHOT:${table}`);
    }
  }
}

async function assertPostconditions(tx, plan, preservedBookingCount, manualIcalReattach) {
  const expected = {
    properties: plan.counts.properties,
    listings: plan.counts.listings,
    external_calendar_events: plan.counts.externalCalendarEvents,
    local_calendar_entries: plan.counts.localCalendarEntries,
    inventory_nights: plan.counts.inventoryNights,
    bookings: preservedBookingCount,
  };
  for (const [table, count] of Object.entries(expected)) {
    const [actual] = await tx`
      select count(*)::int as count from ${tx("public")}.${tx(table)}
    `;
    if (actual.count !== count) throw new Error(`POSTCONDITION_COUNT_MISMATCH:${table}:${actual.count}:${count}`);
  }
  const [duplicateInventory] = await tx`
    select property_id, stay_date from public.inventory_nights
    where status = 'active'
    group by property_id, stay_date having count(*) > 1 limit 1
  `;
  if (duplicateInventory) throw new Error("POSTCONDITION_DUPLICATE_INVENTORY");
  const [orphanBooking] = await tx`
    select b.id from public.bookings b left join public.properties p on p.id = b.property_id
    where p.id is null limit 1
  `;
  if (orphanBooking) throw new Error("POSTCONDITION_ORPHAN_BOOKING");
  if (manualIcalReattach) {
    const [connected] = await tx`
      select id from public.listings
      where inbound_ical_url_encrypted is not null limit 1
    `;
    if (connected) throw new Error("POSTCONDITION_CONNECTED_ICAL_IN_MANUAL_MODE");
  }
}

export async function applyConsolidation(
  sql,
  plan,
  destinationSnapshot,
  { manualIcalReattach = false } = {},
) {
  const now = new Date();
  return sql.begin(async (tx) => {
    await tx.unsafe(`lock table
      public.properties, public.property_members, public.listings,
      public.external_calendar_events, public.local_calendar_entries,
      public.operation_overrides, public.cleaning_tasks, public.sync_runs,
      public.audit_log, public.property_rates, public.property_rate_overrides,
      public.inventory_nights, public.bookings
      in share row exclusive mode`);
    await assertSnapshotStillCurrent(tx, destinationSnapshot);

    await tx`delete from public.operation_overrides`;
    await tx`delete from public.cleaning_tasks`;
    await tx`delete from public.sync_runs`;
    await tx`delete from public.inventory_nights`;
    await tx`delete from public.external_calendar_events`;
    await tx`delete from public.local_calendar_entries where booking_id is null`;
    await tx`update public.local_calendar_entries set listing_id = null where booking_id is not null`;
    await tx`delete from public.listings`;
    await tx`delete from public.property_members`;
    await tx`delete from public.property_rate_overrides`;
    await tx`delete from public.property_rates`;

    const bookingIds = destinationSnapshot.bookings.map((booking) => booking.id);
    if (bookingIds.length) {
      await tx`
        delete from public.audit_log
        where entity_type not in ${tx(PRESERVED_AUDIT_ENTITY_TYPES)}
          and entity_id not in ${tx(bookingIds)}
      `;
    } else {
      await tx`delete from public.audit_log where entity_type not in ${tx(PRESERVED_AUDIT_ENTITY_TYPES)}`;
    }

    const targetPropertyIds = plan.properties.map((property) => property.id);
    if (!targetPropertyIds.length) throw new Error("EMPTY_TARGET_PROPERTY_SET");
    await tx`delete from public.properties where id not in ${tx(targetPropertyIds)}`;

    await insertRows(tx, "properties", migrationTimestamp(plan.properties, now), { conflict: ["id"] });
    await insertRows(tx, "property_members", plan.propertyMembers, { conflict: ["property_id", "user_id"] });
    await insertRows(tx, "listings", plan.listings, { conflict: ["id"] });
    await insertRows(tx, "external_calendar_events", plan.externalCalendarEvents, { conflict: ["id"] });
    await insertRows(tx, "local_calendar_entries", plan.localCalendarEntries, { conflict: ["id"] });

    for (const entry of plan.bookingLocalEntries) {
      await tx`
        update public.local_calendar_entries
        set listing_id = ${entry.listing_id}, property_id = ${entry.property_id}, updated_at = now()
        where id = ${entry.id} and booking_id = ${entry.booking_id}
      `;
    }

    await insertRows(tx, "operation_overrides", plan.operationOverrides, { conflict: ["id"] });
    await insertRows(tx, "cleaning_tasks", plan.cleaningTasks, { conflict: ["id"] });
    await insertRows(tx, "sync_runs", plan.syncRuns, { conflict: ["id"] });
    await insertRows(tx, "property_rates", plan.propertyRates, { conflict: ["property_id"] });
    await insertRows(tx, "property_rate_overrides", plan.propertyRateOverrides, { conflict: ["id"] });
    await insertRows(tx, "inventory_nights", plan.inventoryNights, { omit: ["id"] });
    await insertRows(tx, "audit_log", plan.auditLog, { omit: ["id"] });
    await tx`
      insert into public.audit_log (actor_id, action, entity_type, entity_id, changes)
      values (${plan.fallbackActorId}, 'admin_data_consolidated', 'migration', 'old-admin-to-new-admin',
        ${tx.json({ counts: plan.counts })})
    `;

    await assertPostconditions(
      tx,
      plan,
      destinationSnapshot.bookings.length,
      manualIcalReattach,
    );
    return { applied: true, counts: plan.counts };
  });
}
