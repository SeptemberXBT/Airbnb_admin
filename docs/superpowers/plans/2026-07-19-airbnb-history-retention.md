# Airbnb History Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every completed Airbnb event observed by Noir Haus indefinitely while continuing to archive missing ongoing or future events as cancellations.

**Architecture:** Add a dedicated `historical` state to external calendar rows, decide archive-versus-history in the pure reconciliation planner using the India calendar date, and make occupancy consumers read active or retained rows. Recover only previously archived rows whose timestamps prove the application observed them after their stay began.

**Tech Stack:** Next.js 16, TypeScript, Vitest, PostgreSQL/Supabase, `postgres`, `date-fns-tz`.

---

## File Structure

- Create `supabase/migrations/0006_preserve_airbnb_history.sql`: add the historical flag, recover safe past rows, enforce state consistency, and add the retained-read index.
- Create `supabase/migrations/0006_preserve_airbnb_history.down.sql`: remove the index, constraint, and column.
- Modify `src/lib/db/migration.test.ts`: verify migration and recovery contracts.
- Modify `src/features/sync/reconcile.ts`: produce distinct cancellation archives and completed-history retention actions.
- Modify `src/features/sync/reconcile.test.ts`: cover all reconciliation state transitions and date boundaries.
- Modify `src/features/sync/sync-service.ts`: pass the India date and persist the planner's historical state changes.
- Create `src/features/calendar/external-history-query.test.ts`: verify all occupancy/detail consumers include retained events.
- Modify `src/features/calendar/calendar-service.ts`: display retained Airbnb events.
- Modify `src/features/cleaning/cleaning-service.ts`: derive checkout-day turnovers from retained events.
- Modify `src/features/calendar/entry-service.ts`: include retained events in overlap and detail reads.

### Task 1: Database State and Conservative Recovery

**Files:**
- Create: `supabase/migrations/0006_preserve_airbnb_history.sql`
- Create: `supabase/migrations/0006_preserve_airbnb_history.down.sql`
- Modify: `src/lib/db/migration.test.ts`

- [ ] **Step 1: Write the failing migration contract test**

Add a test that reads both migration files and asserts the up migration contains `historical boolean not null default false`, an `active or historical` index, the India-date completion boundary, the `last_seen_at >= start_date` recovery guard, and a no-active-and-historical check. Assert the down migration drops each new database object.

```ts
it("retains safely observed completed Airbnb events", async () => {
  const up = await readFile(path.join(process.cwd(), "supabase/migrations/0006_preserve_airbnb_history.sql"), "utf8");
  const down = await readFile(path.join(process.cwd(), "supabase/migrations/0006_preserve_airbnb_history.down.sql"), "utf8");
  expect(up).toMatch(/historical boolean not null default false/i);
  expect(up).toMatch(/not \(active and historical\)/i);
  expect(up).toMatch(/end_date <= \(now\(\) at time zone 'Asia\/Kolkata'\)::date/i);
  expect(up).toMatch(/last_seen_at at time zone 'Asia\/Kolkata'\)::date >= start_date/i);
  expect(up).toMatch(/where active or historical/i);
  expect(down).toMatch(/drop index if exists public\.external_calendar_events_visible_range_idx/i);
  expect(down).toMatch(/drop constraint if exists external_calendar_events_state_check/i);
  expect(down).toMatch(/drop column if exists historical/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/lib/db/migration.test.ts`

Expected: FAIL because migration `0006` does not exist.

- [ ] **Step 3: Add the up and down migrations**

The up migration must add the flag, add a state check, recover only completed archived rows observed on/after their start date, and create a partial date-range index:

```sql
alter table public.external_calendar_events
  add column historical boolean not null default false;

alter table public.external_calendar_events
  add constraint external_calendar_events_state_check
  check (not (active and historical));

update public.external_calendar_events
set historical = true
where not active
  and not historical
  and end_date <= (now() at time zone 'Asia/Kolkata')::date
  and (last_seen_at at time zone 'Asia/Kolkata')::date >= start_date;

create index external_calendar_events_visible_range_idx
  on public.external_calendar_events (listing_id, start_date, end_date)
  where active or historical;
```

The down migration must remove the index, constraint, and column in that order.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- src/lib/db/migration.test.ts`

Expected: all migration tests PASS.

- [ ] **Step 5: Commit the database task**

```bash
git add src/lib/db/migration.test.ts supabase/migrations/0006_preserve_airbnb_history.sql supabase/migrations/0006_preserve_airbnb_history.down.sql
git commit -m "Add Airbnb history retention state"
```

### Task 2: Reconciliation and Persistence

**Files:**
- Modify: `src/features/sync/reconcile.test.ts`
- Modify: `src/features/sync/reconcile.ts`
- Modify: `src/features/sync/sync-service.ts`

- [ ] **Step 1: Write failing reconciliation tests**

Update fixtures to include `startDate`, `endDate`, and `historical`, and call `planReconciliation(existing, incoming, "2026-07-19")`. Add separate assertions that:

```ts
expect(plan.retainHistory).toEqual(["completed"]);
expect(plan.archive).toEqual(["ongoing", "future"]);
```

Also verify an already historical missing row is untouched and an incoming historical row appears in `update` even when its content hash is unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/features/sync/reconcile.test.ts`

