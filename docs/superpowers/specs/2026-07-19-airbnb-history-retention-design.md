# Airbnb History Retention Design

## Goal

Keep every Airbnb calendar event that Noir Haus has observed available in the admin calendar indefinitely after the stay ends, without allowing a missing future event to remain visible after a cancellation.

This change can recover qualifying events already stored in Supabase. It cannot reconstruct events that Airbnb stopped exporting before Noir Haus ever imported them.

## Current Failure

Airbnb's iCal feed is a changing availability snapshot, not a durable booking ledger. During synchronization, Noir Haus currently marks every active database event that is absent from the newest feed as inactive. Calendar and cleaning queries only read active events, so a past reservation disappears from the application when Airbnb later removes it from the feed even though its row remains in Supabase.

Manual blocked and direct entries do not have this problem because they are stored locally and are not reconciled against Airbnb's feed.

## Data Model

Migration `0006_preserve_airbnb_history.sql` adds this column to `public.external_calendar_events`:

```sql
historical boolean not null default false
```

The two state fields have distinct meanings:

- `active = true, historical = false`: the event is present in the latest Airbnb feed.
- `active = false, historical = true`: the event is absent from the feed but retained as observed history.
- `active = false, historical = false`: the event is archived as a cancellation or other future removal.

An event must not be both active and historical. Synchronization always clears `historical` when an event appears in the feed again.

An index covering rows where `active or historical` supports calendar and cleaning date-range reads.

## Synchronization Rules

Reconciliation receives the current India calendar date explicitly so its behavior is deterministic and testable.

For an incoming event:

1. Create it as active and non-historical when its source UID is new.
2. Update it as active and non-historical when its content changed, it was previously archived, or it was historical.
3. Leave an unchanged active event untouched.

For a previously observed event that is missing from the current feed:

1. If its checkout-exclusive `end_date` is today or earlier, mark it inactive and historical. The stay is complete and must remain visible.
2. If its `end_date` is after today, mark it inactive and non-historical. This preserves current cancellation behavior for ongoing or future events.
3. Leave an already historical event unchanged.
4. Leave an already archived non-historical event unchanged.

This boundary intentionally treats a checkout on the current India date as completed history. Because the application's iCal dates are checkout-exclusive, the room's occupied nights are already in the past at that point.

Sync run counts continue to report only actual cancellations in `archived_count`. Moving completed events into history is not counted as a cancellation.

## Existing Data Recovery

The migration marks a previously archived row historical only when both conditions hold:

- `end_date` is today or earlier in `Asia/Kolkata`.
- `last_seen_at` falls on or after `start_date` in `Asia/Kolkata`.

The second condition provides evidence that Noir Haus still observed the event after its stay began. It avoids reviving a future booking that was imported and then cancelled before check-in. Rows that do not meet both conditions remain archived.

Recovery changes only the `historical` flag. It does not reactivate rows, rewrite event content, or manufacture missing events.

## Calendar and Cleaning Reads

Calendar date-range queries include external events where `active or historical`. Historical entries use the same visual type and title as when they were active; no new calendar color or control is needed.

Cleaning turnover derivation also includes active or historical external events. This matters on checkout day if Airbnb removes a completed event before the cleaning queue is generated. Existing cleaning state, ordering, and five-minute ready deadline behavior remain unchanged.

Other external-event reads that represent observed occupancy use the same active-or-historical predicate. Current and future archived cancellations remain excluded.

## Security and Privacy

The migration does not change row-level security or workspace membership. Historical events remain available only through the same approved Supabase Auth workspace access as current events.

No guest payment, private note, or new personal data is introduced. No new Vercel environment variable is required.

## Testing

Focused tests cover:

- completed missing events moving to retained history
- ongoing and future missing events remaining normal archives
- unchanged historical rows staying untouched
- returned historical events becoming active again
- migration up/down contracts and conservative recovery predicates
- calendar and cleaning queries including active or historical events
- India-date boundary behavior

Before integration, the complete unit suite, lint, typecheck, production build, and Playwright suite must pass.

## Rollout

1. Run `0006_preserve_airbnb_history.sql` in Supabase before deploying application code that queries `historical`.
2. Confirm the migration completes successfully.
3. Push the verified application merge to `noirhausadmin/main`; Vercel deploys it automatically.
4. Open a past calendar range and confirm previously observed qualifying Airbnb events are visible.
5. Refresh current feeds and confirm past events remain while a test future cancellation disappears.

The application commit must not be pushed to production before the migration is applied, because the new queries depend on the new column.
