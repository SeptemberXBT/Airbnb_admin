import "server-only";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { buildQuote, enumerateStayDates } from "./quote";
import {
  baseRateInputSchema,
  clearDateOverrideInputSchema,
  createQuoteRequestSchema,
  dateOverrideInputSchema,
  quoteRequestSchema,
  type BaseRateInput,
  type ClearDateOverrideInput,
  type DateOverrideInput,
  type QuoteRequest,
} from "./pricing-schema";

type PricingSql = postgres.Sql;

export type RateOverrideSummary = {
  stayDate: string;
  pricePaise: number;
};

export type PricingSummary = {
  propertyId: string;
  propertyName: string;
  active: boolean;
  publicRoomSlug: string | null;
  maxGuests: number | null;
  weekdayPricePaise: number | null;
  weekendPricePaise: number | null;
  bookingEnabled: boolean;
  overrides: RateOverrideSummary[];
};

async function requireMembership(sql: postgres.TransactionSql, propertyId: string, userId: string) {
  const [membership] = await sql`
    select 1 from public.property_members
    where property_id = ${propertyId} and user_id = ${userId}
  `;
  if (!membership) throw new Error("FORBIDDEN");
}

export function createPricingService(sql: PricingSql) {
  return {
    async getQuoteForSlug(input: QuoteRequest) {
      const request = quoteRequestSchema.parse(input);
      const [rate] = await sql<{
        property_id: string;
        max_guests: number;
        weekday_price_paise: number;
        weekend_price_paise: number;
      }[]>`
        select r.property_id, r.max_guests, r.weekday_price_paise, r.weekend_price_paise
        from public.property_rates r
        join public.properties p on p.id = r.property_id
        where r.public_room_slug = ${request.publicRoomSlug}
          and r.booking_enabled = true
          and p.active = true
          and p.archived_at is null
      `;
      if (!rate) throw new Error("NOT_BOOKABLE");
      if (!createQuoteRequestSchema(rate.max_guests).safeParse(request).success) {
        throw new Error("CAPACITY_EXCEEDED");
      }

      const dates = enumerateStayDates(request.checkin, request.checkout);
      const overrideRows = await sql<{ stay_date: string; price_paise: number }[]>`
        select stay_date::text, price_paise
        from public.property_rate_overrides
        where property_id = ${rate.property_id} and stay_date in ${sql(dates)}
      `;
      const quote = buildQuote(
        dates,
        {
          weekdayPricePaise: rate.weekday_price_paise,
          weekendPricePaise: rate.weekend_price_paise,
        },
        new Map(overrideRows.map((override) => [override.stay_date, override.price_paise])),
      );
      return {
        propertyId: rate.property_id,
        publicRoomSlug: request.publicRoomSlug,
        maxGuests: rate.max_guests,
        checkin: request.checkin,
        checkout: request.checkout,
        guests: request.guests,
        ...quote,
      };
    },

    async listPricingForUser(userId: string): Promise<PricingSummary[]> {
      const rows = await sql<{
        property_id: string;
        property_name: string;
        active: boolean;
        public_room_slug: string | null;
        max_guests: number | null;
        weekday_price_paise: number | null;
        weekend_price_paise: number | null;
        booking_enabled: boolean | null;
      }[]>`
        select p.id as property_id, p.name as property_name, p.active,
          r.public_room_slug, r.max_guests, r.weekday_price_paise,
          r.weekend_price_paise, r.booking_enabled
        from public.properties p
        join public.property_members pm on pm.property_id = p.id and pm.user_id = ${userId}
        left join public.property_rates r on r.property_id = p.id
        where p.archived_at is null
        order by p.name
      `;
      if (rows.length === 0) return [];
      const propertyIds = rows.map((row) => row.property_id);
      const overrides = await sql<{ property_id: string; stay_date: string; price_paise: number }[]>`
        select property_id, stay_date::text, price_paise
        from public.property_rate_overrides
        where property_id in ${sql(propertyIds)}
          and stay_date >= current_date - 1
          and stay_date < current_date + 366
        order by stay_date
      `;
      const overridesByProperty = new Map<string, RateOverrideSummary[]>();
      for (const override of overrides) {
        const values = overridesByProperty.get(override.property_id) ?? [];
        values.push({ stayDate: override.stay_date, pricePaise: override.price_paise });
        overridesByProperty.set(override.property_id, values);
      }
      return rows.map((row) => ({
        propertyId: row.property_id,
        propertyName: row.property_name,
        active: row.active,
        publicRoomSlug: row.public_room_slug,
        maxGuests: row.max_guests,
        weekdayPricePaise: row.weekday_price_paise,
        weekendPricePaise: row.weekend_price_paise,
        bookingEnabled: row.booking_enabled ?? false,
        overrides: overridesByProperty.get(row.property_id) ?? [],
      }));
    },

    async saveBaseRates(input: BaseRateInput, userId: string) {
      const rate = baseRateInputSchema.parse(input);
      await sql.begin(async (tx) => {
        await requireMembership(tx, rate.propertyId, userId);
        await tx`
          insert into public.property_rates (
            property_id, public_room_slug, max_guests, weekday_price_paise,
            weekend_price_paise, booking_enabled, updated_by
          ) values (
            ${rate.propertyId}, ${rate.publicRoomSlug}, ${rate.maxGuests},
            ${rate.weekdayPricePaise}, ${rate.weekendPricePaise},
            ${rate.bookingEnabled}, ${userId}
          )
          on conflict (property_id) do update set
            public_room_slug = excluded.public_room_slug,
            max_guests = excluded.max_guests,
            weekday_price_paise = excluded.weekday_price_paise,
            weekend_price_paise = excluded.weekend_price_paise,
            booking_enabled = excluded.booking_enabled,
            updated_by = excluded.updated_by,
            updated_at = now()
        `;
        await tx`
          insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
          values (
            ${rate.propertyId}, ${userId}, 'pricing_base_saved', 'property_rate',
            ${rate.propertyId},
            ${tx.json({ publicRoomSlug: rate.publicRoomSlug, maxGuests: rate.maxGuests, bookingEnabled: rate.bookingEnabled })}
          )
        `;
      });
    },

    async saveDateOverride(input: DateOverrideInput, userId: string) {
      const override = dateOverrideInputSchema.parse(input);
      await sql.begin(async (tx) => {
        await requireMembership(tx, override.propertyId, userId);
        const [saved] = await tx<{ id: string }[]>`
          insert into public.property_rate_overrides (property_id, stay_date, price_paise, updated_by)
          values (${override.propertyId}, ${override.stayDate}, ${override.pricePaise}, ${userId})
          on conflict (property_id, stay_date) do update set
            price_paise = excluded.price_paise,
            updated_by = excluded.updated_by,
            updated_at = now()
          returning id
        `;
        await tx`
          insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
          values (
            ${override.propertyId}, ${userId}, 'pricing_override_saved', 'property_rate_override',
            ${saved.id}, ${tx.json({ stayDate: override.stayDate })}
          )
        `;
      });
    },

    async clearDateOverride(input: ClearDateOverrideInput, userId: string) {
      const override = clearDateOverrideInputSchema.parse(input);
      await sql.begin(async (tx) => {
        await requireMembership(tx, override.propertyId, userId);
        const [removed] = await tx<{ id: string }[]>`
          delete from public.property_rate_overrides
          where property_id = ${override.propertyId} and stay_date = ${override.stayDate}
          returning id
        `;
        if (!removed) throw new Error("NOT_FOUND");
        await tx`
          insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
          values (
            ${override.propertyId}, ${userId}, 'pricing_override_cleared', 'property_rate_override',
            ${removed.id}, ${tx.json({ stayDate: override.stayDate })}
          )
        `;
      });
    },
  };
}

