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
};

test("the CLI defaults to dry-run and requires the exact apply phrase", () => {
  assert.deepEqual(parseMigrationArgs([]), { apply: false, envFile: ".env.migration.local" });
  assert.throws(() => parseMigrationArgs(["--apply", "wrong"]), /INVALID_APPLY_CONFIRMATION/);
  assert.deepEqual(parseMigrationArgs(["--env", "local.env", "--apply", APPLY_CONFIRMATION]), {
    apply: true,
    envFile: "local.env",
  });
});

test("configuration requires distinct source and destination credentials and all keys", () => {
  assert.doesNotThrow(() => validateMigrationConfig(config));
  assert.throws(() => validateMigrationConfig({ ...config, NEW_DATABASE_URL: config.OLD_DATABASE_URL }), /DATABASE_URLS_MUST_DIFFER/);
  assert.throws(() => validateMigrationConfig({ ...config, OLD_ICAL_ENCRYPTION_KEY: "" }), /MISSING_MIGRATION_CONFIG/);
});

test("database fingerprints must differ even when URLs are different", () => {
  assert.doesNotThrow(() => assertDistinctFingerprints({ identity: "old" }, { identity: "new" }));
  assert.throws(() => assertDistinctFingerprints({ identity: "same" }, { identity: "same" }), /DATABASE_FINGERPRINTS_MUST_DIFFER/);
});
