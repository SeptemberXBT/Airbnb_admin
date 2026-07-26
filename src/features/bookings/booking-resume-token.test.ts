import { describe, expect, it } from "vitest";

import { createResumeTokenCipher } from "./booking-resume-token";

describe("booking resume token cipher", () => {
  it("generates opaque tokens and round-trips authenticated ciphertext", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const cipher = createResumeTokenCipher(key);
    const token = cipher.generate();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cipher.hash(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(cipher.decrypt(cipher.encrypt(token))).toBe(token);
  });

  it("rejects keys that are not exactly 32 bytes", () => {
    expect(() =>
      createResumeTokenCipher(Buffer.alloc(31).toString("base64url")),
    ).toThrow("INVALID_BOOKING_RESUME_ENCRYPTION_KEY");
  });

  it("collapses authentication failures to one safe error", () => {
    const first = createResumeTokenCipher(
      Buffer.alloc(32, 7).toString("base64url"),
    );
    const second = createResumeTokenCipher(
      Buffer.alloc(32, 8).toString("base64url"),
    );

    expect(() => second.decrypt(first.encrypt(first.generate()))).toThrow(
      "INVALID_BOOKING_RESUME_TOKEN_CIPHERTEXT",
    );
  });
});
