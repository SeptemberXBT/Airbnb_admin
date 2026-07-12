# Shared Admin Live Workspace Design

## Objective

Make Noir Haus Admin a single shared operational workspace. Every user account
created in this dedicated Supabase Auth project can see and manage the same
properties, calendar, cleaning queue, overrides, and history. Changes should
appear immediately for the acting admin and within eight seconds for another
admin viewing the same workspace.

Public signup must remain disabled. The design intentionally treats every
authenticated user in this Supabase project as an approved Noir Haus admin.

## Access Model

Keep `property_members` as the authorization boundary used by existing queries
and policies. Add database automation so it no longer needs manual maintenance:

- Backfill every existing Supabase Auth user as a manager of every existing
  property while preserving existing owner roles.
- When an Auth user is created, add that user as a manager of every property.
- When a property is created, add every Auth user as a manager of that property.
- Update property creation so the creating user is promoted to owner without
  conflicting with the automatic manager row.

This retains the current property-level policy structure while making all
properties shared in this single-workspace installation.

## Shared Refresh

Add one refresh controller at the authenticated application shell:

- Refresh server data every eight seconds while the document is visible.
- Refresh immediately when the window regains focus or the document becomes
  visible.
- Do not start overlapping refreshes.
- Preserve active client interactions and form input during refreshes.

Database writes remain authoritative. The acting screen also applies the
successful action locally so it does not appear stuck while the server refresh
is in flight. The periodic refresh reconciles both admins with Supabase.

## Site-Wide Mutation Feedback

Every write action in Calendar, Today, Properties, and Settings will follow the
same visible lifecycle:

1. Enter a pending state immediately and disable the action that initiated the
   request.
2. On success, update the affected client state or refetch its focused data
   endpoint immediately, then request a server refresh.
3. Close successful editors and disclosures, while keeping feedback visible on
   the page.
4. On failure, preserve the entered data, re-enable the action, and show a clear
   error without changing the displayed record.
5. Reconcile all pages through the eight-second shared refresh controller.

Calendar saves, archives, manual sync, property feed controls, cleaning actions,
and property creation/editing are all included. No successful action may depend
on a hard browser refresh before its result becomes visible.

## Today Queue

The Today queue will maintain local task state synchronized from refreshed
server props.

- Start, delay, skip, ready, and edit controls are disabled while their request
  is pending.
- A successful action updates the local task state immediately and requests a
  server refresh.
- A failed action leaves the prior state intact and shows an error.
- Ready tasks use a checked square checkbox indicator instead of the existing
  circular completion symbol.
- The completed section has an explicit plus/minus disclosure control.
- Expanded completed rows show the actual completion time from `actualEnd`.
- Skipped rows remain distinguishable and do not invent a completion time.

## Property Submission Reliability

The Add Property disclosure is controlled by the component rather than left as
an uncontrolled HTML detail element.

- Disable the active form and submit control for the complete request duration.
- Close and reset the Add Property form immediately after a successful save.
- Close an edit form after a successful update.
- Show success or failure feedback outside the closed form.
- Add a per-form creation request ID and persist it on the property so retries of
  the same request return the existing property instead of creating a duplicate.
- Generate a new creation request ID only when starting a genuinely new property
  submission.

## Database Migration

Migration `0004_shared_admin_workspace.sql` will:

1. Add the property creation request ID used for idempotency.
2. Backfill shared property memberships for existing Auth users.
3. Add security-definer trigger functions for new Auth users and properties.
4. Preserve existing owners and use manager as the default shared role.

The rollback removes triggers and the idempotency column but does not delete
membership rows, because deleting granted access during rollback would be a
destructive data operation.

## Error Handling

- Membership automation uses conflict-safe inserts.
- Property retries return the original property/listing IDs.
- UI actions expose a pending state and cannot be submitted twice.
- Refresh failures do not clear current data; the next interval retries.
- API failures keep dialogs open so entered data is not lost.

## Testing

- Migration tests cover the membership backfill, both triggers, owner promotion,
  and property creation request uniqueness.
- Today component tests cover immediate action state, checked completion UI,
  completed disclosure, actual completion time, and failed-action rollback.
- Property component tests cover pending disablement, successful close/reset,
  failure retention, and repeated-submit prevention.
- Browser tests exercise completing a cleaning task, expanding completed work,
  saving and archiving calendar entries, toggling property feed controls, and
  saving one property without a duplicate request or hard refresh.
- Run unit tests, lint, type checking, production build, and responsive
  Playwright verification before release.

## Rollout

Apply migration `0004` before deploying the application commit. Confirm public
signup remains disabled, sign in as both approved admins, and verify that each
sees the same existing properties. Keep both Today pages open, complete one task
from the first account, and confirm the second account updates within eight
seconds.
