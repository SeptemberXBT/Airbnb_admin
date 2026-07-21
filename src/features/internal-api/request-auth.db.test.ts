import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { signInternalRequest } from "./hmac";
import {
  cleanupExpiredNonces,
  createInternalRequestAuthenticator,
} from "./request-auth";

const KEY_ID = "website-current";
const SECRET = "test-request-auth-secret";
const BODY = "{\"publicRoomSlug\":\"shade-of-love\"}";
const PATH = "/api/internal/v1/availability?guests=2";
const NOW = new Date("2026-07-21T10:00:00.000Z");

function signedRequest(
  nonce: string,
  timestamp = String(Math.floor(NOW.getTime() / 1000)),
  path = PATH,
  body = BODY,
) {
  const signatureInput = { method: "POST", pathAndQuery: path, timestamp, nonce, rawBody: body };
  return new Request(`https://admin.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Noir-Key-Id": KEY_ID,
      "X-Noir-Timestamp": timestamp,
      "X-Noir-Nonce": nonce,
      "X-Noir-Signature": signInternalRequest(signatureInput, SECRET),
    },
    body,
  });
}

describe("internal request authentication", () => {
  beforeEach(resetDb);

  it("returns the exact raw body after accepting one signed nonce", async () => {
    const auth = createInternalRequestAuthenticator(testSql, {
      keys: { [KEY_ID]: SECRET }, clock: () => NOW, maxRequestsPerKey: 100,
    });
    const result = await auth.authenticate(signedRequest("10000000-0000-4000-8000-000000000001"));
    expect(result).toEqual({ keyId: KEY_ID, rawBody: BODY });
  });

  it("atomically rejects a replayed nonce", async () => {
    const auth = createInternalRequestAuthenticator(testSql, {
      keys: { [KEY_ID]: SECRET }, clock: () => NOW, maxRequestsPerKey: 100,
    });
    const nonce = "10000000-0000-4000-8000-000000000002";
    const results = await Promise.allSettled([
      auth.authenticate(signedRequest(nonce)),
      auth.authenticate(signedRequest(nonce)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
      reason: expect.objectContaining({ code: "NONCE_REPLAY" }),
    });
  });

  it("rejects timestamps outside the five-minute window before storing a nonce", async () => {
    const auth = createInternalRequestAuthenticator(testSql, {
      keys: { [KEY_ID]: SECRET }, clock: () => NOW, maxRequestsPerKey: 100,
    });
    const staleTimestamp = String(Math.floor((NOW.getTime() - 300_001) / 1000));
    await expect(auth.authenticate(signedRequest(
      "10000000-0000-4000-8000-000000000003",
      staleTimestamp,
    ))).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    const [{ count }] = await testSql<{ count: number }[]>`select count(*)::int as count from public.api_request_nonces`;
    expect(count).toBe(0);
  });

  it("enforces a per-key cap inside the nonce transaction", async () => {
    const auth = createInternalRequestAuthenticator(testSql, {
      keys: { [KEY_ID]: SECRET }, clock: () => NOW, maxRequestsPerKey: 1,
    });
    await auth.authenticate(signedRequest("10000000-0000-4000-8000-000000000004"));
    await expect(auth.authenticate(signedRequest(
      "10000000-0000-4000-8000-000000000005",
    ))).rejects.toMatchObject({ code: "KEY_RATE_LIMITED" });
  });

  it("uses independent endpoint buckets so availability traffic cannot block booking creation", async () => {
    const auth = createInternalRequestAuthenticator(testSql, {
      keys: { [KEY_ID]: SECRET }, clock: () => NOW, maxRequestsPerKey: 1,
    });
    await auth.authenticate(signedRequest("10000000-0000-4000-8000-000000000020"));
    await expect(auth.authenticate(signedRequest(
      "10000000-0000-4000-8000-000000000021",
      undefined,
      "/api/internal/v1/bookings",
    ))).resolves.toMatchObject({ keyId: KEY_ID });
  });

  it("rejects oversized bodies before signature verification or nonce storage", async () => {
    const auth = createInternalRequestAuthenticator(testSql, {
      keys: { [KEY_ID]: SECRET }, clock: () => NOW, maximumBodyBytes: 64,
    });
    await expect(auth.authenticate(signedRequest(
      "10000000-0000-4000-8000-000000000022",
      undefined,
      PATH,
      "x".repeat(65),
    ))).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    const [{ count }] = await testSql<{ count: number }[]>`select count(*)::int as count from public.api_request_nonces`;
    expect(count).toBe(0);
  });

  it("cleans nonce tombstones only after the ten-minute retention", async () => {
    await testSql`
      insert into public.api_request_nonces (key_id, endpoint_bucket, nonce, request_timestamp, expires_at, created_at)
      values
        (${KEY_ID}, 'availability', '10000000-0000-4000-8000-000000000006', ${new Date(NOW.getTime() - 600_002)}, ${new Date(NOW.getTime() - 1)}, ${new Date(NOW.getTime() - 600_001)}),
        (${KEY_ID}, 'availability', '10000000-0000-4000-8000-000000000007', ${NOW}, ${new Date(NOW.getTime() + 1)}, ${NOW})
    `;
    expect(await cleanupExpiredNonces(testSql, NOW)).toBe(1);
    const nonces = await testSql<{ nonce: string }[]>`select nonce::text from public.api_request_nonces order by nonce`;
    expect(nonces).toEqual([{ nonce: "10000000-0000-4000-8000-000000000007" }]);
  });
});
