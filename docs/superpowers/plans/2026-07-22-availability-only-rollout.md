# Availability-only Public Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the production Noir Haus public site receive authoritative room availability and prices from `noirhausadmin-booking-preview` while booking creation, holds, Razorpay, and email remain disabled.

**Architecture:** Add one fail-closed admin environment gate at the internal availability boundary. The availability route proceeds when either `PUBLIC_AVAILABILITY_ENABLED` or the existing full-booking flag is exactly `"true"`; the booking-create route remains guarded only by `PUBLIC_BOOKING_ENABLED`. No public-site code or API response contract changes.

**Tech Stack:** Next.js 16 App Router, TypeScript 6, Vitest 4, Vercel CLI, Vercel Production environment variables.

---

## Scope and Safety Rules

- Worktree: `/Users/retyush/.config/superpowers/worktrees/airbnb-operations-calendar/public-booking`
- Approved design: `docs/superpowers/specs/2026-07-22-availability-only-rollout-design.md`
- Vercel project: `noirhausadmin-booking-preview`
- Public consumer: `https://noirhaus-public.vercel.app`
- Keep `PUBLIC_BOOKING_ENABLED=false` throughout this rollout.
- Do not add Razorpay or ZeptoMail credentials, create holds, or modify the public website.
- Invalid, absent, or differently cased flag values remain disabled.
- The user explicitly approved the live availability-only Production rollout; this does not authorize full booking enablement.

### Task 1: Lock the Route-gate Contract with a Failing Test

**Files:**
- Create: `src/app/api/internal/v1/availability/route.test.ts`
- Verify unchanged behavior: `src/app/api/internal/v1/bookings/route.ts`

- [ ] **Step 1: Add isolated route mocks and a valid availability request**

Create hoisted mocks so the route test exercises the real route gate but does not reach authentication, Postgres, iCal, payment, or email integrations:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authenticateInternalRequest = vi.hoisted(() => vi.fn());
const quoteAvailability = vi.hoisted(() => vi.fn());

vi.mock("@/features/internal-api/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/internal-api/request-auth")>()),
  authenticateInternalRequest,
}));

vi.mock("@/features/bookings/booking-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/bookings/booking-service")>()),
  quoteAvailability,
}));

const availabilityInput = {
  publicRoomSlug: "emerald-suite",
  checkin: "2026-08-05",
  checkout: "2026-08-06",
  guests: 1,
};

function availabilityRequest() {
  return new Request("https://admin.test/api/internal/v1/availability", {
    method: "POST",
    body: JSON.stringify(availabilityInput),
  });
}
```

In `beforeEach`, reset the mocks, stub both rollout flags to `"false"`, make authentication return the serialized request body, and make `quoteAvailability` resolve to a small successful quote fixture. In `afterEach`, call `vi.unstubAllEnvs()`.

- [ ] **Step 2: Add the four gate cases**

Assert:

1. both flags false returns `503` with `{ error: "booking_disabled" }` and never authenticates or quotes;
2. only `PUBLIC_AVAILABILITY_ENABLED=true` returns the mocked `200` quote and calls `quoteAvailability(availabilityInput)`;
3. only `PUBLIC_BOOKING_ENABLED=true` also returns the mocked `200` quote for backward-compatible full rollout;
4. with only the availability flag true, `POST` from `src/app/api/internal/v1/bookings/route.ts` still returns `503 booking_disabled` before authentication.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npm test -- src/app/api/internal/v1/availability/route.test.ts
```

Expected: the availability-only case fails because the current route still checks only `PUBLIC_BOOKING_ENABLED`; it receives `503` instead of `200`. The other safety cases pass.

### Task 2: Implement the Minimal Fail-closed Availability Gate

**Files:**
- Modify: `src/app/api/internal/v1/availability/route.ts`
- Test: `src/app/api/internal/v1/availability/route.test.ts`

- [ ] **Step 1: Change only the availability route condition**

Replace the current single-flag condition with:

```ts
const availabilityEnabled =
  process.env.PUBLIC_AVAILABILITY_ENABLED === "true" ||
  process.env.PUBLIC_BOOKING_ENABLED === "true";

if (!availabilityEnabled) {
  return NextResponse.json({ error: "booking_disabled" }, { status: 503 });
}
```

Leave the booking-create route unchanged so only `PUBLIC_BOOKING_ENABLED === "true"` can pass its gate.

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```bash
npm test -- src/app/api/internal/v1/availability/route.test.ts
```

