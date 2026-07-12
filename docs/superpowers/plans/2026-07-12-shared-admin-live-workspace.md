# Shared Admin Live Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every approved Supabase Auth user share one Noir Haus workspace, keep both admin screens synchronized within eight seconds, and make every mutation visibly complete without hard refreshes or duplicate property creation.

**Architecture:** Preserve `property_members` as the authorization boundary, but maintain it automatically with database triggers for all Auth users and properties. Add a shell-level refresh controller for cross-admin reconciliation, while mutation components keep focused local state for immediate feedback. Property creation receives a stable request UUID backed by a unique database column so retries are idempotent.

**Tech Stack:** Next.js App Router, React 19, TypeScript, PostgreSQL/Supabase migrations, Vitest/Testing Library, Playwright, Lucide icons.

---

### Task 1: Shared Membership And Idempotency Migration

**Files:**
- Create: `supabase/migrations/0004_shared_admin_workspace.sql`
- Create: `supabase/migrations/0004_shared_admin_workspace.down.sql`
- Modify: `src/lib/db/migration.test.ts`
- Modify: `DEPLOYMENT.md`

- [ ] **Step 1: Write the failing migration assertions**

Extend `src/lib/db/migration.test.ts` to load migration `0004` and assert that it contains the creation-request column, membership backfill, Auth-user trigger, property trigger, and conflict-safe inserts:

```ts
it("shares every property with approved Auth users and deduplicates creation requests", async () => {
  const sql = await readFile(path.join(process.cwd(), "supabase/migrations/0004_shared_admin_workspace.sql"), "utf8");
  expect(sql).toMatch(/creation_request_id uuid/i);
  expect(sql).toMatch(/cross join auth\.users/i);
  expect(sql).toMatch(/after insert on auth\.users/i);
  expect(sql).toMatch(/after insert on public\.properties/i);
  expect(sql).toMatch(/on conflict \(property_id, user_id\) do nothing/i);
});
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `npm test -- --run src/lib/db/migration.test.ts`

Expected: FAIL because `0004_shared_admin_workspace.sql` does not exist.

- [ ] **Step 3: Add the forward and rollback migrations**

Create `0004_shared_admin_workspace.sql` with:

```sql
alter table public.properties add column creation_request_id uuid;
create unique index properties_creation_request_unique
  on public.properties (creation_request_id) where creation_request_id is not null;

insert into public.property_members (property_id, user_id, role)
select p.id, u.id, 'manager'
from public.properties p cross join auth.users u
on conflict (property_id, user_id) do nothing;

create or replace function public.share_new_property_with_auth_users()
returns trigger language plpgsql security definer set search_path = public, auth
as $$
begin
  insert into public.property_members (property_id, user_id, role)
  select new.id, u.id, 'manager' from auth.users u
  on conflict (property_id, user_id) do nothing;
  return new;
end;
$$;

create trigger share_new_property_with_auth_users
after insert on public.properties
for each row execute function public.share_new_property_with_auth_users();

create or replace function public.share_properties_with_new_auth_user()
returns trigger language plpgsql security definer set search_path = public, auth
as $$
begin
  insert into public.property_members (property_id, user_id, role)
  select p.id, new.id, 'manager' from public.properties p
  on conflict (property_id, user_id) do nothing;
  return new;
end;
$$;

create trigger share_properties_with_new_auth_user
after insert on auth.users
for each row execute function public.share_properties_with_new_auth_user();
```

The down migration drops both triggers/functions, the unique index, and the column. It intentionally leaves membership rows intact.

- [ ] **Step 4: Document migration order**

Add `0004_shared_admin_workspace.sql` after `0003` in `DEPLOYMENT.md`, and state that public signup must remain disabled because every Auth user receives shared access.

- [ ] **Step 5: Run the migration tests**

Run: `npm test -- --run src/lib/db/migration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the migration**

```bash
git add supabase/migrations/0004_shared_admin_workspace.sql supabase/migrations/0004_shared_admin_workspace.down.sql src/lib/db/migration.test.ts DEPLOYMENT.md
git commit -m "Add shared admin workspace migration"
```

### Task 2: Global Eight-Second Refresh Controller

**Files:**
- Create: `src/components/shared-workspace-refresh.tsx`
- Create: `src/components/shared-workspace-refresh.test.tsx`
- Modify: `src/components/app-shell.tsx`

- [ ] **Step 1: Write failing refresh-controller tests**

Mock `next/navigation`, use fake timers, and verify one refresh after eight seconds, no refresh while hidden, and immediate refresh when focus returns:

