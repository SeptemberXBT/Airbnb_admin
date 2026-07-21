import "server-only";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type AttemptSql = postgres.Sql;
type AttemptStatus = "processing" | "succeeded" | "definitive_failure" | "retryable_failure";
type AttemptRow = {
  request_hash: string;
  status: AttemptStatus;
  durable_step: string;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  terminal_http_status: number | null;
  terminal_response: unknown;
  replay_until: Date | string | null;
};

export type AttemptAcquisition =
  | { kind: "acquired"; leaseToken: string; durableStep: string; resumed: boolean }
  | { kind: "processing"; retryAfterSeconds: number }
  | { kind: "replay"; httpStatus: number; response: unknown }
  | { kind: "conflict" }
  | { kind: "expired" };

const asTime = (value: Date | string | null) => value ? new Date(value).getTime() : Number.NaN;

export function createAttemptService(sql: AttemptSql, options: { clock?: () => Date } = {}) {
  const clock = options.clock ?? (() => new Date());

  return {
    async acquire(idempotencyKey: string, requestHash: string): Promise<AttemptAcquisition> {
      const now = clock();
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + 60_000);
      return sql.begin(async (tx) => {
        const [inserted] = await tx<AttemptRow[]>`
          insert into public.booking_attempts (
            idempotency_key, request_hash, status, durable_step,
            lease_token, lease_expires_at, created_at, updated_at
          ) values (
            ${idempotencyKey}, ${requestHash}, 'processing', 'started',
            ${leaseToken}, ${leaseExpiresAt}, ${now}, ${now}
          )
          on conflict (idempotency_key) do nothing
          returning request_hash, status, durable_step, lease_token, lease_expires_at,
            terminal_http_status, terminal_response, replay_until
        `;
        if (inserted) {
          return { kind: "acquired", leaseToken, durableStep: inserted.durable_step, resumed: false };
        }

        const [existing] = await tx<AttemptRow[]>`
          select request_hash, status, durable_step, lease_token, lease_expires_at,
            terminal_http_status, terminal_response, replay_until
          from public.booking_attempts where idempotency_key = ${idempotencyKey}
        `;
        if (!existing) throw new Error("ATTEMPT_NOT_FOUND");
        if (existing.request_hash !== requestHash) return { kind: "conflict" };
        if (existing.status === "succeeded" || existing.status === "definitive_failure") {
          if (asTime(existing.replay_until) > now.getTime()
            && existing.terminal_http_status !== null
            && existing.terminal_response !== null) {
            return {
              kind: "replay",
              httpStatus: existing.terminal_http_status,
              response: existing.terminal_response,
            };
          }
          return { kind: "expired" };
        }

        const [takenOver] = await tx<AttemptRow[]>`
          update public.booking_attempts
          set status = 'processing', lease_token = ${leaseToken}, lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
          where idempotency_key = ${idempotencyKey}
            and status in ('processing', 'retryable_failure')
            and lease_expires_at <= ${now}
          returning request_hash, status, durable_step, lease_token, lease_expires_at,
            terminal_http_status, terminal_response, replay_until
        `;
        if (takenOver) {
          return { kind: "acquired", leaseToken, durableStep: takenOver.durable_step, resumed: true };
        }
        const remaining = Math.ceil((asTime(existing.lease_expires_at) - now.getTime()) / 1000);
        return { kind: "processing", retryAfterSeconds: Math.max(1, Math.min(60, remaining)) };
      });
    },

    async recordProgress(idempotencyKey: string, leaseToken: string, durableStep: string) {
      const now = clock();
      const [updated] = await sql<{ idempotency_key: string }[]>`
        update public.booking_attempts
        set durable_step = ${durableStep}, lease_expires_at = ${new Date(now.getTime() + 60_000)}, updated_at = ${now}
        where idempotency_key = ${idempotencyKey} and status = 'processing' and lease_token = ${leaseToken}
        returning idempotency_key
      `;
      if (!updated) throw new Error("ATTEMPT_LEASE_LOST");
    },

    async markRetryable(idempotencyKey: string, leaseToken: string) {
      const now = clock();
      const [updated] = await sql<{ idempotency_key: string }[]>`
        update public.booking_attempts
        set status = 'retryable_failure', lease_expires_at = ${now}, updated_at = ${now}
        where idempotency_key = ${idempotencyKey} and status = 'processing' and lease_token = ${leaseToken}
        returning idempotency_key
      `;
      if (!updated) throw new Error("ATTEMPT_LEASE_LOST");
    },

    async completeTerminal(
      idempotencyKey: string,
      leaseToken: string,
      result: { status: "succeeded" | "definitive_failure"; httpStatus: number; response: unknown },
    ) {
      const now = clock();
      const replayUntil = new Date(now.getTime() + 30 * 60_000);
      const [updated] = await sql<{ idempotency_key: string }[]>`
        update public.booking_attempts
        set status = ${result.status}, terminal_http_status = ${result.httpStatus},
          terminal_response = ${sql.json(result.response as postgres.JSONValue)}, replay_until = ${replayUntil},
          lease_token = null, lease_expires_at = null, updated_at = ${now}
        where idempotency_key = ${idempotencyKey} and status = 'processing' and lease_token = ${leaseToken}
        returning idempotency_key
      `;
      if (!updated) throw new Error("ATTEMPT_LEASE_LOST");
    },

    async pruneExpiredReplayBodies() {
      const removed = await sql<{ idempotency_key: string }[]>`
        update public.booking_attempts set terminal_response = null, updated_at = ${clock()}
        where status in ('succeeded', 'definitive_failure')
          and replay_until <= ${clock()} and terminal_response is not null
        returning idempotency_key
      `;
      return removed.length;
    },
  };
}
