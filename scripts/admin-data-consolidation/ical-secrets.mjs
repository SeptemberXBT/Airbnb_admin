import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function decodeKey(encodedKey) {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("INVALID_ICAL_ENCRYPTION_KEY");
  return key;
}

export function sealIcalUrl(value, encodedKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openIcalUrl(sealed, encodedKey) {
  const [version, iv, tag, ciphertext] = String(sealed).split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("INVALID_ENCRYPTED_ICAL_URL");
  const decipher = createDecipheriv("aes-256-gcm", decodeKey(encodedKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
