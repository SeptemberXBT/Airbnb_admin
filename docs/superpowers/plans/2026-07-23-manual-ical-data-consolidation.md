# Manual-iCal Data Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the new admin database's website bookings and payments while replacing its operational property/calendar data with the old database's complete history, deliberately requiring each imported Airbnb iCal feed to be reattached.

**Architecture:** Add a nullable, first-class disconnected-feed state to `listings`, make sync ignore disconnected listings, and extend the existing direct database consolidation tool with an explicit `--manual-ical-reattach` mode that does not require either iCal key. The source stays read-only, the destination is backed up and changed transactionally, preserved website bookings/rates are remapped by normalized property identity, and imported listings receive `NULL` inbound feeds until an administrator reconnects them through the existing encrypted property editor.

**Tech Stack:** Next.js 16, React 19, TypeScript 6, PostgreSQL/Supabase migrations, postgres.js, Node.js migration scripts, Vitest, Node test runner, Testing Library.

---

## File map

- Create `supabase/migrations/0009_optional_inbound_ical.sql`: allow an imported listing to exist without an inbound feed.
- Create `supabase/migrations/0009_optional_inbound_ical.down.sql`: guarded rollback that refuses while disconnected rows exist.
- Modify `src/lib/db/migration.test.ts`: statically verify both directions of migration `0009`.
- Modify `src/features/properties/property-service.ts`: expose connected state and reset sync status when a new URL is saved.
- Modify `src/features/properties/property-manager.tsx`: display `iCal required` for disconnected listings.
- Modify `src/features/properties/property-manager.test.tsx`: test the disconnected status and reconnect request.
- Create `src/features/properties/property-service-contract.test.ts`: verify the server query and reconnect update retain their security invariants.
- Modify `src/features/sync/sync-service.ts`: select only listings with a connected inbound feed.
- Modify `src/features/sync/sync-service-contract.test.ts`: verify manual and scheduled sync skip disconnected listings.
- Modify `scripts/admin-data-consolidation/contract.mjs`: parse the explicit manual mode and make key validation mode-dependent.
- Modify `scripts/admin-data-consolidation/contract.test.mjs`: test CLI/config safety for both key-based and manual modes.
- Modify `scripts/admin-data-consolidation/planner.mjs`: clear inbound ciphertext and sync status in manual mode without reading plaintext.
- Modify `scripts/admin-data-consolidation/planner.test.mjs`: test history preservation, ciphertext removal and identity conflict behavior.
- Modify `scripts/admin-data-consolidation/database.mjs`: assert the destination column supports the disconnected state.
- Modify `scripts/admin-data-consolidation/apply.mjs`: assert manual-mode postconditions after transactional apply.
- Modify `scripts/consolidate-admin-data.mjs`: select key-based or manual preparation and report disconnected counts.
- Modify `.env.migration.example`: document that iCal keys are optional only with the explicit manual flag.
- Modify `docs/admin-data-consolidation-runbook.md`: document dry-run, apply, reconnection, verification and rollback order.
- Modify `DEPLOYMENT.md`: include migration `0009` and disconnected-feed behavior.

### Task 1: Add the disconnected inbound-iCal database state

**Files:**
- Create: `supabase/migrations/0009_optional_inbound_ical.sql`
- Create: `supabase/migrations/0009_optional_inbound_ical.down.sql`
- Modify: `src/lib/db/migration.test.ts`

- [ ] **Step 1: Write the failing migration contract test**

Append this test inside the existing `describe` block in `src/lib/db/migration.test.ts`:

```ts
it("supports an explicit disconnected inbound iCal state", async () => {
  const [up, down] = await Promise.all([
    readFile(path.join(process.cwd(), "supabase/migrations/0009_optional_inbound_ical.sql"), "utf8"),
    readFile(path.join(process.cwd(), "supabase/migrations/0009_optional_inbound_ical.down.sql"), "utf8"),
  ]);

  expect(up).toMatch(/alter table public\.listings[\s\S]*inbound_ical_url_encrypted drop not null/i);
  expect(down).toMatch(/inbound_ical_url_encrypted is null/i);
  expect(down).toMatch(/raise exception 'cannot require inbound ical while disconnected listings exist'/i);
  expect(down).toMatch(/inbound_ical_url_encrypted set not null/i);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- src/lib/db/migration.test.ts`

