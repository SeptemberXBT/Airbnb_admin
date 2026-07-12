# Today and Mobile Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Today database work independent of turnover count and preserve eight-second shared-admin updates without repeated full-page refreshes.

**Architecture:** Cleaning reconciliation is split into a testable fixed-call orchestrator and a PostgreSQL store that performs set-based archive/upsert statements. The schedule remains derived in memory. A protected workspace-version endpoint replaces unconditional dashboard refreshes with change-aware polling.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, postgres.js, Supabase Auth, Vitest, Testing Library, Playwright.

---

### Task 1: Fixed-Call Cleaning Reconciliation

**Files:**
- Create: `src/features/cleaning/queue-reconciliation.ts`
- Create: `src/features/cleaning/queue-reconciliation.test.ts`
- Create: `src/features/cleaning/queue-reconciliation-store.ts`
- Modify: `src/features/cleaning/cleaning-service.ts`

- [ ] **Step 1: Write the failing fixed-call test**

```ts
import { describe, expect, it, vi } from "vitest";
import { reconcileCleaningTasks } from "./queue-reconciliation";

describe("reconcileCleaningTasks", () => {
  it("uses a fixed store call count as turnover count grows", async () => {
    const store = { archiveStale: vi.fn(), upsertDerived: vi.fn() };
    const tasks = Array.from({ length: 20 }, (_, index) => ({
      propertyId: `property-${index}`,
      outgoingEntryKey: `external:${index}`,
      incomingEntryKey: null,
      releaseTime: new Date("2026-07-13T05:35:00.000Z"),
      readyDeadline: new Date("2026-07-13T11:30:00.000Z"),
      guestArrivalTime: null,
      durationMinutes: 15,
    }));

    await reconcileCleaningTasks(store, ["property-0"], "2026-07-13", tasks);

    expect(store.archiveStale).toHaveBeenCalledTimes(1);
    expect(store.upsertDerived).toHaveBeenCalledTimes(1);
    expect(store.upsertDerived).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ propertyId: "property-0", releaseTime: "2026-07-13T05:35:00.000Z" }),
    ]));
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --run src/features/cleaning/queue-reconciliation.test.ts`

Expected: FAIL because `queue-reconciliation.ts` does not exist.

- [ ] **Step 3: Implement the fixed-call orchestrator**

Define `CleaningTaskReconciliationStore` with `archiveStale(propertyIds, serviceDate, desired)` and `upsertDerived(desired)`. Convert dates to ISO strings once. Always call `archiveStale` once and call `upsertDerived` once only when desired tasks exist.

```ts
export async function reconcileCleaningTasks(
  store: CleaningTaskReconciliationStore,
  propertyIds: string[],
  serviceDate: string,
  tasks: DerivedTurnover[],
) {
  const desired = tasks.map((task) => ({
    propertyId: task.propertyId,
    serviceDate,
    outgoingEntryKey: task.outgoingEntryKey,
    incomingEntryKey: task.incomingEntryKey,
    releaseTime: task.releaseTime.toISOString(),
    readyDeadline: task.readyDeadline.toISOString(),
    guestArrivalTime: task.guestArrivalTime?.toISOString() ?? null,
    durationMinutes: task.durationMinutes,
  }));
  await store.archiveStale(propertyIds, serviceDate, desired);
  if (desired.length) await store.upsertDerived(desired);
}
```

- [ ] **Step 4: Implement the PostgreSQL store**

`queue-reconciliation-store.ts` receives a postgres.js transaction. `archiveStale` uses one `jsonb_to_recordset` CTE to archive missing queued/delayed tasks and mismatched non-running tasks. `upsertDerived` uses one recordset insert with the existing partial conflict target and preserves fields for `cleaning_now` tasks.

No method may loop over desired tasks to issue SQL.

- [ ] **Step 5: Replace per-task service writes**

In `getCleaningQueue`, keep property/event reads and turnover derivation. Run reconciliation once inside `sql.begin`, then select active tasks. Remove both existing per-derived SQL loops and remove the per-scheduled-task update loop for `planned_start`, `planned_end`, and `warning_level`; those values are already returned from `buildCleaningSchedule`.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- --run src/features/cleaning/queue-reconciliation.test.ts src/features/cleaning/derive-turnovers.test.ts src/features/cleaning/scheduler.test.ts && npm run typecheck`

Expected: all focused tests and TypeScript pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/cleaning/queue-reconciliation.ts src/features/cleaning/queue-reconciliation.test.ts src/features/cleaning/queue-reconciliation-store.ts src/features/cleaning/cleaning-service.ts
git commit -m "Batch cleaning queue reconciliation"
```

