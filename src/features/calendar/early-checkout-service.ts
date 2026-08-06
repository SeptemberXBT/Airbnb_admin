import "server-only";

import { formatInTimeZone } from "date-fns-tz";
import type postgres from "postgres";

import {
  createInventoryService,
  reconcilePropertyNights,
  releaseSourceNights,
} from "@/features/inventory/inventory-service";
import { getDb } from "@/lib/db/client";

type EarlyCheckoutSql = postgres.Sql;

export type EarlyCheckoutCode = "FORBIDDEN" | "NOT_FOUND" | "INELIGIBLE";

export class EarlyCheckoutError extends Error {
  constructor(
    public readonly code: EarlyCheckoutCode,
    public readonly status: 403 | 404 | 409,
  ) {
    super(code);
    this.name = "EarlyCheckoutError";
  }
}

export type EarlyCheckoutResult = {
  entryId: string;
  completedEarlyAt: string;
  earlyCheckoutEffectiveDate: string;
  idempotent: boolean;
};

type EarlyCheckoutDependencies = {
  now?: () => Date;
};

export function createEarlyCheckoutService(
  sql: EarlyCheckoutSql,
  dependencies: EarlyCheckoutDependencies = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const inventory = createInventoryService(sql);

  return {
    async completeEarly(entryId: string, userId: string): Promise<EarlyCheckoutResult> {
      const [lookup] = await sql<{ property_id: string; allowed: boolean }[]>`
        select e.property_id,
          exists (
            select 1 from public.property_members pm
            where pm.property_id = e.property_id and pm.user_id = ${userId}
          ) as allowed
        from public.local_calendar_entries e
        where e.id = ${entryId}
      `;
      if (!lookup) throw new EarlyCheckoutError("NOT_FOUND", 404);
      if (!lookup.allowed) throw new EarlyCheckoutError("FORBIDDEN", 403);

      return inventory.withPropertyInventory(lookup.property_id, async (tx) => {
        const [member] = await tx`
          select 1 from public.property_members
          where property_id = ${lookup.property_id} and user_id = ${userId}
        `;
        if (!member) throw new EarlyCheckoutError("FORBIDDEN", 403);

        const [entry] = await tx<{
          id: string;
          property_id: string;
          booking_id: string | null;
          entry_type: "direct_reservation" | "blocked";
          active: boolean;
          archived_at: string | null;
          start_date: string;
          end_date: string;
          completed_early_at: string | null;
          completed_early_by: string | null;
          early_checkout_effective_date: string | null;
        }[]>`
          select id, property_id, booking_id, entry_type, active, archived_at::text,
            start_date::text, end_date::text, completed_early_at::text,
            completed_early_by, early_checkout_effective_date::text
          from public.local_calendar_entries
          where id = ${entryId} and property_id = ${lookup.property_id}
          for update
        `;
        if (!entry) throw new EarlyCheckoutError("NOT_FOUND", 404);

        if (
          entry.completed_early_at &&
          entry.completed_early_by &&
          entry.early_checkout_effective_date
        ) {
          return {
            entryId: entry.id,
            completedEarlyAt: entry.completed_early_at,
            earlyCheckoutEffectiveDate: entry.early_checkout_effective_date,
            idempotent: true,
          };
        }

        const completedAt = now();
        if (Number.isNaN(completedAt.getTime())) throw new Error("INVALID_NOW");
        const effectiveDate = formatInTimeZone(completedAt, "Asia/Kolkata", "yyyy-MM-dd");
        const eligible =
          entry.booking_id === null &&
          entry.entry_type === "direct_reservation" &&
          entry.active &&
          entry.archived_at === null &&
          entry.start_date <= effectiveDate &&
          effectiveDate < entry.end_date;
        if (!eligible) throw new EarlyCheckoutError("INELIGIBLE", 409);

        const [updated] = await tx<{
          completed_early_at: string;
          early_checkout_effective_date: string;
        }[]>`
          update public.local_calendar_entries
          set active = false,
            completed_early_at = ${completedAt},
            completed_early_by = ${userId},
            early_checkout_effective_date = ${effectiveDate},
            updated_at = ${completedAt}
          where id = ${entry.id}
          returning completed_early_at::text, early_checkout_effective_date::text
        `;

        await releaseSourceNights(tx, "manual_local", entry.id, "completed_early");
        await reconcilePropertyNights(
          tx,
          entry.property_id,
          entry.start_date,
          entry.end_date,
        );
        await tx`
          insert into public.audit_log (
            property_id, actor_id, action, entity_type, entity_id, changes
          ) values (
            ${entry.property_id}, ${userId}, 'completed_early',
            'local_calendar_entry', ${entry.id},
            ${tx.json({
              originalStartDate: entry.start_date,
              originalEndDate: entry.end_date,
              earlyCheckoutEffectiveDate: updated.early_checkout_effective_date,
              completedEarlyAt: updated.completed_early_at,
            })}
          )
        `;

        return {
          entryId: entry.id,
          completedEarlyAt: updated.completed_early_at,
          earlyCheckoutEffectiveDate: updated.early_checkout_effective_date,
          idempotent: false,
        };
      });
    },
  };
}

export function completeEarlyCheckout(entryId: string, userId: string) {
  return createEarlyCheckoutService(getDb()).completeEarly(entryId, userId);
}