Expected: all four route-gate cases pass.

- [ ] **Step 3: Commit the tested behavior**

```bash
git add src/app/api/internal/v1/availability/route.ts src/app/api/internal/v1/availability/route.test.ts
git commit -m "Allow availability-only public quotes"
```

### Task 3: Document the New Rollout State

**Files:**
- Modify: `.env.example`
- Modify: `docs/booking-test-mode-runbook.md`

- [ ] **Step 1: Add the fail-closed example variable**

Place this next to the existing booking flag in `.env.example`:

```text
PUBLIC_AVAILABILITY_ENABLED=false
PUBLIC_BOOKING_ENABLED=false
```

- [ ] **Step 2: Update the runbook**

Add `PUBLIC_AVAILABILITY_ENABLED` to the admin environment-variable list. Document the three supported states:

```text
availability=false, booking=false  -> all public API operations disabled
availability=true,  booking=false  -> quotes enabled; booking creation disabled
availability=any,   booking=true   -> quotes and booking creation enabled
```

State that the availability-only state does not require Razorpay, ZeptoMail, or a healthy booking worker because it creates no booking or payment state.

- [ ] **Step 3: Verify docs and commit**

Run:

```bash
git diff --check
rg -n "PUBLIC_AVAILABILITY_ENABLED|availability-only" .env.example docs/booking-test-mode-runbook.md
```

Expected: no whitespace errors; both operational files name the new flag and explain the safe intermediate state.

```bash
git add .env.example docs/booking-test-mode-runbook.md
git commit -m "Document availability-only rollout flag"
```

### Task 4: Run Repository Verification

**Files:**
- Verify only; no expected source changes

- [ ] **Step 1: Run unit tests**

```bash
npm test
```

Expected: all non-database Vitest suites pass, including the four new route-gate cases.

- [ ] **Step 2: Run static checks and the production build**

```bash
npm run lint
npm run typecheck
npm run build
```

Expected: all commands exit `0`; Next.js produces the internal availability and booking route handlers without type or lint errors.

- [ ] **Step 3: Review the exact rollout diff**

```bash
git status --short --branch
git diff HEAD~2 --check
git diff HEAD~2 --stat
```

Expected: only the route, its test, `.env.example`, and the booking runbook changed after the plan commit; no public-site, payment, email, migration, or property data files changed.

### Task 5: Configure and Deploy the Booking-preview Admin to Production

**Files:**
- Vercel Production environment for the already-linked `noirhausadmin-booking-preview` project
- No repository file changes

- [ ] **Step 1: Confirm CLI and project linkage**

```bash
command -v vercel
vercel project inspect noirhausadmin-booking-preview
```

Expected: Vercel CLI is available and the linked project is exactly `noirhausadmin-booking-preview`, not `noirhausadmin` or `noirhaus-public`.

- [ ] **Step 2: Add only the availability flag to Production**

```bash
vercel env add PUBLIC_AVAILABILITY_ENABLED production --value true --sensitive --yes
```

Do not modify `PUBLIC_BOOKING_ENABLED`, which remains false. Then run:

```bash
vercel env ls production
```

Expected: `PUBLIC_AVAILABILITY_ENABLED` is listed for Production, while the existing full-booking flag remains present and unchanged.

- [ ] **Step 3: Deploy the approved Production change**

```bash
vercel deploy --prod -y
```

Use a ten-minute timeout. Expected: the deployment finishes `Ready` for project `noirhausadmin-booking-preview` and receives its Production alias.

- [ ] **Step 4: Inspect deployment metadata without issuing an extra HTTP request**

```bash
vercel inspect DEPLOYMENT_URL
```

Expected: target is `production`, status is `Ready`, framework is Next.js, and the deployment contains both internal route functions. Per deployment policy, do not `curl` or otherwise fetch the newly deployed URL from the agent.

- [ ] **Step 5: Complete the live UI acceptance check**

On `https://noirhaus-public.vercel.app`, check `emerald-suite` for August 5–6, 2026 with one guest.

Expected: the page no longer says “Live availability is temporarily unavailable.” It shows the authoritative available/unavailable result and price from admin. If available, opening the ordinary form remains possible; submitting while `PUBLIC_BOOKING_ENABLED=false` must show the existing safe failure and must not open Razorpay or create a hold.

Record the Production deployment URL and the UI result in the handoff. If availability now reaches admin but reports occupied, capacity, or configuration errors, diagnose that independently without enabling full booking.