### Task 2: Workspace Version Service

**Files:**
- Create: `src/features/workspace/workspace-version.ts`
- Create: `src/features/workspace/workspace-version-service.ts`
- Create: `src/app/api/workspace-version/route.ts`
- Create: `src/features/workspace/workspace-version.test.ts`

- [ ] **Step 1: Write the failing opaque-version test**

```ts
import { describe, expect, it } from "vitest";
import { workspaceVersion } from "./workspace-version";

describe("workspaceVersion", () => {
  it("changes when any accessible source timestamp changes", () => {
    const original = ["2026-07-13T00:00:00.000Z", null, "2026-07-13T00:01:00.000Z"];
    const changed = ["2026-07-13T00:00:00.000Z", null, "2026-07-13T00:02:00.000Z"];
    expect(workspaceVersion(changed)).not.toBe(workspaceVersion(original));
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --run src/features/workspace/workspace-version.test.ts`

Expected: FAIL because the pure version module does not exist.

- [ ] **Step 3: Implement version calculation and protected query**

Create `workspace-version.ts` with a pure `workspaceVersion` that JSON-serializes the ordered source timestamps. In the server-only service, export `getWorkspaceVersion(userId)` that executes one query composed of `UNION ALL` branches for properties, listings, external events (`last_seen_at`), local entries, operation overrides, and cleaning tasks. Every branch joins through `property_members` for `userId`. Return the opaque version only.

- [ ] **Step 4: Add the API route**

`GET /api/workspace-version` calls `requireUser`, returns `{ version }`, and sends `Cache-Control: private, no-store`. Authentication failures follow the existing protected-route behavior.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- --run src/features/workspace/workspace-version.test.ts && npm run typecheck`

Expected: test and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/workspace/workspace-version.ts src/features/workspace/workspace-version-service.ts src/features/workspace/workspace-version.test.ts src/app/api/workspace-version/route.ts
git commit -m "Add shared workspace version endpoint"
```

### Task 3: Change-Aware Refresh Controller

**Files:**
- Modify: `src/components/shared-workspace-refresh.tsx`
- Modify: `src/components/shared-workspace-refresh.test.tsx`

- [ ] **Step 1: Replace tests with failing polling behavior**

Cover these exact cases with fake timers and mocked fetch:

```ts
it("sets a baseline without refreshing, then refreshes only after the version changes", async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ version: "v1" }))
    .mockResolvedValueOnce(jsonResponse({ version: "v1" }))
    .mockResolvedValueOnce(jsonResponse({ version: "v2" }));
  render(<SharedWorkspaceRefresh />);
  await flushPromises();
  expect(refresh).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(refresh).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(refresh).toHaveBeenCalledTimes(1);
});
```

Also assert hidden tabs do not fetch, focus checks immediately, network failures do not refresh, and an unresolved request prevents a second request.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --run src/components/shared-workspace-refresh.test.tsx`

Expected: FAIL because the current controller calls `router.refresh()` unconditionally and never fetches a version.

- [ ] **Step 3: Implement guarded version polling**

Use refs for baseline version and in-flight state. On mount, every eight seconds, focus, and visibility return, fetch `/api/workspace-version` with `cache: "no-store"`. Set the first successful version as baseline. On a later difference, update the baseline before calling `router.refresh()`. Ignore failures and release the in-flight guard in `finally`.

- [ ] **Step 4: Run component and shell tests**

Run: `npm test -- --run src/components/shared-workspace-refresh.test.tsx src/components/app-shell.test.tsx`

Expected: all tests pass without unhandled promise errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/shared-workspace-refresh.tsx src/components/shared-workspace-refresh.test.tsx
git commit -m "Refresh shared workspace only after changes"
```

### Task 4: Performance Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run full unit, lint, and type checks**

Run: `npm test && npm run lint && npm run typecheck`

Expected: all commands pass with no warnings.

- [ ] **Step 2: Run production build**

Run: `npm run build`

Expected: all Next.js routes compile.

- [ ] **Step 3: Run responsive browser suite**

Run: `env DEMO_MODE=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 PLAYWRIGHT_WEB_SERVER_COMMAND='npm run dev -- --hostname 127.0.0.1 --port 3100' npm run test:e2e`

Expected: all Playwright projects pass.

- [ ] **Step 4: Confirm repository hygiene**

Run: `git diff --check && git status --short`

Expected: no source changes remain uncommitted. Restore only generated `next-env.d.ts` and screenshot changes created by verification.
