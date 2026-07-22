import { createHash } from "node:crypto";

export const SOURCE_OPERATIONAL_TABLES = [
  "properties",
  "property_members",
  "listings",
  "external_calendar_events",
  "local_calendar_entries",
  "operation_overrides",
  "cleaning_tasks",
  "sync_runs",
  "audit_log",
];

export const DESTINATION_TABLES = [
  ...SOURCE_OPERATIONAL_TABLES,
  "property_rates",
  "property_rate_overrides",
  "bookings",
  "booking_night_prices",
  "inventory_nights",
  "booking_attempts",
  "payment_events",
  "payment_jobs",
  "payment_refund_job_aliases",
  "notification_outbox",
  "booking_events",
];

export async function databaseFingerprint(sql, databaseUrl) {
  const [server] = await sql`
    select current_database() as database_name,
      current_user as database_user,
      coalesce(inet_server_addr()::text, 'local') as server_address,
      inet_server_port() as server_port,
      current_setting('server_version_num') as server_version
  `;
  const parsed = new URL(databaseUrl);
  const safeConnectionIdentity = `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  return {
    identity: createHash("sha256")
      .update(JSON.stringify({ ...server, safeConnectionIdentity }))
      .digest("hex"),
    databaseName: server.database_name,
    serverVersion: server.server_version,
  };
}

async function requireTables(sql, tables, label) {
  const found = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ${sql(tables)}
  `;
  const names = new Set(found.map((row) => row.table_name));
  const missing = tables.filter((table) => !names.has(table));
  if (missing.length) throw new Error(`${label}_SCHEMA_MISSING_TABLES:${missing.join(",")}`);
}

async function exportTable(sql, table) {
  return sql`select * from ${sql("public")}.${sql(table)}`;
}

export async function exportDatabase(sql, databaseUrl, tables, label) {
  await requireTables(sql, tables, label);
  const [fingerprint, users] = await Promise.all([
    databaseFingerprint(sql, databaseUrl),
    sql`select id::text as id, email from auth.users order by id`,
  ]);
  const snapshot = { fingerprint, users };
  for (const table of tables) snapshot[table] = await exportTable(sql, table);
  return snapshot;
}

export function snapshotCounts(snapshot, tables) {
  return Object.fromEntries(tables.map((table) => [table, snapshot[table]?.length ?? 0]));
}

export async function tableColumns(sql, table) {
  const result = await sql`
    select column_name, is_identity from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position
  `;
  return result;
}
