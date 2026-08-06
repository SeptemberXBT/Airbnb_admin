# One-Click Early Checkout and Same-Day Rebooking Design

**Date:** 2026-08-07  
**Status:** Approved design, pending implementation plan

## Context

An owner may need to release a room immediately when a directly booked guest leaves before the planned checkout. Archiving the calendar entry releases inventory but removes it from the active calendar, while disabling **Block on Airbnb** only removes the entry from the outbound feed and does not release the room inside the admin inventory ledger.

The required workflow must preserve the original reservation record, release the room with one click, and allow a later Airbnb reservation for the same date to appear alongside the earlier stay without being treated as a double-booking collision.

## Decision

Use a lifecycle transition on the existing local calendar entry.

An eligible direct reservation receives a **Check out early — release room now** action. One click immediately marks that same record as completed early, records the actual checkout, releases its inventory, removes it from the outbound Airbnb feed, and keeps the original planned dates for history.

The operation has no confirmation dialog. The button is disabled while the request is running, and the server operation is idempotent so a double-click or retry cannot release a different entry or create duplicate history.

## Scope

The initial release applies only to active, manually entered `direct_reservation` records that are currently in progress:

- the source is local rather than Airbnb or the public website;
- the entry is not already archived or completed early;
- the India calendar date is on or after the planned check-in and before the planned checkout.

Airbnb-origin reservations remain controlled from Airbnb. Website-paid reservations retain their existing cancellation and refund workflow. Early checkout does not calculate, initiate, or imply a refund.

## Data Model

Add explicit early-checkout metadata to `local_calendar_entries`:

- `completed_early_at timestamptz null`
- `completed_early_by uuid null references auth.users(id)`
- `early_checkout_effective_date date null`

The three values are either all null or all populated. The original `start_date` and `end_date` never change. A completed-early entry has `active = false` but is not archived: `archived_at` remains null. This distinguishes an operationally completed stay from a discarded or archived entry.

The effective date is derived on the server from the current date in `Asia/Kolkata`; it is never accepted from the browser for the one-click action.

## Server Operation

Expose an authenticated endpoint scoped to a single local entry:

`POST /api/local-entries/[entryId]/early-checkout`

The endpoint performs one transaction:

1. Authenticate the admin user.
2. Lock the property inventory and the target entry.
3. Verify property membership and eligibility.
4. If the same entry is already completed early, return its existing completion result.
5. Set `active = false` and populate the early-checkout metadata without altering planned dates or private reservation details.
6. Release the entry's `manual_local` inventory claims.
7. Reconcile the affected property nights so another valid source can claim them immediately.
8. Write an audit record containing the original dates, effective release date, and actor.

The result means the room is immediately available to the admin availability engine. It does not wait for Airbnb.

## Airbnb Calendar Behavior

The outbound iCal feed already exports only active local entries. Because a completed-early entry becomes inactive, it disappears from the exported busy dates without deleting its database record.

Change the outbound iCal response to `Cache-Control: no-store, max-age=0`. This removes the application's current edge-cache delay. Airbnb still controls when it next pulls the imported calendar, so the UI must not promise an instant Airbnb update.

After the action, show:

`Released internally — awaiting Airbnb refresh`

After the first successful inbound Airbnb sync following completion no longer reports the original unavailable event, change the status to:

`Release observed on Airbnb`

The admin **Refresh now** action checks Airbnb-to-admin state; it cannot force Airbnb to pull the outbound feed.

## Calendar Presentation

Completed-early entries remain visible across their original planned date span with a faded, dashed treatment and the label **Completed early**. Opening one shows the original dates and actual checkout time in read-only form.

Completed-early entries are historical display records only:

- they do not count as occupied in vacancy calculations;
- they do not own inventory;
- they do not prevent new manual, website, or Airbnb reservations;
- they are excluded from the outbound iCal feed.

If Airbnb later supplies a reservation whose dates overlap the original planned span, display both records in separate calendar lanes. Label the situation **Same-day turnover · second booking**. It is not an Airbnb collision because the completed-early record no longer owns the night.

Only simultaneous active inventory claims are treated as double-booking conflicts.

## UI Flow

For an eligible direct reservation, the existing entry modal shows one additional amber warning action:

**Check out early — release room now**

The action runs immediately with no second confirmation. While it runs, the control is disabled and displays progress. On success, the modal refreshes in place into the read-only completed state, the calendar inventory refreshes, and a success notice states that internal release is complete while Airbnb refresh may still be pending.

The existing **Archive** action remains available for genuinely removing an entry from the operational calendar. It is not used for early checkout.

## Errors and Safety

- Unauthorized or cross-property requests return `403` without mutation.
- Missing entries return `404`.
- Future, archived, non-direct, Airbnb, and website-paid entries return `409` with a specific ineligible-state error.
- An already completed-early entry returns success with the original completion metadata.
- The property inventory lock serializes the release against incoming Airbnb sync, website booking confirmation, and manual entry creation.
- If the transaction fails, neither the entry state nor inventory changes.
- No payment or refund API is called.

## Testing

Add coverage for:

1. An eligible direct reservation transitions to completed early in one transaction.
2. Original dates and private booking history remain unchanged.
3. Inventory is released and availability becomes true immediately.
4. Repeating the request is idempotent.
5. Unauthorized, future, archived, Airbnb, and website-paid records cannot use the action.
6. The outbound iCal feed excludes the completed-early entry and sends no-store headers.
7. The calendar still renders the completed-early record as nonblocking history.
8. A later Airbnb reservation can claim the same night and both entries render in separate lanes with a same-day-turnover indicator.
9. Vacancy summaries ignore the completed-early record.
10. Existing archive, manual-entry, Airbnb-import, and website-booking behavior remains unchanged.

## Acceptance Criteria

- One click releases the room in the admin system.
- The original reservation record remains permanently queryable and visible.
- Original planned dates and payment notes are preserved.
- The outbound feed contains no busy event for the released stay.
- A new Airbnb booking for the released date imports normally and is shown as a second booking rather than a collision.
- The operation never triggers a refund.
- The interface accurately distinguishes immediate internal release from asynchronous Airbnb refresh.