function pricingService() {
  return createPricingService(getDb());
}

const DEMO_ROOMS = [
  ["Sage & Sunlight Studio", "sage-sunlight-studio"],
  ["Ink & Ivory Suite", "ink-ivory-suite"],
  ["Shade of Love", "shade-of-love"],
  ["Midnight Espresso Suite", "midnight-espresso-suite"],
  ["Luxe Urban Nest", "luxe-urban-nest"],
  ["Emerald Suite", "emerald-suite"],
  ["Linen & Lace Suite", "linen-lace-suite"],
  ["Silk & Sage", "silk-sage"],
] as const;

function demoPricing(): PricingSummary[] {
  return DEMO_ROOMS.map(([propertyName, publicRoomSlug], index) => ({
    propertyId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    propertyName,
    active: true,
    publicRoomSlug,
    maxGuests: 2,
    weekdayPricePaise: 550_000 + index * 25_000,
    weekendPricePaise: 650_000 + index * 25_000,
    bookingEnabled: true,
    overrides: [],
  }));
}

export function getQuoteForSlug(input: QuoteRequest) {
  return pricingService().getQuoteForSlug(input);
}

export function listPricingForUser(userId: string) {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") {
    return Promise.resolve(demoPricing());
  }
  return pricingService().listPricingForUser(userId);
}

export function saveBaseRates(input: BaseRateInput, userId: string) {
  return pricingService().saveBaseRates(input, userId);
}

export function saveDateOverride(input: DateOverrideInput, userId: string) {
  return pricingService().saveDateOverride(input, userId);
}

export function clearDateOverride(input: ClearDateOverrideInput, userId: string) {
  return pricingService().clearDateOverride(input, userId);
}
