import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("initial database migration", () => {
  it("defines all operational tables, constraints, indexes, and row security", async () => {
    let sql = "";
    try {
      sql = await readFile(
        path.join(process.cwd(), "supabase/migrations/0001_initial.sql"),
        "utf8",
      );
    } catch {
      sql = "";
    }

    for (const table of [
      "properties",
      "listings",
      "external_calendar_events",
      "local_calendar_entries",
      "operation_overrides",
      "cleaning_tasks",
      "sync_runs",
      "audit_log",
    ]) {
      expect(sql).toMatch(new RegExp(`create table public\\.${table}`, "i"));
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    }
    expect(sql).toMatch(/unique\s*\(listing_id, source_uid\)/i);
    expect(sql).toMatch(/end_date > start_date/i);
    expect(sql).toMatch(/Asia\/Kolkata/i);
  });

  it("preserves historical cleaning rows with an active-only uniqueness index", async () => {
    const sql = await readFile(path.join(process.cwd(), "supabase/migrations/0002_cleaning_task_identity.sql"), "utf8");
    expect(sql).toMatch(/create unique index cleaning_tasks_active_property_service_unique/i);
    expect(sql).toMatch(/where archived_at is null/i);
    expect(sql).not.toMatch(/add constraint cleaning_tasks_property_service_unique/i);
  });

  it("normalizes and enforces universal arrival and departure times", async () => {
    const sql = await readFile(path.join(process.cwd(), "supabase/migrations/0003_universal_operation_times.sql"), "utf8");
    expect(sql).toMatch(/update public\.properties[\s\S]*default_checkin_time = '13:00'[\s\S]*default_checkout_time = '11:00'/i);
    expect(sql).toMatch(/check \(default_checkin_time = '13:00'::time\)/i);
    expect(sql).toMatch(/check \(default_checkout_time = '11:00'::time\)/i);
  });

  it("shares every property with approved Auth users and deduplicates creation requests", async () => {
    const sql = await readFile(path.join(process.cwd(), "supabase/migrations/0004_shared_admin_workspace.sql"), "utf8");
    expect(sql).toMatch(/creation_request_id uuid/i);
    expect(sql).toMatch(/cross join auth\.users/i);
    expect(sql).toMatch(/after insert on auth\.users/i);
    expect(sql).toMatch(/after insert on public\.properties/i);
    expect(sql).toMatch(/on conflict \(property_id, user_id\) do nothing/i);
  });

  it("stores optional nonnegative manual-entry payments", async () => {
    const up = await readFile(path.join(process.cwd(), "supabase/migrations/0005_manual_entry_payment.sql"), "utf8");
    const down = await readFile(path.join(process.cwd(), "supabase/migrations/0005_manual_entry_payment.down.sql"), "utf8");
    expect(up).toMatch(/add column payment_amount numeric\(12,2\)/i);
    expect(up).toMatch(/payment_amount >= 0/i);
    expect(down).toMatch(/drop column payment_amount/i);
  });

  it("retains safely observed completed Airbnb events", async () => {
    const up = await readFile(path.join(process.cwd(), "supabase/migrations/0006_preserve_airbnb_history.sql"), "utf8");
    const down = await readFile(path.join(process.cwd(), "supabase/migrations/0006_preserve_airbnb_history.down.sql"), "utf8");
    expect(up).toMatch(/historical boolean not null default false/i);
    expect(up).toMatch(/not \(active and historical\)/i);
    expect(up).toMatch(/end_date <= \(now\(\) at time zone 'Asia\/Kolkata'\)::date/i);
    expect(up).toMatch(/\(last_seen_at at time zone 'Asia\/Kolkata'\)::date >= start_date/i);
    expect(up).toMatch(/where active or historical/i);
    expect(down).toMatch(/drop index if exists public\.external_calendar_events_visible_range_idx/i);
    expect(down).toMatch(/drop constraint if exists external_calendar_events_state_check/i);
    expect(down).toMatch(/drop column if exists historical/i);
  });

  it("adds the public booking schema with reclaimable active inventory", async () => {
    let up = "";
    let down = "";

    try {
      [up, down] = await Promise.all([
        readFile(path.join(process.cwd(), "supabase/migrations/0007_public_booking.sql"), "utf8"),
        readFile(path.join(process.cwd(), "supabase/migrations/0007_public_booking.down.sql"), "utf8"),
      ]);
    } catch {
      up = "";
      down = "";
    }

    const tables = [
      "property_rates",
      "property_rate_overrides",
      "bookings",
      "booking_night_prices",
      "inventory_nights",
      "booking_attempts",
      "api_request_nonces",
      "payment_events",
      "payment_jobs",
      "notification_outbox",
      "booking_events",
    ];

    for (const table of tables) {
      expect(up).toMatch(new RegExp(`create table public\\.${table}`, "i"));
      expect(up).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
      expect(up).toMatch(new RegExp(`revoke all on public\\.${table} from anon`, "i"));
      expect(up).toMatch(new RegExp(`revoke all on public\\.${table} from authenticated`, "i"));
    }

    expect(up).toMatch(
      /create unique index inventory_nights_one_active_owner[\s\S]*\(property_id, stay_date\)[\s\S]*where status = 'active'/i,
    );
    expect(up).toMatch(/alter column created_by drop not null/i);
    expect(up).toMatch(/created_by is not null or booking_id is not null/i);
    expect(up).toMatch(/source_kind[\s\S]*booking_id[\s\S]*local_entry_id[\s\S]*external_event_id/i);
    expect(up).toMatch(/exactly_one_inventory_source_target/i);
    expect(down).toMatch(/drop index if exists public\.inventory_nights_one_active_owner/i);
    expect(down).toMatch(/alter column created_by set not null/i);
  });
});
