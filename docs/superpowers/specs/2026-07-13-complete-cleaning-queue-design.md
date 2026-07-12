# Complete Cleaning Queue Design

## Goal

The Today queue must show every Airbnb turnover that the operations calendar presents as occupied through the prior night. It must also let an administrator return an accidentally completed or skipped task to the active queue.

## Root Cause

The calendar displays external events classified as either `reservation` or `unavailable`, but cleaning derivation currently queries only `reservation` events. In the reported 13 July example, three reservation events produced tasks while four unavailable events ending on the same date were omitted.

## Turnover Eligibility

- External Airbnb events with type `reservation` or `unavailable` participate in turnover derivation.
- External events with type `unknown` remain excluded.
- Local `direct_reservation` entries continue to participate.
- Local `blocked` entries remain excluded.
- An eligible entry creates a checkout candidate when its checkout-exclusive `end_date` equals the Today service date.
- Multiple eligible entries for one physical property still produce no more than one cleaning task for that property and date.

This rule intentionally treats an Airbnb unavailable period ending today as requiring cleaning. It matches the operator's interpretation of the imported Airbnb calendar and the seven-checkout example supplied during design.

## Return To Queue

Completed (`ready`) and skipped tasks display a `Return to queue` command inside the expanded completed section.

The server accepts a new `requeue` cleaning action. It changes the task to `queued` and clears:

- `actual_start`
- `actual_end`
- `delay_minutes`

The existing queue scheduler recalculates planned start, planned end, and warning level on the next queue read. The client immediately moves the restored task into Up next and then refreshes the server state. Repeated clicks are disabled while the request is pending.

## Error Handling

- Only authenticated users with membership in the task's property can requeue it.
- Missing or archived tasks return the existing not-found response.
- A failed requeue request leaves the completed/skipped item unchanged and displays the existing queue error notice.
- Requeue does not change reservation dates, guest timing overrides, or cleaning duration.

## Testing

- A query contract test verifies external turnover loading includes `reservation` and `unavailable` but excludes `unknown`.
- Turnover tests verify one task per physical property remains intact.
- API/schema tests accept `requeue`.
- Today component tests verify ready and skipped items return to Up next immediately and failure preserves completed state.
- The complete unit, lint, typecheck, build, and responsive Playwright suites run before integration.

## Rollout

This fix requires no Supabase migration and no new environment variables. After merge to `main`, the existing Vercel Git integration deploys it. The previously required shared-admin migration remains unchanged.
