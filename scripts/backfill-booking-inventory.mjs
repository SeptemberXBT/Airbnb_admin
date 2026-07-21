import postgres from "postgres";
import { createBackfillService } from "../src/features/inventory/backfill-service.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for inventory backfill");
if (process.env.NODE_ENV === "production" && process.env.CONFIRM_BOOKING_BACKFILL !== "yes") {
  throw new Error("Set CONFIRM_BOOKING_BACKFILL=yes to run inventory backfill in production");
}

const sql = postgres(databaseUrl, { max: 4, connect_timeout: 10 });
try {
  const result = await createBackfillService(sql).backfillInventory();
  process.stdout.write(`${JSON.stringify({ properties: result.properties, activeNights: result.activeNights })}\n`);
} catch {
  process.stderr.write("Inventory backfill failed. No database details were printed.\n");
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
