# Admin data consolidation runbook

This one-use workflow replaces the canonical admin database's operational calendar data with the old admin database's data. It preserves the canonical database's bookings, payment history and public pricing configuration. The manual-iCal mode also preserves old calendar history without requiring either database's iCal encryption key; every imported listing intentionally starts disconnected and must be reconnected with a fresh Airbnb URL.

## Safety model

- The old/source database is read-only to this tool.
- The default command is a dry run.
- Both databases are exported to AES-256-GCM encrypted snapshots before any destination write.
- Apply requires an exact confirmation phrase and runs in one destination transaction.
- Duplicate property/listing identities, unmapped references and overlapping inventory abort the run.
- Manual-iCal mode never decrypts or copies an inbound feed secret and rolls back if any imported listing remains connected.
- The old Vercel project and database stay online until the migrated admin is accepted.

## Local configuration

Copy `.env.migration.example` to `.env.migration.local` and populate it locally. Do not paste these values into tickets, chat messages or source files.

Required values:

- `OLD_DATABASE_URL`
- `NEW_DATABASE_URL`
- `MIGRATION_BACKUP_PASSPHRASE`
- `MIGRATION_ACTOR_EMAIL`

`OLD_ICAL_ENCRYPTION_KEY` and `NEW_ICAL_ENCRYPTION_KEY` are required only by the default re-encrypt mode. They may remain placeholders when using `--manual-ical-reattach`. Set `MIGRATION_ACTOR_EMAIL` to an existing Supabase Auth user in the canonical destination. The populated file is ignored by Git.

## Pre-apply gates

1. Apply `supabase/migrations/0009_optional_inbound_ical.sql` to the canonical database before deploying the matching admin code.
2. Deploy the admin with public booking paused (`PUBLIC_BOOKING_ENABLED=false`) and verify `/api/health`.
3. Allow every active website hold/payment attempt to settle or expire. Do not apply while an active hold remains.
4. Record source and destination table counts. Keep both encrypted snapshots produced by the dry run and apply until acceptance.

## Dry run

```sh
npm run data:consolidate -- --env .env.migration.local --manual-ical-reattach
```

Review the printed source/destination/planned counts, `icalMode: manual-reattach`, and the disconnected-listing count. The command prints the paths of two encrypted snapshots in a permission-restricted temporary directory. Confirm the source and destination fingerprints differ and keep both snapshots until the new admin is accepted.

## Apply

Run apply only after a clean dry run, after removing any active Razorpay test booking that conflicts with imported dates, and after the pre-apply gates above are complete.

```sh
npm run data:consolidate -- --env .env.migration.local --manual-ical-reattach \
  --apply "REPLACE NEW OPERATIONS WITH OLD ADMIN DATA"
```

## Acceptance and resume

1. Confirm the old source counts are unchanged and the imported property, historical external-event, local-entry, and cleaning-task counts match the reviewed plan.
2. Confirm all canonical bookings, payments, booking prices, and public rates remain present.
3. Open every imported property, attach its fresh Airbnb export URL, save, and run **Refresh now**. Each listing must report a successful sync before acceptance.
4. Verify Calendar, Properties, Pricing, Bookings, inventory ownership, outbound feeds, and `/api/health`.
5. Keep the old database online and retain both encrypted snapshots until the owner accepts the migrated workspace.
6. Resume public booking only after every property is reconnected, historical counts pass, and the complete booking acceptance flow succeeds.
