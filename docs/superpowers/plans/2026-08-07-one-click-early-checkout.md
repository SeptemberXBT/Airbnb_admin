# One-Click Early Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click early-checkout lifecycle transition that preserves the direct-reservation record, immediately releases internal inventory, removes the stay from the outbound Airbnb feed, and shows a later Airbnb reservation as a separate same-day turnover.

**Architecture:** PostgreSQL remains the source of truth. An authenticated route invokes a transaction-scoped service that locks the property inventory, validates a manual direct reservation, marks it completed early, releases its `manual_local` inventory nights, reconciles the affected range, and records an audit event. The calendar read model includes completed-early rows as nonblocking history and derives whether Airbnb has observed the release from the next successful inbound sync.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, PostgreSQL/Supabase, `postgres`, date-fns/date-fns-tz, Vitest, Testing Library, CSS.

---

## Baseline Test Note

The isolated worktree was created from commit `4667883`. `npm install` succeeds. Before feature changes, `npm test` reports 215 passing tests and three existing failures:

- Two date-sensitive availability-route tests expect HTTP 200 but now receive HTTP 400.
- One legacy booking-reconcile compatibility test exceeds Vitest's five-second timeout.

These failures are outside this feature. Every task below uses targeted tests, and final verification must list these baseline failures separately rather than representing them as early-checkout regressions.

---

### Task 1: Persist the completed-early lifecycle

**Files:**
- Create: `supabase/migrations/0010_one_click_early_checkout.sql`
- Create: `supabase/migrations/0010_one_click_early_checkout.down.sql`
- Modify: `scripts/apply-production-migration.mjs`
- Create: `src/lib/db/early-checkout-migration-state.ts`
- Create: `src/lib/db/early-checkout-migration-state.test.ts`
- Modify: `src/lib/db/production-migration-state.test.ts`

- [ ] Add a failing test for `decideEarlyCheckoutMigrationAction`, requiring zero of four schema markers to return `apply`, all four to return `skip`, and one to three markers to throw a partial-migration error identifying `0010`.
- [ ] Run `npm test -- src/lib/db/early-checkout-migration-state.test.ts` and confirm it fails because the helper is missing.
- [ ] Add this forward migration:

```sql
alter table public.local_calendar_entries
  add column completed_early_at timestamptz,
  add column completed_early_by uuid references auth.users(id),
  add column early_checkout_effective_date date;

alter table public.local_calendar_entries
  add constraint local_calendar_entries_early_checkout_complete
  check (
    (completed_early_at is null and completed_early_by is null and early_checkout_effective_date is null)
    or
    (completed_early_at is not null and completed_early_by is not null and early_checkout_effective_date is not null)
  );

create index local_calendar_entries_completed_early_property_dates_idx
  on public.local_calendar_entries (property_id, start_date, end_date)
  where completed_early_at is not null;
```

- [ ] Add the inverse migration that drops the index, constraint, and three columns in that order.
- [ ] Implement `decideEarlyCheckoutMigrationAction(presentMarkers)` by calling the existing strict marker-count helper with an expected count of four and by translating a partial-state error to name migration `0010`.
- [ ] Extend `scripts/apply-production-migration.mjs` with a separate `readEarlyCheckoutSchemaState` that checks the three column names plus `local_calendar_entries_early_checkout_complete`. After migration `0008` verification, apply `0010` atomically only for an empty state, skip only for all four markers, fail closed for a partial state, and verify all four markers after the transaction.
- [ ] Re-run `npm test -- src/lib/db/early-checkout-migration-state.test.ts src/lib/db/production-migration-state.test.ts` and confirm it passes.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -am "feat: add early checkout lifecycle schema"`, adding the two migration files before committing.

### Task 2: Implement the atomic early-checkout service

**Files:**
- Create: `src/features/calendar/early-checkout-service.ts`
- Create: `src/features/calendar/early-checkout-service.db.test.ts`

- [ ] Write a DB test that creates an active manual `direct_reservation` spanning the current India date, verifies its `manual_local` inventory is active, calls the service, and asserts all of the following:

```ts
expect(result.idempotent).toBe(false);
expect(entry).toMatchObject({
  active: false,
  archived_at: null,
  completed_early_by: userId,
  early_checkout_effective_date: indiaToday,
  start_date: originalStart,
  end_date: originalEnd,
});
expect(activeInventory).toHaveLength(0);
expect(audit.action).toBe("completed_early");
```

- [ ] Add DB regressions proving a second call returns the original metadata without a second audit record and proving payment/private fields and original planned dates remain unchanged.
- [ ] Add table-driven rejections for cross-property access, future entries, archived entries, `blocked` entries, Airbnb-only records, and website-backed entries (`booking_id is not null`). Expect `403`, `404`, or `409` service errors without mutation as specified in the design.
- [ ] Run the isolated DB test and confirm it fails because the service is missing:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test \
TEST_SKIP_PGCRYPTO_EXTENSION=1 \
npm run test:db -- src/features/calendar/early-checkout-service.db.test.ts
```

