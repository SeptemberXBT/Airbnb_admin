# Complete Cleaning Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include Airbnb unavailable periods in checkout turnover generation and let administrators return ready or skipped tasks to the active queue.

**Architecture:** A pure turnover-source policy defines which external event types create cleaning work and is consumed by the existing database query. The cleaning update contract gains a `requeue` action whose database transition resets operational progress. TodayQueue applies the same transition optimistically, then refreshes authoritative server state through the existing shared-workspace mechanism.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, postgres.js, Zod, Vitest, Testing Library, Playwright.

---

### Task 1: External Turnover Eligibility

**Files:**
- Create: `src/features/cleaning/turnover-sources.ts`
- Create: `src/features/cleaning/turnover-sources.test.ts`
- Modify: `src/features/cleaning/cleaning-service.ts`

- [ ] **Step 1: Write the failing source-policy test**

```ts
import { describe, expect, it } from "vitest";
import { externalTurnoverTypes, isExternalTurnoverType } from "./turnover-sources";

describe("external turnover sources", () => {
  it("includes Airbnb reservations and unavailable periods but excludes unknown events", () => {
    expect(externalTurnoverTypes).toEqual(["reservation", "unavailable"]);
    expect(isExternalTurnoverType("reservation")).toBe(true);
    expect(isExternalTurnoverType("unavailable")).toBe(true);
    expect(isExternalTurnoverType("unknown")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --run src/features/cleaning/turnover-sources.test.ts`

Expected: FAIL because `turnover-sources.ts` does not exist.

- [ ] **Step 3: Implement the policy and use it in the query**

```ts
export const externalTurnoverTypes = ["reservation", "unavailable"] as const;

export function isExternalTurnoverType(value: string) {
  return externalTurnoverTypes.some((type) => type === value);
}
```

Import `externalTurnoverTypes` in `cleaning-service.ts` and replace `e.event_type = 'reservation'` with `e.event_type in ${sql(externalTurnoverTypes)}`. Keep local entries restricted to `direct_reservation`.

- [ ] **Step 4: Run focused cleaning tests and verify GREEN**

Run: `npm test -- --run src/features/cleaning/turnover-sources.test.ts src/features/cleaning/derive-turnovers.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/cleaning/turnover-sources.ts src/features/cleaning/turnover-sources.test.ts src/features/cleaning/cleaning-service.ts
git commit -m "Include Airbnb unavailable turnovers"
```

### Task 2: Requeue Server Contract

**Files:**
- Create: `src/features/cleaning/cleaning-update-schema.ts`
- Create: `src/features/cleaning/cleaning-update-schema.test.ts`
- Modify: `src/app/api/cleaning/route.ts`
- Modify: `src/features/cleaning/cleaning-service.ts`

- [ ] **Step 1: Write the failing schema test**

```ts
import { describe, expect, it } from "vitest";
import { cleaningUpdateSchema } from "./cleaning-update-schema";

describe("cleaning update schema", () => {
  it("accepts requeue and rejects unknown actions", () => {
    expect(cleaningUpdateSchema.parse({ taskId: "10000000-0000-4000-8000-000000000001", action: "requeue" }).action).toBe("requeue");
    expect(() => cleaningUpdateSchema.parse({ taskId: "10000000-0000-4000-8000-000000000001", action: "undo" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `npm test -- --run src/features/cleaning/cleaning-update-schema.test.ts`

Expected: FAIL because the shared schema does not exist.

- [ ] **Step 3: Extract and extend the schema**

Create `cleaning-update-schema.ts` with the existing UUID, action, delay, duration, and time validation. Add `requeue` to the action enum. Import this schema in the API route and remove the route-local duplicate.

- [ ] **Step 4: Implement the database transition**

Extend `CleaningUpdate["action"]` with `requeue`. In `updateCleaningTask`, add:

```ts
} else if (input.action === "requeue") {
  await tx`
    update public.cleaning_tasks
    set status = 'queued', actual_start = null, actual_end = null,
      delay_minutes = 0, updated_at = now()
    where id = ${input.taskId}
  `;
```

The existing membership lookup, not-found response, audit log, and scheduler refresh remain authoritative.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- --run src/features/cleaning/cleaning-update-schema.test.ts src/features/cleaning/scheduler.test.ts`

Expected: both files pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/cleaning/cleaning-update-schema.ts src/features/cleaning/cleaning-update-schema.test.ts src/app/api/cleaning/route.ts src/features/cleaning/cleaning-service.ts
git commit -m "Add cleaning task requeue action"
```

### Task 3: Today Return-To-Queue Interaction

**Files:**
- Modify: `src/features/cleaning/today-queue.tsx`
- Modify: `src/features/cleaning/today-queue.test.tsx`

- [ ] **Step 1: Write failing ready and skipped restore tests**

Add tests that render a ready or skipped task, expand `Completed and skipped`, click `Return Suite A to queue`, and assert that Suite A moves to Up next immediately. Assert the POST body contains `{ taskId: "task-1", action: "requeue" }`. Add a failure test where the server returns 500 and assert the task remains under Completed and skipped.

- [ ] **Step 2: Run the component tests and verify RED**

Run: `npm test -- --run src/features/cleaning/today-queue.test.tsx`

Expected: FAIL because the Return to queue control does not exist.

- [ ] **Step 3: Add the completed-task command**

For `ready` and `skipped` cards, render an icon-and-text button labeled `Return to queue`. Reuse `onAction(task, "requeue")` and the existing `activeId` pending guard.

- [ ] **Step 4: Apply the optimistic requeue transition**

Extend the local task-state update so `requeue` sets:

```ts
status: "queued",
actualStart: null,
actualEnd: null,
delayMinutes: 0,
```

Leave local state untouched on failed responses. Continue calling `router.refresh()` after success.

- [ ] **Step 5: Run component and scheduler tests and verify GREEN**

Run: `npm test -- --run src/features/cleaning/today-queue.test.tsx src/features/cleaning/scheduler.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/cleaning/today-queue.tsx src/features/cleaning/today-queue.test.tsx
git commit -m "Return completed cleaning tasks to queue"
```

### Task 4: Complete Verification and Integration

**Files:**
- Verify only; no intended source changes.

- [ ] **Step 1: Run all unit and component tests**

Run: `npm test`

Expected: all tests pass with zero unhandled errors.

- [ ] **Step 2: Run static checks**

Run: `npm run lint && npm run typecheck`

Expected: both commands exit successfully with no warnings.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: Next.js compiles all routes successfully.

- [ ] **Step 4: Run responsive browser checks**

Run: `env DEMO_MODE=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 PLAYWRIGHT_WEB_SERVER_COMMAND='npm run dev -- --hostname 127.0.0.1 --port 3100' npm run test:e2e`

Expected: all Playwright projects pass.

- [ ] **Step 5: Inspect repository state**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and no uncommitted source changes.

- [ ] **Step 6: Merge and deploy after approval**

Fast-forward `deploy-noirhaus-main`, rerun `npm test` on the merged branch, and push it to `noirhaus/main`. No Supabase SQL or Vercel environment changes are required.