```tsx
it("refreshes visible shared data every eight seconds and on focus", async () => {
  vi.useFakeTimers();
  render(<SharedWorkspaceRefresh />);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run src/components/shared-workspace-refresh.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the controller**

Create a client component that calls `router.refresh()` every `8_000` ms only when `document.visibilityState === "visible"`, also listens for `focus` and `visibilitychange`, and clears all listeners/timers on unmount.

```tsx
export function SharedWorkspaceRefresh() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const interval = window.setInterval(refresh, 8_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}
```

Render it once inside the authenticated `AppShell`.

- [ ] **Step 4: Run component and shell tests**

Run: `npm test -- --run src/components/shared-workspace-refresh.test.tsx src/components/app-shell.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the refresh controller**

```bash
git add src/components/shared-workspace-refresh.tsx src/components/shared-workspace-refresh.test.tsx src/components/app-shell.tsx
git commit -m "Refresh shared workspace automatically"
```

### Task 3: Immediate Today Actions And Completed Work

**Files:**
- Modify: `src/features/cleaning/today-queue.tsx`
- Modify: `src/features/cleaning/today-queue.test.tsx`
- Modify: `src/app/(dashboard)/today/page.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing Today interaction tests**

Add tests that mock a successful `/api/cleaning` request, click Ready, and expect the task to move immediately into an expandable completed section with a checked square and actual completion time. Also test that `+` becomes `-` when expanded and that a failed request leaves the task in its original state.

```tsx
expect(await screen.findByRole("button", { name: /show completed/i })).toHaveAttribute("aria-expanded", "false");
await user.click(screen.getByRole("button", { name: /show completed/i }));
expect(screen.getByLabelText("Completed")).toBeInTheDocument();
expect(screen.getByText(/Completed at/)).toBeInTheDocument();
```

- [ ] **Step 2: Run the Today tests and verify they fail**

Run: `npm test -- --run src/features/cleaning/today-queue.test.tsx`

Expected: FAIL because tasks are prop-only, completion uses a circular icon, and the disclosure has no explicit plus/minus control or completion-time text.

- [ ] **Step 3: Add immediate local task state**

Initialize `localTasks` from props. On a successful action, update the affected task before calling `router.refresh()`:

```ts
const nowIso = new Date().toISOString();
setLocalTasks((current) => current.map((item) => item.id !== task.id ? item : {
  ...item,
  status: action === "ready" ? "ready" : action === "start" ? "cleaning_now" : action === "skip" ? "skipped" : item.status,
  actualStart: action === "start" ? nowIso : item.actualStart,
  actualEnd: action === "ready" ? nowIso : item.actualEnd,
  delayMinutes: action === "delay" ? Number(values.delayMinutes ?? item.delayMinutes) : item.delayMinutes,
}));
```

Give `TodayQueue` a server-state key in `today/page.tsx` based on task IDs, statuses, and timestamps so the eight-second server refresh remounts it only when authoritative task data changes.

- [ ] **Step 4: Add completed checkbox and disclosure**

Use Lucide `SquareCheckBig`, `Plus`, and `Minus`. Replace the completed `<details>` with an accessible button using `aria-expanded`. Completed cards render `Completed at {time(task.actualEnd)}` and a checked square labeled `Completed`; skipped cards retain their skipped label.

- [ ] **Step 5: Remove the Today-only 30-second timer**

Delete the existing interval from `TodayQueue`; the shell controller is now the single refresh mechanism.

- [ ] **Step 6: Run Today tests**

Run: `npm test -- --run src/features/cleaning/today-queue.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit Today behavior**

```bash
git add src/features/cleaning/today-queue.tsx src/features/cleaning/today-queue.test.tsx 'src/app/(dashboard)/today/page.tsx' src/app/globals.css
git commit -m "Make cleaning actions update immediately"
```

### Task 4: Duplicate-Safe Property Creation And Immediate Lists

**Files:**
- Modify: `src/features/properties/property-schema.ts`
- Modify: `src/features/properties/property-service.ts`
- Modify: `src/app/api/properties/route.ts`
- Modify: `src/features/properties/property-manager.tsx`
- Create: `src/features/properties/property-manager.test.tsx`
- Modify: `src/features/properties/property-schema.test.ts`

- [ ] **Step 1: Write failing property-manager tests**

Test that Save disables during the request, a second submit cannot issue another POST, success closes/resets Add Property, and failure leaves it open with entered values. Also test that feed toggles update the visible row after the GET refresh.

```tsx
expect(screen.getByText("Add property").closest("details")).not.toHaveAttribute("open");
expect(fetchMock.mock.calls.filter(([url]) => url === "/api/properties" && requestMethod === "POST")).toHaveLength(1);
```

