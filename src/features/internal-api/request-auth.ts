import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { verifyInternalSignature } from "./hmac";

type AuthSql = postgres.Sql;

export class InternalRequestAuthError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "InternalRequestAuthError";
  }
}

type AuthenticatorOptions = {
  keys: Record<string, string>;
  clock?: () => Date;
  maxRequestsPerKey?: number;
};

function requiredHeader(request: Request, name: string) {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new InternalRequestAuthError("INVALID_SIGNATURE");
  return value;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

export function createInternalRequestAuthenticator(sql: AuthSql, options: AuthenticatorOptions) {
  const clock = options.clock ?? (() => new Date());
  const maxRequestsPerKey = options.maxRequestsPerKey ?? 600;
  if (!Number.isInteger(maxRequestsPerKey) || maxRequestsPerKey < 1) throw new Error("INVALID_KEY_REQUEST_CAP");

  return {
    async authenticate(request: Request) {
      const keyId = requiredHeader(request, "X-Noir-Key-Id");
      const timestamp = requiredHeader(request, "X-Noir-Timestamp");
      const nonce = requiredHeader(request, "X-Noir-Nonce");
      const signature = requiredHeader(request, "X-Noir-Signature");
      const secret = options.keys[keyId];
      if (!secret || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) {
        throw new InternalRequestAuthError("INVALID_SIGNATURE");
      }
      const rawBody = await request.text();
      const url = new URL(request.url);
      const now = clock();
      if (!verifyInternalSignature({
        method: request.method,
        pathAndQuery: `${url.pathname}${url.search}`,
        timestamp,
        nonce,
        rawBody,
      }, secret, signature, { now })) {
        throw new InternalRequestAuthError("INVALID_SIGNATURE");
      }

      try {
        await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${`internal-api:${keyId}`}, 0))`;
          await tx`
            insert into public.api_request_nonces (
              key_id, nonce, request_timestamp, expires_at, created_at
            ) values (
              ${keyId}, ${nonce}, ${new Date(Number(timestamp) * 1000)},
              ${new Date(now.getTime() + 10 * 60_000)}, ${now}
            )
          `;
          const [{ count }] = await tx<{ count: number }[]>`
            select count(*)::int as count from public.api_request_nonces
            where key_id = ${keyId} and expires_at > ${now}
          `;
          if (count > maxRequestsPerKey) throw new InternalRequestAuthError("KEY_RATE_LIMITED");
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new InternalRequestAuthError("NONCE_REPLAY");
        throw error;
      }
      return { keyId, rawBody };
    },
  };
}

export async function cleanupExpiredNonces(sql: AuthSql, now = new Date()) {
  const removed = await sql<{ nonce: string }[]>`
    delete from public.api_request_nonces where expires_at <= ${now} returning nonce
  `;
  return removed.length;
}

export function authenticateInternalRequest(request: Request) {
  const currentKeyId = process.env.BOOKING_API_KEY_ID;
  const currentSecret = process.env.BOOKING_API_HMAC_SECRET;
  if (!currentKeyId || !currentSecret) throw new Error("INTERNAL_API_AUTH_NOT_CONFIGURED");
  const keys: Record<string, string> = { [currentKeyId]: currentSecret };
  const previousKeyId = process.env.BOOKING_API_PREVIOUS_KEY_ID;
  const previousSecret = process.env.BOOKING_API_PREVIOUS_HMAC_SECRET;
  if (previousKeyId && previousSecret) keys[previousKeyId] = previousSecret;
  return createInternalRequestAuthenticator(getDb(), { keys }).authenticate(request);
}