- [ ] Implement an `EarlyCheckoutError` with stable codes and HTTP status metadata:

```ts
export type EarlyCheckoutCode = "FORBIDDEN" | "NOT_FOUND" | "INELIGIBLE";

export class EarlyCheckoutError extends Error {
  constructor(public readonly code: EarlyCheckoutCode, public readonly status: 403 | 404 | 409) {
    super(code);
  }
}
```

- [ ] Implement `createEarlyCheckoutService(sql, { now })` and `completeEarly(entryId, userId)` using `createInventoryService(sql).withPropertyInventory(...)`. Derive the effective date with `formatInTimeZone(now(), "Asia/Kolkata", "yyyy-MM-dd")`; never accept it from the request.
- [ ] Inside the property transaction, recheck membership and lock the row with this complete selection. Return the stored result when `completed_early_at` is already populated.

```sql
select id, property_id, booking_id, entry_type, active, archived_at,
  start_date::text, end_date::text, completed_early_at::text,
  completed_early_by, early_checkout_effective_date::text
from public.local_calendar_entries
where id = ${entryId} and property_id = ${propertyId}
for update
```

- [ ] For a row not already completed early, require:

```ts
entry.booking_id === null &&
entry.entry_type === "direct_reservation" &&
entry.active &&
entry.archived_at === null &&
entry.start_date <= indiaToday &&
indiaToday < entry.end_date
```

- [ ] Update the row without changing `start_date`, `end_date`, financial data, or private fields; then call:

```ts
await releaseSourceNights(tx, "manual_local", entryId, "completed_early");
await reconcilePropertyNights(tx, propertyId, entry.start_date, entry.end_date);
```

- [ ] Insert one audit event whose changes contain the original planned dates, `earlyCheckoutEffectiveDate`, and `completedEarlyAt`.
- [ ] Re-run the DB test and confirm all early-checkout service cases pass.
- [ ] Commit with `git commit -am "feat: release direct reservation on early checkout"`, adding the new files before committing.

### Task 3: Expose the authenticated one-click endpoint

**Files:**
- Create: `src/app/api/local-entries/[entryId]/early-checkout/route.ts`
- Create: `src/app/api/local-entries/[entryId]/early-checkout/route.test.ts`
- Modify: `src/features/calendar/early-checkout-service.ts`

- [ ] Add route tests mocking `requireUser` and `completeEarlyCheckout` for success, idempotent success, `403`, `404`, `409`, and unexpected `500` behavior.
- [ ] Assert the route reads only the URL entry ID and authenticated user ID; it must not parse a browser-supplied property, date, amount, or status.
- [ ] Run `npm test -- 'src/app/api/local-entries/[entryId]/early-checkout/route.test.ts'` and confirm it fails because the route is absent.
- [ ] Export the production wrapper from the service:

```ts
export function completeEarlyCheckout(entryId: string, userId: string) {
  return createEarlyCheckoutService(getDb()).completeEarly(entryId, userId);
}
```

- [ ] Implement the route with `requireUser()`, `z.uuid().parse((await params).entryId)`, and the stable JSON responses:

