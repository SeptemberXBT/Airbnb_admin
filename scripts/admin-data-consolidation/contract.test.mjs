import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLY_CONFIRMATION,
  assertDistinctFingerprints,
  parseMigrationArgs,
  validateMigrationConfig,
} from "./contract.mjs";

const config = {
  OLD_DATABASE_URL: "postgresql://old.example/source",
  NEW_DATABASE_URL: "postgresql://new.example/destination",
  OLD_ICAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  NEW_ICAL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
  MIGRATION_BACKUP_PASSPHRASE: "a-long-backup-passphrase",
  MIGRATION_ACTOR_EMAIL: "admin@example.test",
};

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

test("key-based mode requires both keys while manual mode does not depend on them", () => {
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

test("database fingerprints must differ even when URLs are different", () => {
  assert.doesNotThrow(() => assertDistinctFingerprints({ identity: "old" }, { identity: "new" }));
  assert.throws(() => assertDistinctFingerprints({ identity: "same" }, { identity: "same" }), /DATABASE_FINGERPRINTS_MUST_DIFFER/);
});
