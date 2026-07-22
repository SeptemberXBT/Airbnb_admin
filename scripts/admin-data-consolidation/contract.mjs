export const APPLY_CONFIRMATION = "REPLACE NEW OPERATIONS WITH OLD ADMIN DATA";
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

export function parseMigrationArgs(args) {
  let envFile = ".env.migration.local";
  let apply = false;
  let manualIcalReattach = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--env") {
      envFile = args[index + 1];
      if (!envFile) throw new Error("MISSING_ENV_FILE_ARGUMENT");
      index += 1;
    } else if (argument === "--apply") {
      const confirmation = args[index + 1];
      if (confirmation !== APPLY_CONFIRMATION) throw new Error("INVALID_APPLY_CONFIRMATION");
      apply = true;
      index += 1;
    } else if (argument === "--manual-ical-reattach") {
      manualIcalReattach = true;
    } else {
      throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  return { apply, envFile, manualIcalReattach };
}

function decodedKeyLength(encodedKey) {
  try {
    return Buffer.from(encodedKey, "base64").length;
  } catch {
    return 0;
  }
}

export function validateMigrationConfig(config, { manualIcalReattach = false } = {}) {
  const required = manualIcalReattach
    ? COMMON_REQUIRED_CONFIG
    : [...COMMON_REQUIRED_CONFIG, ...KEY_MODE_REQUIRED_CONFIG];
  const missing = required.filter((name) => !config[name]?.trim());
  if (missing.length) throw new Error(`MISSING_MIGRATION_CONFIG:${missing.join(",")}`);
  if (config.OLD_DATABASE_URL === config.NEW_DATABASE_URL) throw new Error("DATABASE_URLS_MUST_DIFFER");
  if (!manualIcalReattach && (decodedKeyLength(config.OLD_ICAL_ENCRYPTION_KEY) !== 32
    || decodedKeyLength(config.NEW_ICAL_ENCRYPTION_KEY) !== 32)) {
    throw new Error("INVALID_ICAL_ENCRYPTION_KEY");
  }
  if (config.MIGRATION_BACKUP_PASSPHRASE.length < 16) {
    throw new Error("MIGRATION_BACKUP_PASSPHRASE_TOO_SHORT");
  }
  return config;
}

export function assertDistinctFingerprints(source, destination) {
  if (!source?.identity || !destination?.identity || source.identity === destination.identity) {
    throw new Error("DATABASE_FINGERPRINTS_MUST_DIFFER");
  }
}
