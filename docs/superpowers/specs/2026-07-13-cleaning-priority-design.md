# Cleaning Queue Priority Design

## Goal

Order the Today cleaning queue around guest arrival urgency without leaving the cleaning team idle.

## Scheduling Rules

1. A task already marked `cleaning_now` remains pinned first.
2. Among rooms currently available for cleaning, rooms with an incoming guest are ordered by guest check-in time, earliest first.
3. Equal check-in times are resolved by effective release time, property name, then task ID for stable ordering.
4. If an earlier-check-in room is not yet released because of a late checkout or delay, the scheduler cleans the next available arriving room instead of waiting.
5. Rooms with no incoming guest remain after every room with an incoming guest, even when the no-arrival room is already available.
6. Once no arriving rooms remain, no-arrival rooms are ordered by effective release time, property name, then task ID.
7. Ready and skipped tasks remain outside the active queue in their existing completed section.

## Timing And Warnings

- Every arriving room has a ready deadline exactly five minutes before check-in.
- The ready deadline controls warning states only; it does not determine queue priority.
- Planned start and end times continue to account for checkout release, explicit delay, task duration, and any task already in progress.

## Data And UI

- No database migration or new environment variable is required.
- The existing Today queue UI and automatic shared-workspace refresh remain unchanged.
- Editing a check-in, checkout, delay, or duration causes the queue to be recalculated using these rules.

## Verification

- Unit coverage must prove chronological check-in ordering.
- Unit coverage must prove no-arrival rooms remain last.
- Unit coverage must prove an unavailable earlier arrival does not idle the team when a later arrival is available.
- Existing scheduler, Today queue, lint, type, build, and responsive browser tests must remain green.
