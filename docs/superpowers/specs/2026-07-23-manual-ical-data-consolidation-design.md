# Manual-iCal Admin Data Consolidation Design

## Goal

Keep the new admin database authoritative for public bookings and payments while replacing its operational property/calendar data with the old database's data. Preserve the old database's past calendar history and require each Airbnb inbound iCal feed to be reattached manually because the old iCal encryption key cannot be recovered from Vercel.

## Chosen approach

Extend the existing dry-run-first database consolidation tool with an explicit manual-iCal mode. The tool connects directly to both Supabase databases, creates encrypted snapshots, reads the old database without writing to it, and updates the new database in one transaction only after validation and an exact confirmation phrase.

Manual-iCal mode never reads, prints, copies, or attempts to decrypt either database's inbound iCal ciphertext. Imported listings are placed in a first-class "iCal not connected" state. The administrator then pastes a fresh Airbnb iCal URL for each imported listing through the new admin UI, which encrypts it using the new deployment's existing sensitive `ICAL_ENCRYPTION_KEY`.

## Authoritative data split

The old/source database is authoritative for:

- properties and listing identities;
- existing external Airbnb calendar events, including retained historical events;
- manual direct reservations and blocked periods;
- operation overrides and cleaning tasks;
- sync history and non-booking operational audit history;
- outbound feed token hashes and enabled state.

The new/destination database remains authoritative for:

- website bookings, holds, guest details and booking-night prices;
- Razorpay orders, payments, events, jobs, refunds and audit history;
- notification outbox and booking events;
- public room slugs, website-booking availability and property pricing;
- destination Supabase Auth users and sessions.

Properties and listings are matched by normalized names. Preserved destination bookings and rates are remapped to the matching imported property. A destination booking whose property has no source match retains a minimal archived property so its financial and audit history remains valid.

## iCal-disconnected state

Add a forward database migration that allows `listings.inbound_ical_url_encrypted` to be null. Null means the listing has not yet been connected to an inbound Airbnb feed; it never represents a malformed or empty ciphertext.

The application must:

- list the property normally while showing a clear `iCal required` status;
- exclude disconnected listings from scheduled and manual inbound sync attempts;
- preserve already imported external events and their historical state while disconnected;
- accept a replacement URL through the existing property editor, encrypt it with the destination runtime key and reset sync status for an immediate clean sync;
- never expose a stored feed URL or ciphertext to the browser.

The migration imports no source or destination inbound ciphertext. The existing destination Vercel `ICAL_ENCRYPTION_KEY` stays unchanged and never needs to be revealed locally.

## Migration configuration

Manual-iCal mode requires only:

- `OLD_DATABASE_URL`;
- `NEW_DATABASE_URL`;
- `MIGRATION_BACKUP_PASSPHRASE` of at least 16 characters;
- `MIGRATION_ACTOR_EMAIL` matching an authenticated user in the destination project.

The existing key-based mode remains available for environments where both iCal keys are known. Manual-iCal mode requires an explicit command-line flag and rejects an apply if the destination schema does not support nullable inbound feeds.

The new Supabase project is identified as the project containing the current website `bookings` rows. Its Session Pooler URL comes from the Supabase `Connect` dialog. If its database password must be rotated, update the new Vercel project's sensitive `DATABASE_URL` and redeploy before migration.

## Safety and concurrency

Before any destination write:

- pause public booking creation for a short maintenance window;
- allow or release active payment holds before the apply step;
- verify source and destination fingerprints differ;
- verify required schemas and columns;
- create AES-256-GCM encrypted source and destination snapshots with file mode `0600`;
- print counts, matches, remaps and inventory conflicts without guest data or secrets;
- abort on duplicate property/listing identities, unmapped references or overlapping active inventory.

Apply uses one destination transaction. The source database is never modified. The new database is left unchanged if any validation or insert fails. The old Vercel project and Supabase database remain online until acceptance.

## Post-migration behavior

Immediately after apply, imported historical events, manual blocks and preserved website bookings continue to occupy the correct calendar dates. Scheduled inbound sync skips the disconnected listings rather than deleting or archiving their imported events.

For each property, the administrator obtains a fresh private export URL from Airbnb and saves it in the new admin property editor. The first successful sync reconciles current Airbnb availability while migration `0006` continues protecting qualifying historical events that Airbnb no longer exports.

Public booking creation remains paused until every active public property has an attached feed and a successful sync, inventory has no overlaps, and representative availability checks agree with Airbnb.

## Verification and acceptance

The migration is accepted only after confirming:

- imported table counts equal the dry-run plan;
- historical external events and manual blocks from the old database appear on the new calendar;
- destination bookings retain guest, payment, refund and notification history;
- active booking nights and imported operational nights have a single owner per property/date;
- pricing slugs and website-booking flags remain attached to their intended properties;
- disconnected listings cannot run inbound sync;
- saving a new iCal URL changes the property to connected, performs a successful sync and does not erase qualifying history;
- the old source counts remain unchanged;
- admin health, public availability, booking, payment, email and test-booking removal checks pass before public booking is resumed.

## Recovery

Keep both encrypted snapshots and the unchanged old database through acceptance. If post-apply verification fails, pause booking traffic, restore the encrypted destination snapshot, restore the previously deployed application version if required, and keep the old admin operational while the failure is investigated.
