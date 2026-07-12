# Revenue Export and Mobile Performance Design

## Goals

This project delivers two related operational improvements:

1. Manual blocked and direct reservations capture an optional guest name and total payment, and administrators can export that revenue as a date-by-property CSV.
2. The Today page loads without task-count-dependent database latency, while shared-admin updates remain visible within roughly eight seconds without repeated full-page refreshes.

The work intentionally does not add offline operation. Live operational data must not silently appear current when the device has no connection.

## Current Performance Failure

`getCleaningQueue` currently performs base reads and then runs multiple archive, upsert, and schedule-update statements once per turnover. With seven turnovers, one page render can issue more than twenty sequential database statements. The dashboard also calls `router.refresh()` every eight seconds even when no data changed. Together these behaviors explain the reported 30-40 second Today load and can cause mobile or home-screen browsers to abandon an expensive navigation.

The performance fix addresses both sources:

- Cleaning reconciliation uses a fixed number of database statements independent of turnover count.
- Calculated planned times and warning levels remain derived in memory and are not rewritten during reads.
- The eight-second controller checks a lightweight workspace version and refreshes only after shared data actually changes.

## Cleaning Queue Reconciliation

The service continues to derive turnovers from property defaults, Airbnb reservation/unavailable entries, direct reservations, and operation overrides.

After derivation, the service performs set-based reconciliation:

1. Archive active queued/delayed tasks for properties that no longer have a derived turnover.
2. Archive non-running tasks whose outgoing or incoming source keys changed.
3. Bulk insert or update all derived tasks using one JSON recordset and the existing active-task conflict rule.
4. Read active tasks once and calculate ordering, planned times, and warnings in memory.

No loop may execute a database statement per derived or scheduled task. Existing running tasks remain pinned, while ready/skipped history and requeue behavior remain unchanged.

The production target is that Today data loading uses a fixed query budget and no longer grows linearly with the number of rooms. Live response time will be measured after deployment because authenticated production database latency cannot be reproduced by the demo fixture.

## Change-Aware Shared Refresh

A protected `/api/workspace-version` endpoint returns one opaque version based on the latest accessible update across:

- properties
- listings
- external calendar events
- local calendar entries
- operation overrides
- cleaning tasks

The endpoint scopes all records through the authenticated user's property memberships and sends `Cache-Control: no-store`.

The dashboard controller polls the endpoint every eight seconds and on window focus or visibility return. It stores the first version as its baseline and calls `router.refresh()` only when a later version differs. Only one version request may be in flight at a time. Network failures are ignored until the next poll, leaving the currently rendered workspace usable.

Successful local actions continue to update their client state immediately and call `router.refresh()`. The version poll exists for changes from another administrator or background Airbnb synchronization.

## Manual Entry Data

Migration `0005_manual_entry_payment.sql` adds this nullable column to `public.local_calendar_entries`:

```sql
payment_amount numeric(12,2) check (payment_amount >= 0)
```

The existing `private_booking_name` column becomes the guest name; no guest-name migration is necessary. Existing records retain their current name and receive a null payment.

The local entry editor shows these fields for both `blocked` and `direct_reservation`:

- `Guest name`, optional, maximum 1,000 characters through the existing private text rule.
- `Total payment (INR)`, optional, minimum 0, maximum 9,999,999,999.99, with two-decimal input precision.

Airbnb-imported entries remain read-only and do not accept manual payment data. Creating and editing a manual entry persists both values. Calendar event titles continue to prefer guest name over the generic entry label.

## CSV Export

The Calendar header gains an `Export CSV` command. It opens a compact dialog with inclusive start and end dates. The default range is the currently visible calendar range. The maximum export range is 366 dates.

The protected export API reads active, accessible properties and active manual entries of type `blocked` or `direct_reservation` that overlap the requested range. Airbnb-imported entries are excluded.

CSV structure:

- Column 1 is `Date` in `YYYY-MM-DD` format.
- Remaining columns are active property names, ordered by property name and ID.
- Every requested date receives one row, including dates without manual entries.
- A populated cell uses `Guest name - INR 1,234.56` when both values exist, the guest name alone when payment is absent, or `INR 1,234.56` when the guest name is absent.
- Multiple overlapping manual entries in one property/date are joined with ` | `.

Local entry `end_date` remains checkout-exclusive. A total payment is divided across all occupied nights in the full entry, not merely the exported subset. The calculation converts the total to integer paise, divides by occupied-night count, and allocates any remainder one paise at a time to the earliest nights. Thus INR 1,000 over three nights exports INR 333.34, INR 333.33, and INR 333.33, preserving the exact total.

CSV fields use standard double-quote escaping. Property and guest values beginning with spreadsheet formula characters (`=`, `+`, `-`, or `@`) are prefixed with an apostrophe before escaping.

The browser downloads `noir-haus-manual-bookings-START-to-END.csv`. While generation is pending, the export command is disabled and shows progress. Validation or server failures leave the dialog open and display a concise error.

## Mobile Reliability

The primary mobile fix is eliminating slow, repeated server renders. The existing responsive calendar and Today layouts remain unchanged except for the export dialog and button. The export dialog follows the established mobile bottom-sheet behavior and touch-size controls.

An application error boundary may present a retry control for application-render failures, but it cannot replace the browser's own no-connection page. If the device is genuinely offline, the user must reconnect. If the same browser failure persists after the server-latency fix, production request logs and the specific mobile browser will be inspected as a separate network diagnosis.

## Authorization and Privacy

- Every new API requires an authenticated Supabase user.
- Queries are restricted to properties present in `property_members` for that user.
- Payment and guest data never appear in public outbound iCal feeds.
- CSV export includes private operational data and is available only to approved authenticated administrators.
- Public signup remains disabled.

## Testing

The implementation adds focused coverage for:

- fixed-size cleaning reconciliation input and preservation of running/ready/skipped state
- workspace version authorization and version-change polling, including hidden tabs, in-flight requests, and failures
- payment schema validation and migration up/down contracts
- payment persistence through create, update, and calendar reads
- exact paise allocation across nights, partial export ranges, overlapping entries, CSV escaping, and formula protection
- export endpoint validation and response headers
- manual entry form submission and export dialog pending/error behavior
- responsive mobile and desktop export controls

Before integration, the complete unit suite, lint, typecheck, production build, and Playwright suite must pass. After deployment, the authenticated Today page must be timed with the user's live property set and tested from the affected mobile browser or home-screen app.

## Rollout

1. Run `0005_manual_entry_payment.sql` once in Supabase before deploying application code that writes `payment_amount`.
2. Push the verified application commit to `noirhausadmin/main` and allow Vercel to deploy it.
3. Confirm Today loads with the full live turnover set and remains connected through multiple eight-second polling intervals.
4. Create a two-night manual entry with guest and payment, edit it, then export a range containing both nights and verify the split totals.
5. Test the same workflows with the second approved administrator.

No new Vercel environment variables are required.
