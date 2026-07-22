# Admin data consolidation runbook

This one-use workflow replaces the canonical admin database's operational calendar data with the old admin database's data. It preserves the canonical database's bookings, payment history and public pricing configuration.

## Safety model

- The old/source database is read-only to this tool.
- The default command is a dry run.
- Both databases are exported to AES-256-GCM encrypted snapshots before any destination write.
- Apply requires an exact confirmation phrase and runs in one destination transaction.
- Duplicate property/listing identities, iCal decryption failures, unmapped references and overlapping inventory abort the run.
- The old Vercel project and database stay online until the migrated admin is accepted.

## Local configuration

Copy `.env.migration.example` to `.env.migration.local` and populate it locally. Do not paste these values into tickets, chat messages or source files.

Required values:

- `OLD_DATABASE_URL`
- `NEW_DATABASE_URL`
- `OLD_ICAL_ENCRYPTION_KEY`
- `NEW_ICAL_ENCRYPTION_KEY`
- `MIGRATION_BACKUP_PASSPHRASE`

Set `MIGRATION_ACTOR_EMAIL` to the canonical administrator email. The populated file is ignored by Git.

## Dry run

```sh
npm run data:consolidate -- --env .env.migration.local
```

Review the printed source/destination/planned counts. The command prints the paths of two encrypted snapshots in a permission-restricted temporary directory. Keep both snapshots until the new admin is accepted.

## Apply

Run apply only after a clean dry run and after removing any active Razorpay test booking that conflicts with imported dates.

```sh
npm run data:consolidate -- --env .env.migration.local --apply "REPLACE NEW OPERATIONS WITH OLD ADMIN DATA"
```

After commit, verify Properties, Calendar, Pricing, Bookings, iCal sync and the health endpoint. Confirm the old source counts are unchanged and retain the encrypted snapshots until acceptance.
