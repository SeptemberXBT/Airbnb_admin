import { describe, expect, it } from "vitest";

describe("server-side secret handling", () => {
  it("encrypts feed URLs with authenticated encryption", async () => {
    const { sealSecret, openSecret } = await import("./secrets");
    const key = Buffer.alloc(32, 7).toString("base64");
    const value = "https://www.airbnb.co.in/calendar/ical/123.ics?s=private";
    const sealed = sealSecret(value, key);

    expect(sealed).not.toContain(value);
    expect(openSecret(sealed, key)).toBe(value);
  });

  it("hashes outbound tokens without retaining the public value", async () => {
    const { hashToken } = await import("./secrets");
    expect(hashToken("public-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken("public-token")).toBe(hashToken("public-token"));
  });
});
