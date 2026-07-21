import { describe, expect, it } from "vitest";
import { canonicalRequest, signInternalRequest, verifyInternalSignature } from "./hmac";
import { INTERNAL_API_TEST_VECTOR as vector } from "./test-vectors";

const input = {
  method: vector.method,
  pathAndQuery: vector.pathAndQuery,
  timestamp: vector.timestamp,
  nonce: vector.nonce,
  rawBody: vector.rawBody,
};

describe("internal API HMAC", () => {
  it("matches the shared fixed canonical string and signature", () => {
    expect(canonicalRequest(input)).toBe(vector.canonical);
    expect(signInternalRequest(input, vector.secret)).toBe(vector.signature);
    expect(verifyInternalSignature(input, vector.secret, vector.signature, {
      now: new Date(Number(vector.timestamp) * 1000),
    })).toBe(true);
  });

  it.each([
    ["method", { method: "GET" }],
    ["path", { pathAndQuery: "/api/internal/v1/bookings?room=shade-of-love&guests=2" }],
    ["query", { pathAndQuery: "/api/internal/v1/availability?room=shade-of-love&guests=3" }],
    ["body", { rawBody: `${vector.rawBody} ` }],
  ])("rejects a changed %s", (_label, change) => {
    expect(verifyInternalSignature({ ...input, ...change }, vector.secret, vector.signature, {
      now: new Date(Number(vector.timestamp) * 1000),
    })).toBe(false);
  });

  it("rejects stale, future, malformed, and wrong-length signatures", () => {
    const signedAt = Number(vector.timestamp) * 1000;
    expect(verifyInternalSignature(input, vector.secret, vector.signature, { now: new Date(signedAt + 300_001) })).toBe(false);
    expect(verifyInternalSignature(input, vector.secret, vector.signature, { now: new Date(signedAt - 300_001) })).toBe(false);
    expect(verifyInternalSignature(input, vector.secret, "not-hex", { now: new Date(signedAt) })).toBe(false);
    expect(verifyInternalSignature(input, vector.secret, "00", { now: new Date(signedAt) })).toBe(false);
  });
});