Expected: FAIL because the `0009` files do not exist.

- [ ] **Step 3: Add the forward and guarded rollback migrations**

Create `supabase/migrations/0009_optional_inbound_ical.sql`:

```sql
alter table public.listings
  alter column inbound_ical_url_encrypted drop not null;
```

Create `supabase/migrations/0009_optional_inbound_ical.down.sql`:

```sql
do $$
begin
  if exists (
    select 1 from public.listings
    where inbound_ical_url_encrypted is null
  ) then
    raise exception 'cannot require inbound ical while disconnected listings exist';
  end if;
end
$$;

alter table public.listings
  alter column inbound_ical_url_encrypted set not null;
```

- [ ] **Step 4: Run the migration contract test**

Run: `npm test -- src/lib/db/migration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the schema change**

```bash
git add supabase/migrations/0009_optional_inbound_ical.sql supabase/migrations/0009_optional_inbound_ical.down.sql src/lib/db/migration.test.ts
git commit -m "feat: support disconnected inbound iCal feeds"
```

### Task 2: Show disconnected properties and reconnect safely

**Files:**
- Modify: `src/features/properties/property-service.ts`
- Modify: `src/features/properties/property-manager.tsx`
- Modify: `src/features/properties/property-manager.test.tsx`
- Create: `src/features/properties/property-service-contract.test.ts`

- [ ] **Step 1: Write failing UI and server contract tests**

Add `inboundIcalConnected: true` to the existing `property` fixture in `property-manager.test.tsx`, then add:

```tsx
it("marks an imported listing as requiring iCal and reconnects it through the protected editor", async () => {
  const disconnected = { ...property, inboundIcalConnected: false };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ properties: [property] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PropertyManager initialProperties={[disconnected]} demoMode={false} />);

  expect(screen.getByText("iCal required")).toBeVisible();
  await userEvent.click(screen.getByText("Edit"));
  const editor = screen.getByText("Edit").closest("details");
  if (!editor) throw new Error("Missing property editor");
  fillPropertyForm(editor);
  await userEvent.click(editor.querySelector<HTMLButtonElement>('button[type="submit"]')!);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const request = fetchMock.mock.calls[0][1] as RequestInit;
  expect(request.method).toBe("PATCH");
  expect(JSON.parse(String(request.body))).toMatchObject({
    propertyId: property.id,
    listingId: property.listingId,
    inboundIcalUrl: "https://www.airbnb.com/calendar/ical/123.ics?s=secret",
  });
});
```

Create `src/features/properties/property-service-contract.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("property inbound iCal connection state", () => {
  it("exposes only connection state and resets sync metadata when a replacement URL is saved", async () => {
    const source = await readFile(path.join(process.cwd(), "src/features/properties/property-service.ts"), "utf8");

    expect(source).toMatch(/inbound_ical_url_encrypted is not null as inbound_ical_connected/i);
    expect(source).toMatch(/inboundIcalConnected: row\.inbound_ical_connected/i);
    expect(source).toMatch(/inbound_ical_url_encrypted = \$\{sealSecret\(input\.inboundIcalUrl, encryptionKey\)\}/i);
    expect(source).toMatch(/last_sync_at = null[\s\S]*last_sync_status = null[\s\S]*last_sync_error_code = null/i);
    expect(source).not.toMatch(/inbound_ical_url_encrypted as inboundIcal/i);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- src/features/properties/property-manager.test.tsx src/features/properties/property-service-contract.test.ts`

Expected: FAIL because `PropertySummary` has no connected state and the UI has no `iCal required` status.

- [ ] **Step 3: Expose the boolean connection state without exposing ciphertext**

In `PropertySummary`, add:

```ts
inboundIcalConnected: boolean;
```

Add `inbound_ical_connected: boolean` to the row type, select this expression, and map it:

```ts
l.inbound_ical_url_encrypted is not null as inbound_ical_connected
```

```ts
inboundIcalConnected: row.inbound_ical_connected,
```

In the listing update statement, store the new encrypted URL and reset only the connection's sync status:

```ts
await tx`
  update public.listings set display_name = ${input.displayName},
    inbound_ical_url_encrypted = ${sealSecret(input.inboundIcalUrl, encryptionKey)},
    last_sync_at = null, last_sync_status = null, last_sync_error_code = null,
    updated_at = now()
  where id = ${input.listingId} and property_id = ${input.propertyId}
`;
```

- [ ] **Step 4: Render a deterministic disconnected status**

Inside the property map in `property-manager.tsx`, compute:

```tsx
const statusLabel = !property.inboundIcalConnected
  ? "iCal required"
  : property.lastSyncStatus === "failure" ? "Sync error" : "Active";
const statusClass = !property.inboundIcalConnected || property.lastSyncStatus === "failure"
  ? "status--impossible"
  : "status--safe";
```

Render it with:

```tsx
<span className={`status ${statusClass}`}>{statusLabel}</span>
```

Keep the edit form's private Airbnb iCal URL required so a disconnected listing cannot be marked connected without an actual validated URL.

- [ ] **Step 5: Run the focused tests**

Run: `npm test -- src/features/properties/property-manager.test.tsx src/features/properties/property-service-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the property reconnect flow**

```bash
git add src/features/properties/property-service.ts src/features/properties/property-manager.tsx src/features/properties/property-manager.test.tsx src/features/properties/property-service-contract.test.ts
git commit -m "feat: surface iCal reconnection state"
```

### Task 3: Prevent sync from touching disconnected listings

**Files:**
- Modify: `src/features/sync/sync-service.ts`
- Modify: `src/features/sync/sync-service-contract.test.ts`

- [ ] **Step 1: Add the failing sync selection contract**

Append to `sync-service-contract.test.ts`:

```ts
it("excludes disconnected listings from both manual and scheduled sync", async () => {
  const source = await readFile(path.join(process.cwd(), "src/features/sync/sync-service.ts"), "utf8");
  const connectedFilters = source.match(/inbound_ical_url_encrypted is not null/gi) ?? [];

  expect(connectedFilters).toHaveLength(2);
  expect(source).toMatch(/where l\.active and l\.archived_at is null[\s\S]*l\.inbound_ical_url_encrypted is not null/i);
  expect(source).toMatch(/where active and archived_at is null[\s\S]*inbound_ical_url_encrypted is not null/i);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- src/features/sync/sync-service-contract.test.ts`

Expected: FAIL because both queries currently include every active listing.

- [ ] **Step 3: Filter both listing queries at the database boundary**

Change the manual query predicate to:

```sql
where l.active and l.archived_at is null
  and l.inbound_ical_url_encrypted is not null
```

Change the scheduled query predicate to:

```sql
where active and archived_at is null
  and inbound_ical_url_encrypted is not null
```

Keep `SyncListing.encrypted_url` as `string`; disconnected rows never cross this boundary.

- [ ] **Step 4: Run sync and property tests**

Run: `npm test -- src/features/sync/sync-service-contract.test.ts src/features/properties/property-manager.test.tsx src/features/properties/property-service-contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the sync guard**

```bash
git add src/features/sync/sync-service.ts src/features/sync/sync-service-contract.test.ts
git commit -m "fix: skip disconnected iCal listings during sync"
```

### Task 4: Add explicit keyless/manual CLI configuration

**Files:**
- Modify: `scripts/admin-data-consolidation/contract.mjs`
- Modify: `scripts/admin-data-consolidation/contract.test.mjs`

- [ ] **Step 1: Replace the contract tests with mode-complete expectations**

Keep the fingerprint test and change the CLI/config tests to:

```js
test("the CLI defaults to key-based dry-run and requires an explicit manual-iCal flag", () => {
  assert.deepEqual(parseMigrationArgs([]), {
    apply: false,
    envFile: ".env.migration.local",
    manualIcalReattach: false,
  });
  assert.deepEqual(parseMigrationArgs(["--manual-ical-reattach"]), {
    apply: false,
    envFile: ".env.migration.local",
    manualIcalReattach: true,
  });
  assert.throws(() => parseMigrationArgs(["--apply", "wrong"]), /INVALID_APPLY_CONFIRMATION/);
  assert.deepEqual(parseMigrationArgs([
    "--manual-ical-reattach", "--env", "local.env", "--apply", APPLY_CONFIRMATION,
  ]), { apply: true, envFile: "local.env", manualIcalReattach: true });
});

test("key-based mode requires both keys while manual mode forbids depending on them", () => {
  assert.doesNotThrow(() => validateMigrationConfig(config, { manualIcalReattach: false }));
  assert.throws(
    () => validateMigrationConfig({ ...config, OLD_ICAL_ENCRYPTION_KEY: "" }, { manualIcalReattach: false }),
    /MISSING_MIGRATION_CONFIG:OLD_ICAL_ENCRYPTION_KEY/,
  );
  const manual = {
    OLD_DATABASE_URL: config.OLD_DATABASE_URL,
    NEW_DATABASE_URL: config.NEW_DATABASE_URL,
    MIGRATION_BACKUP_PASSPHRASE: config.MIGRATION_BACKUP_PASSPHRASE,
    MIGRATION_ACTOR_EMAIL: "admin@example.test",
  };
  assert.doesNotThrow(() => validateMigrationConfig(manual, { manualIcalReattach: true }));
  assert.throws(
    () => validateMigrationConfig({ ...manual, NEW_DATABASE_URL: manual.OLD_DATABASE_URL }, { manualIcalReattach: true }),
    /DATABASE_URLS_MUST_DIFFER/,
  );
});
```

- [ ] **Step 2: Run the Node contract test and verify it fails**

Run: `node --test scripts/admin-data-consolidation/contract.test.mjs`

Expected: FAIL because the parser does not recognize `--manual-ical-reattach`.

- [ ] **Step 3: Implement mode-aware parsing and validation**

Use these required sets:

```js
const COMMON_REQUIRED_CONFIG = [
  "OLD_DATABASE_URL",
  "NEW_DATABASE_URL",
  "MIGRATION_BACKUP_PASSPHRASE",
  "MIGRATION_ACTOR_EMAIL",
];
const KEY_MODE_REQUIRED_CONFIG = [
  "OLD_ICAL_ENCRYPTION_KEY",
  "NEW_ICAL_ENCRYPTION_KEY",
];
```

Initialize and parse the flag:

```js
let manualIcalReattach = false;
```

```js
} else if (argument === "--manual-ical-reattach") {
  manualIcalReattach = true;
```

Return:

```js
return { apply, envFile, manualIcalReattach };
```

Change validation to:

```js
export function validateMigrationConfig(config, { manualIcalReattach = false } = {}) {
  const required = manualIcalReattach
    ? COMMON_REQUIRED_CONFIG
    : [...COMMON_REQUIRED_CONFIG, ...KEY_MODE_REQUIRED_CONFIG];
  const missing = required.filter((name) => !config[name]?.trim());
  if (missing.length) throw new Error(`MISSING_MIGRATION_CONFIG:${missing.join(",")}`);
  if (config.OLD_DATABASE_URL === config.NEW_DATABASE_URL) throw new Error("DATABASE_URLS_MUST_DIFFER");
  if (!manualIcalReattach && (
    decodedKeyLength(config.OLD_ICAL_ENCRYPTION_KEY) !== 32
    || decodedKeyLength(config.NEW_ICAL_ENCRYPTION_KEY) !== 32
  )) throw new Error("INVALID_ICAL_ENCRYPTION_KEY");
  if (config.MIGRATION_BACKUP_PASSPHRASE.length < 16) {
    throw new Error("MIGRATION_BACKUP_PASSPHRASE_TOO_SHORT");
  }
  return config;
}
```

- [ ] **Step 4: Run all migration-script unit tests**

Run: `node --test scripts/admin-data-consolidation/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the CLI contract**

```bash
git add scripts/admin-data-consolidation/contract.mjs scripts/admin-data-consolidation/contract.test.mjs
git commit -m "feat: add manual iCal migration mode"
```

### Task 5: Build a ciphertext-free manual consolidation plan

**Files:**
- Modify: `scripts/admin-data-consolidation/planner.mjs`
- Modify: `scripts/admin-data-consolidation/planner.test.mjs`

- [ ] **Step 1: Add failing planner tests for the manual mode**

Add:

```js
test("manual iCal mode preserves calendar history but clears every inbound secret and sync state", () => {
  const input = fixture();
  input.source.external_calendar_events.push({
    id: "historical-event",
    listing_id: "old-listing",
    event_type: "reservation",
    start_date: "2026-01-10",
    end_date: "2026-01-12",
    active: false,
    historical: true,
    archived_at: "2026-01-12T00:00:00.000Z",
  });
  input.source.listings[0].inbound_ical_url_encrypted = "source-secret";
  input.source.listings[0].last_sync_at = "2026-07-01T00:00:00.000Z";
  input.source.listings[0].last_sync_status = "success";

  const plan = buildConsolidationPlan({ ...input, manualIcalReattach: true });

  assert.equal(plan.listings[0].inbound_ical_url_encrypted, null);
  assert.equal(plan.listings[0].last_sync_at, null);
  assert.equal(plan.listings[0].last_sync_status, null);
  assert.equal(plan.externalCalendarEvents[0].id, "historical-event");
  assert.equal(plan.externalCalendarEvents[0].historical, true);
  assert.equal(plan.counts.disconnectedListings, 1);
  assert.doesNotMatch(JSON.stringify(plan), /source-secret/);
});

test("manual iCal mode matches listings by normalized name without plaintext feed comparison", () => {
  const input = fixture();
  delete input.source.listings[0].inbound_ical_url_plaintext;
  delete input.destination.listings[0].inbound_ical_url_plaintext;
  assert.doesNotThrow(() => buildConsolidationPlan({ ...input, manualIcalReattach: true }));
});
```

- [ ] **Step 2: Run the planner test and verify it fails**

Run: `node --test scripts/admin-data-consolidation/planner.test.mjs`

Expected: FAIL because `manualIcalReattach` is ignored and the ciphertext remains.

- [ ] **Step 3: Add mode-aware listing planning**

Change the signature to:

```js
export function buildConsolidationPlan({
  source,
  destination,
  fallbackActorId,
  manualIcalReattach = false,
}) {
```

Guard plaintext conflict comparison with `!manualIcalReattach`:

```js
if (!manualIcalReattach && match && sourceListing.inbound_ical_url_plaintext
  && match.inbound_ical_url_plaintext
  && sourceListing.inbound_ical_url_plaintext !== match.inbound_ical_url_plaintext) {
  throw new Error(`LISTING_IDENTITY_CONFLICT:${targetPropertyId}:${nameIdentity}`);
}
```

Build each listing with a disconnected state only in manual mode:

```js
const plannedListing = {
  ...sourceListing,
  id: targetId,
  property_id: targetPropertyId,
  ...(manualIcalReattach ? {
    inbound_ical_url_encrypted: null,
    last_sync_at: null,
    last_sync_status: null,
    last_sync_error_code: null,
  } : {}),
};
listings.push(withoutPlannerFields(plannedListing));
```

Add the count:

```js
disconnectedListings: listings.filter((listing) => listing.inbound_ical_url_encrypted === null).length,
```

- [ ] **Step 4: Run all planner and secret tests**

Run: `node --test scripts/admin-data-consolidation/planner.test.mjs scripts/admin-data-consolidation/ical-secrets.test.mjs`

Expected: PASS, including the existing key-based re-encryption test.

- [ ] **Step 5: Commit the planner mode**

```bash
git add scripts/admin-data-consolidation/planner.mjs scripts/admin-data-consolidation/planner.test.mjs
git commit -m "feat: plan ciphertext-free calendar imports"
```

### Task 6: Orchestrate and verify the manual apply path

**Files:**
- Modify: `scripts/admin-data-consolidation/database.mjs`
- Modify: `scripts/admin-data-consolidation/apply.mjs`
- Modify: `scripts/consolidate-admin-data.mjs`
- Modify: `scripts/admin-data-consolidation/contract.test.mjs`

- [ ] **Step 1: Add failing source contracts for nullable-schema and postcondition checks**

Append to `contract.test.mjs`:

```js
import { readFile } from "node:fs/promises";

test("manual orchestration never decrypts listing ciphertext and verifies disconnected rows", async () => {
  const [runner, database, apply] = await Promise.all([
    readFile(new URL("../consolidate-admin-data.mjs", import.meta.url), "utf8"),
    readFile(new URL("./database.mjs", import.meta.url), "utf8"),
    readFile(new URL("./apply.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(runner, /manualIcalReattach \? sourceRaw : prepareListings/);
  assert.match(runner, /manualIcalReattach \? destinationRaw : inspectDestinationListings/);
  assert.match(database, /is_nullable[\s\S]*MANUAL_ICAL_DESTINATION_SCHEMA_REQUIRED/i);
  assert.match(apply, /POSTCONDITION_CONNECTED_ICAL_IN_MANUAL_MODE/i);
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `node --test scripts/admin-data-consolidation/contract.test.mjs`

Expected: FAIL because the manual orchestration branches do not exist.

- [ ] **Step 3: Add the destination schema assertion**

In `database.mjs`, add:

```js
export async function assertManualIcalDestinationSchema(sql) {
  const [column] = await sql`
    select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'listings'
      and column_name = 'inbound_ical_url_encrypted'
  `;
  if (column?.is_nullable !== "YES") {
    throw new Error("MANUAL_ICAL_DESTINATION_SCHEMA_REQUIRED");
  }
}
```

- [ ] **Step 4: Make apply postconditions mode-aware**

Change `applyConsolidation` to accept an options object:

```js
export async function applyConsolidation(sql, plan, destinationSnapshot, { manualIcalReattach = false } = {}) {
```

After count checks, add:

```js
if (manualIcalReattach) {
  const [connected] = await tx`
    select id from public.listings
    where inbound_ical_url_encrypted is not null limit 1
  `;
  if (connected) throw new Error("POSTCONDITION_CONNECTED_ICAL_IN_MANUAL_MODE");
}
```

- [ ] **Step 5: Select preparation mode in the runner**

Parse and validate with the mode:

```js
const { apply, envFile, manualIcalReattach } = parseMigrationArgs(process.argv.slice(2));
```

```js
const config = validateMigrationConfig({
  ...process.env,
  ...parseEnvFile(await readFile(envPath, "utf8")),
}, { manualIcalReattach });
```

After export/fingerprint validation, call:

```js
if (manualIcalReattach) await assertManualIcalDestinationSchema(destinationSql);
const source = manualIcalReattach
  ? sourceRaw
  : prepareListings(sourceRaw, config.OLD_ICAL_ENCRYPTION_KEY, config.NEW_ICAL_ENCRYPTION_KEY);
const destination = manualIcalReattach
  ? destinationRaw
  : inspectDestinationListings(destinationRaw, config.NEW_ICAL_ENCRYPTION_KEY);
```

Build and report the mode:

```js
const plan = buildConsolidationPlan({
  source,
  destination,
  fallbackActorId: actor.id,
  manualIcalReattach,
});
```

```js
icalMode: manualIcalReattach ? "manual-reattach" : "re-encrypt",
disconnectedListings: plan.counts.disconnectedListings,
```

Apply and verify with:

```js
const result = await applyConsolidation(destinationSql, plan, destinationRaw, { manualIcalReattach });
if (!manualIcalReattach) {
  for (const listing of await destinationSql`select inbound_ical_url_encrypted from public.listings`) {
    openIcalUrl(listing.inbound_ical_url_encrypted, config.NEW_ICAL_ENCRYPTION_KEY);
  }
}
```

- [ ] **Step 6: Run every migration-script unit test**

Run: `node --test scripts/admin-data-consolidation/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Commit the orchestration path**

```bash
git add scripts/admin-data-consolidation/database.mjs scripts/admin-data-consolidation/apply.mjs scripts/consolidate-admin-data.mjs scripts/admin-data-consolidation/contract.test.mjs
git commit -m "feat: execute manual iCal consolidation safely"
```

### Task 7: Document the exact operator workflow

**Files:**
- Modify: `.env.migration.example`
- Modify: `docs/admin-data-consolidation-runbook.md`
- Modify: `DEPLOYMENT.md`

- [ ] **Step 1: Update the ignored configuration template comments**

Keep all variables but annotate them without secrets:

```dotenv
# Copy to .env.migration.local. Never commit the populated file.
OLD_DATABASE_URL=postgresql://USER:PASSWORD@OLD_HOST:5432/postgres
NEW_DATABASE_URL=postgresql://USER:PASSWORD@NEW_HOST:5432/postgres
# Required only for the default re-encrypt mode; ignored by --manual-ical-reattach.
OLD_ICAL_ENCRYPTION_KEY=BASE64_32_BYTE_KEY
NEW_ICAL_ENCRYPTION_KEY=BASE64_32_BYTE_KEY
MIGRATION_BACKUP_PASSPHRASE=USE_A_LONG_UNIQUE_LOCAL_PASSPHRASE
MIGRATION_ACTOR_EMAIL=admin@noirhaus.in
```

- [ ] **Step 2: Add the manual runbook commands and gates**

Document these exact commands in `docs/admin-data-consolidation-runbook.md`:

```bash
npm run data:consolidate -- --env .env.migration.local --manual-ical-reattach
```

```bash
npm run data:consolidate -- --env .env.migration.local --manual-ical-reattach \
  --apply "REPLACE NEW OPERATIONS WITH OLD ADMIN DATA"
```

The runbook must state that `0009_optional_inbound_ical.sql` is applied before the admin deployment, public booking is paused before apply, active holds are drained, source/destination backups are retained, every property is reconnected and successfully synced, historical counts are checked, and public booking resumes only after acceptance.

- [ ] **Step 3: Add migration `0009` to deployment order**

In `DEPLOYMENT.md`, append `0009_optional_inbound_ical.sql` after `0008`, and explain that a null inbound feed is an intentional disconnected state that scheduled/manual sync skips until the admin saves a valid Airbnb URL.

- [ ] **Step 4: Run documentation and configuration safety checks**

Run:

```bash
git diff --check
git grep -nE 'postgresql://postgres\.[a-z]+:[^[]|rzp_(test|live)_[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{40,}' -- . ':!package-lock.json'
```

Expected: `git diff --check` exits 0; the secret scan prints no migration credentials or provider secrets.

- [ ] **Step 5: Commit the operator documentation**

```bash
git add .env.migration.example docs/admin-data-consolidation-runbook.md DEPLOYMENT.md
git commit -m "docs: add manual iCal consolidation runbook"
```

### Task 8: Complete code verification and review

**Files:**
- Verify all modified files from Tasks 1-7.

- [ ] **Step 1: Run migration-script tests**

Run: `node --test scripts/admin-data-consolidation/*.test.mjs`

Expected: all Node tests PASS.

- [ ] **Step 2: Run the full application test suite**

Run: `npm test`

Expected: all 62-or-more test files PASS with 203-or-more tests.

- [ ] **Step 3: Run lint and type checking**

Run: `npm run lint`

Expected: exit 0.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 4: Run a production build**

Run: `npm run build`

Expected: Next.js production build succeeds. If the prebuild requires production database access, run the build only after the destination `DATABASE_URL` is safely available in the ignored local environment; never print it.

- [ ] **Step 5: Review the branch diff**

Run:

```bash
git status --short
git diff b8cd79d...HEAD --stat
git log --oneline b8cd79d..HEAD
```

Expected: only the planned schema, property UI/service, sync guard, migration tool, tests and documentation changed; the worktree is clean.

### Task 9: Controlled production rollout and data consolidation

**Files:**
- Runtime configuration: ignored `.env.migration.local`
- Supabase migration: `supabase/migrations/0009_optional_inbound_ical.sql`
- Deployment: Vercel project `noirhausadmin-booking-preview`

- [ ] **Step 1: Complete migration credentials without revealing them**

In the original repository's ignored `.env.migration.local`, ensure the old and new Session Pooler URLs contain their actual database passwords. Replace the placeholder backup passphrase with a unique value of at least 16 characters and replace `MIGRATION_ACTOR_EMAIL` with an existing destination Supabase Auth email. Leave both iCal key fields unset or at non-secret placeholders; manual mode ignores them.

Run the length-only audit:

```bash
awk -F= '{ print $1 ":" length(substr($0,index($0,"=")+1)) }' .env.migration.local
```

Expected: both database URLs, passphrase and actor email have nonzero lengths; no values are printed.

- [ ] **Step 2: Back up both Supabase projects and apply migration `0009` to destination**

Create dashboard backups or record available restore points for both projects. Run only `0009_optional_inbound_ical.sql` in the new Supabase project's SQL Editor after confirming migrations `0001` through `0008` already exist.

Expected: `listings.inbound_ical_url_encrypted` reports `YES` for `is_nullable` in `information_schema.columns`.

- [ ] **Step 3: Merge and deploy the verified application before importing null feeds**

Merge the feature branch into `deploy-noirhaus-main`, push the same commit to `noirhaus/main`, and deploy the linked Vercel project to production.

Run: `/Users/retyush/.nvm/versions/node/v25.2.1/bin/vercel deploy --prod -y`

Expected: deployment is Ready and the production alias is `https://noirhausadmin-booking-preview.vercel.app`.

- [ ] **Step 4: Pause public booking and drain transient holds**

Set `PUBLIC_BOOKING_ENABLED=false` for the admin Production environment, redeploy, and verify availability returns the controlled disabled response. Wait until no destination booking remains in `processing`, `held` or `payment_pending` state; do not cancel a captured/confirmed booking.

- [ ] **Step 5: Copy the ignored migration configuration into the isolated worktree**

Use a local file copy without displaying it:

```bash
cp /Users/retyush/airbnb-operations-calendar/.env.migration.local \
  /Users/retyush/.config/superpowers/worktrees/airbnb-operations-calendar/manual-ical-data-consolidation/.env.migration.local
```

Expected: `git check-ignore .env.migration.local` exits 0 in the worktree.

- [ ] **Step 6: Run and inspect the dry run**

Run:

```bash
npm run data:consolidate -- --env .env.migration.local --manual-ical-reattach
```

Expected: mode is `dry-run`, `icalMode` is `manual-reattach`, source historical/operational counts are nonzero, preserved destination booking counts match Supabase, disconnected listing count equals imported listing count, encrypted backup paths are printed, and no destination row changes.

- [ ] **Step 7: Apply only after the dry run is conflict-free**

Run:

```bash
npm run data:consolidate -- --env .env.migration.local --manual-ical-reattach \
  --apply "REPLACE NEW OPERATIONS WITH OLD ADMIN DATA"
```

Expected: apply succeeds once, source counts remain unchanged, destination postconditions pass, all imported listings are disconnected, and the encrypted snapshots remain retained.

- [ ] **Step 8: Verify data before reconnecting feeds**

In the new admin, confirm properties, historical Airbnb events, manual blocks, cleaning tasks and overrides match the old admin. Confirm Bookings retains every website booking/payment/refund record and imported operational nights do not overlap active website bookings.

- [ ] **Step 9: Reattach and sync every Airbnb feed**

For each `iCal required` property, obtain a fresh private export URL from Airbnb, open Properties → Edit, paste the URL and save. Run manual sync and verify `Active` status, current Airbnb blocks, retained past history and no booking collision.

- [ ] **Step 10: Resume public booking and perform end-to-end acceptance**

Set `PUBLIC_BOOKING_ENABLED=true`, redeploy, then verify representative public availability, one test-mode booking/payment if test keys are active, confirmation email, admin booking display, date blocking and safe test-booking removal. Do not create a live charge solely for verification.

- [ ] **Step 11: Retain rollback assets and rotate exposed source credentials**

Keep the old Vercel project, old database and both encrypted snapshots until acceptance. After acceptance, rotate the old Supabase database password because it previously appeared in a tracked-file diff, and update or retire the old deployment deliberately. Remove ignored migration credential files only after the retained snapshots and rollback window are no longer required.