Expected: FAIL because the current planner has no historical state, date argument, or `retainHistory` result.

- [ ] **Step 3: Implement the pure planner behavior**

Extend the existing type and result:

```ts
export type ExistingCalendarEvent = {
  id: string;
  sourceUid: string;
  contentHash: string;
  startDate: string;
  endDate: string;
  active: boolean;
  historical: boolean;
};
```

An incoming row updates when `!record.active || record.historical || record.contentHash !== event.contentHash`. A missing active row goes to `retainHistory` when `endDate <= todayDate`; otherwise it goes to `archive`. Inactive rows are left untouched.

- [ ] **Step 4: Run the focused planner test and verify GREEN**

Run: `npm test -- src/features/sync/reconcile.test.ts`

Expected: all reconciliation tests PASS.

- [ ] **Step 5: Persist the new reconciliation state**

In `sync-service.ts`, import `formatInTimeZone`, select `start_date`, `end_date`, and `historical`, and call:

```ts
planReconciliation(existing, incoming, formatInTimeZone(new Date(), "Asia/Kolkata", "yyyy-MM-dd"))
```

Set `historical = false` on inserts, conflict updates, and normal updates. Set `active = false, historical = false` for `plan.archive`. Set `active = false, historical = true` for `plan.retainHistory`. Keep `archived_count` equal to `plan.archive.length` so completed stays are not reported as cancellations.

- [ ] **Step 6: Run sync tests, typecheck, and verify GREEN**

Run: `npm test -- src/features/sync/reconcile.test.ts src/features/sync/sync-security.test.ts && npm run typecheck`

Expected: focused tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit the synchronization task**

```bash
git add src/features/sync/reconcile.ts src/features/sync/reconcile.test.ts src/features/sync/sync-service.ts
git commit -m "Retain completed Airbnb events during sync"
```

### Task 3: Calendar, Cleaning, and Entry Reads

**Files:**
- Create: `src/features/calendar/external-history-query.test.ts`
- Modify: `src/features/calendar/calendar-service.ts`
- Modify: `src/features/cleaning/cleaning-service.ts`
- Modify: `src/features/calendar/entry-service.ts`

- [ ] **Step 1: Write a failing query contract test**

Read the three service files and assert that every date-range/detail predicate for external events uses `(e.active or e.historical)`. Assert the old `and e.active and e.start_date` and `and e.active\n` patterns no longer remain in those external-event queries.

```ts
expect(calendar).toMatch(/\(e\.active or e\.historical\)[\s\S]*e\.start_date/);
expect(cleaning).toMatch(/\(e\.active or e\.historical\)[\s\S]*e\.event_type/);
expect(entry).toMatch(/\(e\.active or e\.historical\)[\s\S]*e\.start_date/);
expect(entry).toMatch(/e\.id = \$\{entryId\} and \(e\.active or e\.historical\)/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/features/calendar/external-history-query.test.ts`

Expected: FAIL because all current reads filter only `e.active`.

- [ ] **Step 3: Update all observed-occupancy consumers**

Change the external-event predicates in:

- `getCalendarData`
- `loadTurnoverSources`
- `hasOverlap`
- `getEntryDetail`

from `e.active` to `(e.active or e.historical)`. Do not change local-entry predicates or external override authorization.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- src/features/calendar/external-history-query.test.ts src/features/cleaning/derive-turnovers.test.ts src/features/calendar/vacancy.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit the read-path task**

```bash
git add src/features/calendar/external-history-query.test.ts src/features/calendar/calendar-service.ts src/features/cleaning/cleaning-service.ts src/features/calendar/entry-service.ts
git commit -m "Read retained Airbnb history across operations"
```

### Task 4: Full Verification and Integration Readiness

**Files:**
- Modify: `docs/superpowers/plans/2026-07-19-airbnb-history-retention.md` only for checkbox progress

- [ ] **Step 1: Run the complete unit suite**

Run: `npm test`

Expected: all test files and tests PASS with zero failures.

- [ ] **Step 2: Run static verification**

Run: `npm run lint && npm run typecheck`

Expected: both commands exit 0 with no errors.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: Next.js production build exits 0.

- [ ] **Step 4: Run browser regression tests**

Run: `npm run test:e2e`

Expected: all Playwright tests PASS.

- [ ] **Step 5: Review the final diff against the specification**

Run: `git diff --check deploy-noirhaus-main...HEAD && git status --short`

Expected: no whitespace errors and only the plan file may remain modified for progress tracking.

- [ ] **Step 6: Merge locally but stop before production push**

Merge the verified feature branch into `deploy-noirhaus-main` and rerun `npm test`. Do not push `noirhaus/main` until the user confirms migration `0006` was applied successfully in Supabase.
