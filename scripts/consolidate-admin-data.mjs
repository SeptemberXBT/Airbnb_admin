#!/usr/bin/env node
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { applyConsolidation } from "./admin-data-consolidation/apply.mjs";
import {
  DESTINATION_TABLES,
  SOURCE_OPERATIONAL_TABLES,
  assertManualIcalDestinationSchema,
  exportDatabase,
  snapshotCounts,
} from "./admin-data-consolidation/database.mjs";
import {
  assertDistinctFingerprints,
  parseMigrationArgs,
  validateMigrationConfig,
} from "./admin-data-consolidation/contract.mjs";
import { openIcalUrl, sealIcalUrl } from "./admin-data-consolidation/ical-secrets.mjs";
import { buildConsolidationPlan } from "./admin-data-consolidation/planner.mjs";
import { writeEncryptedSnapshot } from "./admin-data-consolidation/snapshot.mjs";

function parseEnvFile(source) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) throw new Error("INVALID_MIGRATION_ENV_FILE");
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function databaseClient(url) {
  const local = /(?:localhost|127\.0\.0\.1)/u.test(url);
  return postgres(url, {
    max: 2,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 5,
    ssl: local ? false : "require",
    onnotice: () => undefined,
  });
}

function prepareListings(snapshot, sourceKey, destinationKey) {
  return {
    ...snapshot,
    listings: snapshot.listings.map((listing) => {
      const plaintext = openIcalUrl(listing.inbound_ical_url_encrypted, sourceKey);
      return {
        ...listing,
        inbound_ical_url_plaintext: plaintext,
        inbound_ical_url_encrypted: sealIcalUrl(plaintext, destinationKey),
      };
    }),
  };
}

function inspectDestinationListings(snapshot, destinationKey) {
  return {
    ...snapshot,
    listings: snapshot.listings.map((listing) => ({
      ...listing,
      inbound_ical_url_plaintext: openIcalUrl(listing.inbound_ical_url_encrypted, destinationKey),
    })),
  };
}

function migrationActor(destination, requestedEmail) {
  const normalizedRequested = requestedEmail?.trim().toLocaleLowerCase("en-US");
  const actor = normalizedRequested
    ? destination.users.find((user) => user.email?.trim().toLocaleLowerCase("en-US") === normalizedRequested)
    : destination.users[0];
  if (!actor) throw new Error("DESTINATION_ADMIN_USER_NOT_FOUND");
  return actor;
}

async function main() {
  const { apply, envFile, manualIcalReattach } = parseMigrationArgs(process.argv.slice(2));
  const envPath = path.resolve(process.cwd(), envFile);
  const config = validateMigrationConfig({
    ...process.env,
    ...parseEnvFile(await readFile(envPath, "utf8")),
  }, { manualIcalReattach });
  const sourceSql = databaseClient(config.OLD_DATABASE_URL);
  const destinationSql = databaseClient(config.NEW_DATABASE_URL);

  try {
    const [sourceRaw, destinationRaw] = await Promise.all([
      exportDatabase(sourceSql, config.OLD_DATABASE_URL, SOURCE_OPERATIONAL_TABLES, "SOURCE"),
      exportDatabase(destinationSql, config.NEW_DATABASE_URL, DESTINATION_TABLES, "DESTINATION"),
    ]);
    assertDistinctFingerprints(sourceRaw.fingerprint, destinationRaw.fingerprint);
    if (!sourceRaw.properties.length) throw new Error("SOURCE_HAS_NO_PROPERTIES");
    if (manualIcalReattach) await assertManualIcalDestinationSchema(destinationSql);

    const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "noirhaus-admin-consolidation-"));
    const [sourceBackup, destinationBackup] = await Promise.all([
      writeEncryptedSnapshot(backupDirectory, "source.snapshot.enc", sourceRaw, config.MIGRATION_BACKUP_PASSPHRASE),
      writeEncryptedSnapshot(backupDirectory, "destination.snapshot.enc", destinationRaw, config.MIGRATION_BACKUP_PASSPHRASE),
    ]);

    const source = manualIcalReattach ? sourceRaw : prepareListings(
      sourceRaw,
      config.OLD_ICAL_ENCRYPTION_KEY,
      config.NEW_ICAL_ENCRYPTION_KEY,
    );
    const destination = manualIcalReattach ? destinationRaw : inspectDestinationListings(
      destinationRaw,
      config.NEW_ICAL_ENCRYPTION_KEY,
    );
    const actor = migrationActor(destination, config.MIGRATION_ACTOR_EMAIL);
    const plan = buildConsolidationPlan({
      source,
      destination,
      fallbackActorId: actor.id,
      manualIcalReattach,
    });
    plan.fallbackActorId = actor.id;

    const report = {
      mode: apply ? "apply" : "dry-run",
      icalMode: manualIcalReattach ? "manual-reattach" : "re-encrypt",
      sourceFingerprint: sourceRaw.fingerprint.identity.slice(0, 12),
      destinationFingerprint: destinationRaw.fingerprint.identity.slice(0, 12),
      sourceCounts: snapshotCounts(sourceRaw, SOURCE_OPERATIONAL_TABLES),
      destinationCounts: snapshotCounts(destinationRaw, DESTINATION_TABLES),
      plannedCounts: plan.counts,
      propertyMatches: Object.keys(plan.propertyMap).length,
      listingMatches: Object.keys(plan.listingMap).length,
      disconnectedListings: plan.counts.disconnectedListings,
      backups: [sourceBackup, destinationBackup],
    };
    console.log(JSON.stringify(report, null, 2));

    if (!apply) {
      console.log("Dry run complete. No destination rows were changed.");
      return;
    }

    const result = await applyConsolidation(
      destinationSql,
      plan,
      destinationRaw,
      { manualIcalReattach },
    );
    if (!manualIcalReattach) {
      for (const listing of await destinationSql`select inbound_ical_url_encrypted from public.listings`) {
        openIcalUrl(listing.inbound_ical_url_encrypted, config.NEW_ICAL_ENCRYPTION_KEY);
      }
    }
    const sourceAfter = await exportDatabase(
      sourceSql,
      config.OLD_DATABASE_URL,
      SOURCE_OPERATIONAL_TABLES,
      "SOURCE",
    );
    const beforeCounts = snapshotCounts(sourceRaw, SOURCE_OPERATIONAL_TABLES);
    const afterCounts = snapshotCounts(sourceAfter, SOURCE_OPERATIONAL_TABLES);
    if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) throw new Error("SOURCE_CHANGED_DURING_MIGRATION");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.allSettled([sourceSql.end(), destinationSql.end()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "ADMIN_DATA_CONSOLIDATION_FAILED");
  process.exitCode = 1;
});