```ts
return NextResponse.json({ ok: true, ...result });
// 403 { error: "forbidden" }
// 404 { error: "not_found" }
// 409 { error: "ineligible_early_checkout" }
```

- [ ] Re-run the route test and confirm it passes.
- [ ] Run `npm run typecheck` and resolve only feature-related failures.
- [ ] Commit with `git commit -am "feat: add early checkout endpoint"`, adding the route files before committing.

### Task 4: Return completed stays as nonblocking calendar history

**Files:**
- Modify: `src/features/calendar/calendar-types.ts`
- Modify: `src/features/calendar/calendar-service.ts`
- Modify: `src/features/calendar/calendar-service.test.ts`
- Modify: `src/features/calendar/calendar-service.db.test.ts`
- Modify: `src/features/calendar/demo-calendar.ts`
- Modify: `src/features/calendar/vacancy.ts`
- Modify: `src/features/calendar/vacancy.test.ts`
- Modify: `src/features/calendar/calendar-window.test.ts`

- [ ] Add failing calendar-service tests requiring an inactive, nonarchived row with `completed_early_at` to remain in the response as `kind: "completed_early"`, with original dates and completion metadata.
- [ ] Add a DB test where an Airbnb reservation later overlaps that historical span; require both entries in the response, no collision alert, and the label `Same-day turnover · second booking` on the Airbnb entry.
- [ ] Add a vacancy regression where a property has only a completed-early history row and assert each released night remains vacant.
- [ ] Run the targeted tests and confirm they fail against the active-only query and current vacancy logic:

```bash
npm test -- src/features/calendar/calendar-service.test.ts src/features/calendar/vacancy.test.ts
```

- [ ] Extend `CalendarEntry` with `kind: "completed_early"` and explicit nullable fields:

```ts
completedEarlyAt: string | null;
earlyCheckoutEffectiveDate: string | null;
releaseObservedOnAirbnb: boolean;
sameDayTurnover: boolean;
```

- [ ] Populate those fields for every external, local, hold, and demo fixture so the type has one stable shape rather than optional state hidden behind `undefined`.
- [ ] Change the local calendar query to include visible early-completed history:

```sql
where e.property_id in ${sql(propertyIds)}
  and (e.active or (e.completed_early_at is not null and e.archived_at is null))
  and e.start_date < ${viewEnd}
  and e.end_date > ${startDate}
```

- [ ] Map completed rows to `source: "local"`, `kind: "completed_early"`, and label `Completed early`. Compute `releaseObservedOnAirbnb` only when a successful property sync occurred after completion and the old outbound busy range is absent from inbound `unavailable` events.
- [ ] After combining entries for a property, detect strict date overlap between an Airbnb `reservation` and a completed-early row. Keep both rows and change only the Airbnb display label to `Same-day turnover · second booking`; do not produce a collision alert.
- [ ] Update `calculateVacancy` to ignore `completed_early` entries before occupancy expansion.
- [ ] Update fixtures and window tests for the four explicit lifecycle fields.
- [ ] Re-run the unit and DB tests and confirm the completed-history, overlap-lane data, and vacancy cases pass.
- [ ] Commit with `git commit -am "feat: show early checkout as nonblocking history"`.

### Task 5: Add the one-click admin workflow

**Files:**
- Modify: `src/features/calendar/calendar-workspace.tsx`
- Modify: `src/features/calendar/calendar-workspace.test.tsx`
- Modify: `src/features/calendar/calendar-layout.test.ts`
- Modify: `src/app/globals.css`

- [ ] Add a failing UI test opening an eligible in-progress local direct reservation and asserting the modal contains exactly one `Check out early — release room now` button.
- [ ] Click it once and assert a single `POST /api/local-entries/<id>/early-checkout`, no confirmation dialog, disabled progress state, calendar refresh, and the notice `Released internally — awaiting Airbnb refresh`.
- [ ] Add tests proving the action is absent for future direct stays, completed-early history, Airbnb entries, website bookings, blocked dates, and archived records.
- [ ] Add a rendering test for `Release observed on Airbnb` when the read-model flag is true.
- [ ] Add a layout regression proving a completed-early span and an overlapping Airbnb reservation receive separate lanes and the same-day-turnover label remains visible.
- [ ] Run:

```bash
npm test -- src/features/calendar/calendar-workspace.test.tsx src/features/calendar/calendar-layout.test.ts
```

and confirm the new behavior fails before implementation.

- [ ] Extend the modal mutation state with `"early_checkout"`; implement one direct `fetch` call without a preflight availability request or confirmation dialog.
- [ ] Use India-date eligibility in the UI only to decide whether to show the action; rely on the endpoint for authoritative eligibility. Disable every conflicting modal action during the request.
- [ ] On success, update/reload the calendar and show the completed-early modal as read-only with original dates, actual completion timestamp, and either the awaiting-refresh or observed-release message.
- [ ] Keep the existing Archive action for active records and do not render it as the early-checkout mechanism.
- [ ] Add `.calendar-event--completed-early` with reduced opacity and a dashed border, plus a visually distinct amber warning-button style that still meets contrast requirements.
- [ ] Re-run the targeted UI/layout tests and confirm they pass.
- [ ] Run `npm run typecheck` and `npm run lint`; fix feature-related problems.
- [ ] Commit with `git commit -am "feat: add one-click early checkout UI"`.

### Task 6: Remove application caching from the Airbnb outbound feed

**Files:**
- Modify: `src/app/api/ical/[token]/route.ts`
- Create: `src/app/api/ical/[token]/route.test.ts`
- Modify: `src/lib/ical/outbound.test.ts`

- [ ] Add a route test that mocks calendar generation and asserts a valid token response has exactly `Cache-Control: no-store, max-age=0`.
- [ ] Add/retain an outbound-generation regression proving inactive completed-early entries are not serialized as busy `VEVENT`s while active direct reservations still are.
- [ ] Run:

```bash
npm test -- 'src/app/api/ical/[token]/route.test.ts' src/lib/ical/outbound.test.ts
```

and confirm the route-header test fails against the existing public edge-cache header.

- [ ] Replace the current cache policy with:

```ts
"Cache-Control": "no-store, max-age=0"
```

- [ ] Re-run both tests and confirm they pass.
- [ ] Commit with `git commit -am "fix: publish released Airbnb inventory without app cache"`, adding the route test before committing.

### Task 7: Regression and release verification

**Files:**
- Verify all files modified above.
- Update if needed: `README.md`

- [ ] Run the targeted non-DB feature suite:

```bash
npm test -- \
  'src/app/api/local-entries/[entryId]/early-checkout/route.test.ts' \
  'src/app/api/ical/[token]/route.test.ts' \
  src/features/calendar/calendar-service.test.ts \
  src/features/calendar/calendar-workspace.test.tsx \
  src/features/calendar/calendar-layout.test.ts \
  src/features/calendar/vacancy.test.ts \
  src/lib/ical/outbound.test.ts
```

- [ ] Run the isolated DB feature suite:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test \
TEST_SKIP_PGCRYPTO_EXTENSION=1 \
npm run test:db -- \
  src/features/calendar/early-checkout-service.db.test.ts \
  src/features/calendar/calendar-service.db.test.ts
```

- [ ] Run `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.
- [ ] Run full `npm test`. If the three recorded baseline failures remain unchanged, report them explicitly with the passing count; do not call the full suite green. If any new failures exist, fix them before continuing.
- [ ] Manually verify in a local production build:
  1. open an in-progress manual direct reservation;
  2. click the early-checkout button once;
  3. confirm it stays visible as completed history;
  4. confirm the vacancy count increases immediately;
  5. request the private outbound iCal URL and confirm the released event is absent and the response is `no-store`;
  6. import or fixture an overlapping Airbnb reservation and confirm both rows show in separate lanes with `Same-day turnover · second booking`.
- [ ] Review the final diff against every design acceptance criterion, especially no refund call, unchanged original dates/private details, property locking, idempotency, and nonblocking history.
- [ ] Use `superpowers:requesting-code-review` before integration.
- [ ] Use `superpowers:verification-before-completion` before claiming the feature complete.
