import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

function decodeKey(encodedKey: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(encodedKey, "base64url");
  } catch {
    throw new Error("INVALID_BOOKING_RESUME_ENCRYPTION_KEY");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error("INVALID_BOOKING_RESUME_ENCRYPTION_KEY");
  }
  return key;
}

export function createResumeTokenCipher(encodedKey: string) {
  const key = decodeKey(encodedKey);

  return {
    generate() {
      return randomBytes(32).toString("base64url");
    },

    hash(token: string) {
      return createHash("sha256").update(token, "utf8").digest("hex");
    },

    encrypt(token: string) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
        "base64url",
      );
    },

    decrypt(ciphertext: string) {
      try {
        const payload = Buffer.from(ciphertext, "base64url");
        if (payload.length <= IV_BYTES + AUTH_TAG_BYTES) {
          throw new Error("invalid payload");
        }
        const iv = payload.subarray(0, IV_BYTES);
        const tag = payload.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
        const encrypted = payload.subarray(IV_BYTES + AUTH_TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("INVALID_BOOKING_RESUME_TOKEN_CIPHERTEXT");
      }
    },
  };
}
