import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "noirhaus-admin-snapshot-v1";

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length < 16) {
    throw new Error("SNAPSHOT_PASSPHRASE_TOO_SHORT");
  }
  return scryptSync(passphrase, salt, 32);
}

export function encryptSnapshot(payload, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(VERSION));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: VERSION,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

export function decryptSnapshot(encrypted, passphrase) {
  const envelope = JSON.parse(encrypted);
  if (envelope.version !== VERSION) throw new Error("UNSUPPORTED_SNAPSHOT_VERSION");
  const salt = Buffer.from(envelope.salt, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(passphrase, salt),
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(VERSION));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export async function writeEncryptedSnapshot(directory, filename, payload, passphrase) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const filePath = path.join(directory, filename);
  await writeFile(filePath, encryptSnapshot(payload, passphrase), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}