- [ ] **Step 2: Run the property tests and verify they fail**

Run: `npm test -- --run src/features/properties/property-manager.test.tsx src/features/properties/property-schema.test.ts`

Expected: FAIL because the form stays open, the list is prop-only, and creation has no request ID.

- [ ] **Step 3: Add the creation request contract**

Create a POST-specific schema by extending the existing property schema:

```ts
export const createPropertyListingSchema = propertyListingSchema.extend({
  creationRequestId: z.uuid(),
});
```

The client generates `crypto.randomUUID()` for the active Add Property form and sends it with POST requests.

- [ ] **Step 4: Make property creation idempotent**

Within the transaction, insert the property with `creation_request_id` and `on conflict (creation_request_id) do nothing returning id`. If no row returns, select the existing property/listing IDs and return `{ duplicate: true }`. For a new row, upsert the creator membership as owner:

```sql
insert into public.property_members (property_id, user_id, role)
values (${property.id}, ${userId}, 'owner')
on conflict (property_id, user_id) do update set role = 'owner'
```

The POST route returns `201` for a new property and `200` for an idempotent retry.

- [ ] **Step 5: Control property disclosures and state**

Maintain a local property list. After any successful property/feed mutation, GET `/api/properties`, replace the local list, and call `router.refresh()`. Close/reset the active Add/Edit disclosure on success, rotate the request UUID, and keep it open on failure. Track a unique saving key so only the active form/control is disabled.

- [ ] **Step 6: Run property tests**

Run: `npm test -- --run src/features/properties/property-manager.test.tsx src/features/properties/property-schema.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit property reliability**

```bash
git add src/features/properties/property-schema.ts src/features/properties/property-schema.test.ts src/features/properties/property-service.ts src/features/properties/property-manager.tsx src/features/properties/property-manager.test.tsx src/app/api/properties/route.ts
git commit -m "Prevent duplicate property submissions"
```

### Task 5: Calendar Mutation Pending States

**Files:**
- Modify: `src/features/calendar/calendar-workspace.tsx`
- Create: `src/features/calendar/calendar-workspace.test.tsx`
- Modify: `e2e/responsive.spec.ts`

- [ ] **Step 1: Add a failing component assertion for repeated calendar saves**

Render `CalendarWorkspace` with `demoMode={false}` and mock `/api/local-entries` plus the focused `/api/calendar-window` reload. Submit once, assert the Save button becomes disabled while pending, and assert the dialog closes after success without a hard page reload. Extend the existing Playwright editor test only to verify the pending-capable control remains accessible at mobile size.

- [ ] **Step 2: Run the focused component test and verify it fails**

Run: `npm test -- --run src/features/calendar/calendar-workspace.test.tsx`

Expected: FAIL because there is no explicit mutation-pending state and repeated submission is not guarded.

- [ ] **Step 3: Add a calendar mutation key**

Track `mutationPending` for save/archive/manual sync. Guard handlers from re-entry, disable the relevant buttons, show a spinner label, and clear the key in `finally`. Keep the existing focused `jumpTo(visibleDate)` reload after a successful mutation and close the dialog only after success.

- [ ] **Step 4: Run the focused component test**

Run: `npm test -- --run src/features/calendar/calendar-workspace.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit calendar mutation feedback**

```bash
git add src/features/calendar/calendar-workspace.tsx src/features/calendar/calendar-workspace.test.tsx e2e/responsive.spec.ts
git commit -m "Show calendar mutation progress"
```

### Task 6: Full Verification And Release Handoff

**Files:**
- Modify: `artifacts/screenshots/*.png` through Playwright only

- [ ] **Step 1: Run the complete unit suite**

Run: `npm test`

Expected: 0 failures.

- [ ] **Step 2: Run static checks**

Run: `npm run lint`

Expected: exit 0.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: successful Next.js production build.

- [ ] **Step 4: Run full browser verification**

Run: `DEMO_MODE=true npm run test:e2e`

Expected: all mobile, tablet, and desktop tests pass; regenerate responsive screenshots.

- [ ] **Step 5: Inspect final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors and only intended files changed.

- [ ] **Step 6: Commit verification artifacts**

```bash
git add artifacts/screenshots
git commit -m "Update shared workspace verification artifacts"
```

- [ ] **Step 7: Prepare deployment order**

Record the required release sequence: apply Supabase migration `0004`, push the feature commit to `noirhausadmin/main`, allow Vercel to create a deployment for the new commit, verify both admin accounts, and promote that exact deployment to Production.
