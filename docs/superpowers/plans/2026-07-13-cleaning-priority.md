# Cleaning Queue Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prioritize currently cleanable rooms by guest check-in time, keep no-arrival rooms last except when they safely fill an idle gap, and enforce a five-minute ready buffer.

**Architecture:** Keep the scheduling policy inside `buildCleaningSchedule`, where release times, running work, delays, and durations are already available. Derive every arriving turnover deadline from one five-minute constant and make the property form submit that fixed value without exposing a control that the scheduler ignores.

**Tech Stack:** TypeScript, date-fns, React, Vitest, Testing Library, Next.js, Playwright.

---

### Task 1: Encode Queue Priority And Gap Filling

**Files:**
- Modify: `src/features/cleaning/scheduler.test.ts`
- Modify: `src/features/cleaning/scheduler.ts`

- [ ] **Step 1: Write failing scheduler tests**

Add tests proving:

```ts
expect(schedule.map((task) => task.id)).toEqual([
  "arrival-1300", "arrival-1330", "arrival-1400", "no-arrival",
]);
```

Also cover an unavailable 1:00 PM room being overtaken by an available 1:30 PM room, a 15-minute no-arrival task filling a 20-minute idle gap, and the same task remaining last for a 10-minute gap.

- [ ] **Step 2: Run the scheduler tests and verify RED**

Run: `npm test -- src/features/cleaning/scheduler.test.ts`

Expected: failures show the current deadline-based comparator places no-arrival or later-arrival tasks incorrectly.

- [ ] **Step 3: Implement the scheduling policy**

Replace the queued-task deadline comparator with:

```ts
const byArrival = (a: CleaningCandidate, b: CleaningCandidate) =>
  (a.guestArrivalTime?.getTime() ?? Number.POSITIVE_INFINITY)
    - (b.guestArrivalTime?.getTime() ?? Number.POSITIVE_INFINITY)
  || effectiveRelease(a).getTime() - effectiveRelease(b).getTime()
  || a.propertyName.localeCompare(b.propertyName)
  || a.id.localeCompare(b.id);
```

At each cursor position:

1. Select the earliest-check-in arriving task whose effective release is at or before the cursor.
2. If no arriving task is available, find the next arriving release.
3. Select an available no-arrival task only when `cursor + durationMinutes <= next arriving release`.
4. Otherwise move the cursor to the next arriving release.
5. When no arriving tasks remain, schedule no-arrival tasks by release, property name, and ID.

- [ ] **Step 4: Run scheduler tests and verify GREEN**

Run: `npm test -- src/features/cleaning/scheduler.test.ts`

Expected: all scheduler tests pass.

- [ ] **Step 5: Commit scheduler behavior**

```bash
git add src/features/cleaning/scheduler.ts src/features/cleaning/scheduler.test.ts
git commit -m "Prioritize cleaning queue by guest arrival"
```

### Task 2: Enforce The Five-Minute Ready Deadline

**Files:**
- Modify: `src/features/cleaning/derive-turnovers.test.ts`
- Modify: `src/features/cleaning/derive-turnovers.ts`
- Modify: `src/features/cleaning/cleaning-service.ts`

- [ ] **Step 1: Write the failing deadline test**

Set a fixture property buffer to a non-five value and assert an incoming `12:00` guest still receives an `11:55` ready deadline:

```ts
expect(task.readyDeadline.toISOString()).toBe("2026-07-11T06:25:00.000Z");
```

- [ ] **Step 2: Run the turnover tests and verify RED**

Run: `npm test -- src/features/cleaning/derive-turnovers.test.ts`

Expected: the deadline reflects the fixture buffer instead of five minutes.

- [ ] **Step 3: Derive arriving deadlines from a constant**

Use:

```ts
const READY_BUFFER_MINUTES = 5;
const readyDeadline = guestArrivalTime
  ? subMinutes(guestArrivalTime, READY_BUFFER_MINUTES)
  : indiaInstant(serviceDate, property.housekeepingCutoffTime);
```

Remove `checkinBufferMinutes` from `TurnoverProperty` and from the cleaning-service property query/mapping because it no longer affects scheduling.

- [ ] **Step 4: Run turnover and cleaning tests**

Run: `npm test -- src/features/cleaning/derive-turnovers.test.ts src/features/cleaning/scheduler.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit deadline enforcement**

```bash
git add src/features/cleaning/derive-turnovers.ts src/features/cleaning/derive-turnovers.test.ts src/features/cleaning/cleaning-service.ts
git commit -m "Fix cleaning ready deadline at five minutes"
```

### Task 3: Remove The Misleading Editable Check-In Buffer

**Files:**
- Modify: `src/features/properties/property-manager.test.tsx`
- Modify: `src/features/properties/property-manager.tsx`

- [ ] **Step 1: Write the failing property-form test**

Assert the form has no editable `Check-in buffer` control and that its POST body contains:

```ts
expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ checkinBufferMinutes: 5 });
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `npm test -- src/features/properties/property-manager.test.tsx`

Expected: the editable control is still present.

- [ ] **Step 3: Submit a fixed buffer**

Set `checkinBufferMinutes: 5` directly in `formPayload` and remove the visible check-in buffer input from `PropertyFields`. Keep the API schema and database column for backward compatibility.

- [ ] **Step 4: Run the component tests and verify GREEN**

Run: `npm test -- src/features/properties/property-manager.test.tsx`

Expected: both component tests pass.

- [ ] **Step 5: Commit the form correction**

```bash
git add src/features/properties/property-manager.tsx src/features/properties/property-manager.test.tsx
git commit -m "Fix property ready buffer at five minutes"
```

### Task 4: Verify And Publish

**Files:**
- Verify all modified files and generated artifacts only.

- [ ] **Step 1: Run complete verification**

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

Expected: all commands exit zero and the browser suite retains responsive Calendar and Today behavior.

- [ ] **Step 2: Restore generated outputs and inspect the branch**

```bash
git restore artifacts/screenshots next-env.d.ts
git diff --check
git status --short
```

- [ ] **Step 3: Push production main**

```bash
git fetch noirhaus main
git merge-base --is-ancestor noirhaus/main HEAD
git push noirhaus deploy-noirhaus-main:main
git ls-remote noirhaus refs/heads/main
```

Expected: GitHub `main` points to the final verified commit and triggers Vercel. No Supabase migration is required.
