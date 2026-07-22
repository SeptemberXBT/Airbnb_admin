import { readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

const expectedColumns = [
  "booker_first_name",
  "booker_last_name",
  "country_code",
  "special_requests",
  "razorpay_key_id",
  "archived_at",
  "archived_by",
];
const expectedConstraints = [
  "bookings_booker_first_name_length",
  "bookings_booker_last_name_length",
  "bookings_special_requests_length",
  "bookings_razorpay_key_id_format",
  "bookings_archive_actor",
];
const expectedIndexes = [
  "bookings_property_archive_created_idx",
  "bookings_razorpay_key_id_idx",
  "payment_jobs_one_refund_per_booking",
];
const expectedMarkerCount =
  expectedColumns.length + expectedConstraints.length + expectedIndexes.length + 1;

function decidePremiumMigrationAction(presentMarkers, expectedMarkers) {
  if (
    !Number.isInteger(presentMarkers) ||
    !Number.isInteger(expectedMarkers) ||
    expectedMarkers <= 0 ||
    presentMarkers < 0 ||
    presentMarkers > expectedMarkers
  ) {
    throw new Error("Invalid migration marker count");
  }

  if (presentMarkers === 0) return "apply";
  if (presentMarkers === expectedMarkers) return "skip";
  throw new Error(
    `Production schema is partially migrated (${presentMarkers}/${expectedMarkers} markers present)`,
  );
}

async function readSchemaState(sql) {
  const columns = await sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings'
  `;
  const constraints = await sql`
    select conname
    from pg_constraint
    where connamespace = 'public'::regnamespace
  `;
  const indexes = await sql`
    select indexname
    from pg_indexes
    where schemaname = 'public'
  `;
  const [aliasTable] = await sql`
    select to_regclass('public.payment_refund_job_aliases')::text as name
  `;

  const allColumns = new Set(columns.map((row) => row.column_name));
  const allConstraints = new Set(constraints.map((row) => row.conname));
  const allIndexes = new Set(indexes.map((row) => row.indexname));

  return {
    columns: new Set(expectedColumns.filter((name) => allColumns.has(name))),
    constraints: new Set(expectedConstraints.filter((name) => allConstraints.has(name))),
    indexes: new Set(expectedIndexes.filter((name) => allIndexes.has(name))),
    aliasTable: Boolean(aliasTable?.name),
  };
}

function countPresentMarkers(state) {
  return state.columns.size + state.constraints.size + state.indexes.size + Number(state.aliasTable);
}

function assertComplete(state) {
  const missing = [
    ...expectedColumns.filter((name) => !state.columns.has(name)),
    ...expectedConstraints.filter((name) => !state.constraints.has(name)),
    ...expectedIndexes.filter((name) => !state.indexes.has(name)),
    ...(state.aliasTable ? [] : ["payment_refund_job_aliases"]),
  ];

  if (missing.length > 0) {
    throw new Error(`Production migration 0008 verification failed; missing ${missing.join(", ")}`);
  }
}

async function applyProductionMigration() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the production migration");
  }

  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    ssl: "require",
    connect_timeout: 20,
    idle_timeout: 5,
  });

  try {
    const before = await readSchemaState(sql);
    const action = decidePremiumMigrationAction(
      countPresentMarkers(before),
      expectedMarkerCount,
    );

    if (action === "apply") {
      const migrationPath = path.join(
        process.cwd(),
        "supabase/migrations/0008_premium_booking_checkout.sql",
      );
      const migration = await readFile(migrationPath, "utf8");
      console.log("Applying production migration 0008 atomically.");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration);
      });
      console.log("Production migration 0008 committed.");
    } else {
      console.log("Production migration 0008 is already complete; no changes applied.");
    }

    assertComplete(await readSchemaState(sql));
    console.log(`Production migration 0008 verified (${expectedMarkerCount}/${expectedMarkerCount} markers).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production") {
  await applyProductionMigration();
} else {
  console.log("Skipping production migration outside a Vercel production build.");
}
