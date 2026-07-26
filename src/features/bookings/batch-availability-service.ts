import "server-only";
import type postgres from "postgres";
import { buildQuote, enumerateStayDates, type NightQuote } from "@/features/pricing/quote";
import { PUBLIC_ROOM_SLUGS } from "@/features/pricing/pricing-schema";
import {
  createAvailabilityBatchRequestSchema,
  currentIndiaStayDate,
  type AvailabilityBatchRequest,
} from "./booking-schema";

type Sql = postgres.Sql;
type PublicRoomSlug = (typeof PUBLIC_ROOM_SLUGS)[number];

type RateRow = {
  property_id: string;
  public_room_slug: PublicRoomSlug;
  max_guests: number;
  weekday_price_paise: number;
  weekend_price_paise: number;
};

export type BatchRoomAvailability = {
  publicRoomSlug: PublicRoomSlug;
  available: boolean;
  unavailableReason: "capacity" | "occupied" | null;
  nights: NightQuote[];
  totalPaise: number;
};

export function createBatchAvailabilityService(
  sql: Sql,
  options: { clock?: () => Date } = {},
) {
  const clock = options.clock ?? (() => new Date());

  return {
    async quoteBatch(rawInput: AvailabilityBatchRequest) {
      const input = createAvailabilityBatchRequestSchema(currentIndiaStayDate(clock()))
        .parse(rawInput);
      const dates = enumerateStayDates(input.checkin, input.checkout);

      const rates = await sql<RateRow[]>`
        select r.property_id, r.public_room_slug, r.max_guests,
          r.weekday_price_paise, r.weekend_price_paise
        from public.property_rates r
        join public.properties p on p.id = r.property_id
        where r.booking_enabled = true
          and p.active = true
          and p.archived_at is null
      `;
      const orderedRates = new Map(rates.map((rate) => [rate.public_room_slug, rate]));
      const enabledRates = PUBLIC_ROOM_SLUGS
        .map((slug) => orderedRates.get(slug))
        .filter((rate): rate is RateRow => Boolean(rate));
      const propertyIds = enabledRates.map((rate) => rate.property_id);

      const overrides = propertyIds.length === 0
        ? []
        : await sql<{ property_id: string; stay_date: string; price_paise: number }[]>`
          select property_id, stay_date::text, price_paise
          from public.property_rate_overrides
          where property_id in ${sql(propertyIds)}
            and stay_date in ${sql(dates)}
        `;
      const occupied = propertyIds.length === 0
        ? []
        : await sql<{ property_id: string; stay_date: string }[]>`
          select property_id, stay_date::text
          from public.inventory_nights
          where property_id in ${sql(propertyIds)}
            and stay_date in ${sql(dates)}
            and status = 'active'
        `;

      const overridesByProperty = new Map<string, Map<string, number>>();
      for (const override of overrides) {
        const roomOverrides = overridesByProperty.get(override.property_id) ?? new Map();
        roomOverrides.set(override.stay_date, override.price_paise);
        overridesByProperty.set(override.property_id, roomOverrides);
      }
      const occupiedProperties = new Set(occupied.map((night) => night.property_id));

      const rooms: BatchRoomAvailability[] = enabledRates.map((rate) => {
        const quote = buildQuote(
          dates,
          {
            weekdayPricePaise: rate.weekday_price_paise,
            weekendPricePaise: rate.weekend_price_paise,
          },
          overridesByProperty.get(rate.property_id) ?? new Map(),
        );
        const unavailableReason = input.guests > rate.max_guests
          ? "capacity" as const
          : occupiedProperties.has(rate.property_id)
            ? "occupied" as const
            : null;
        return {
          publicRoomSlug: rate.public_room_slug,
          available: unavailableReason === null,
          unavailableReason,
          nights: quote.nights,
          totalPaise: quote.totalPaise,
        };
      });

      return {
        checkin: input.checkin,
        checkout: input.checkout,
        guests: input.guests,
        currency: "INR" as const,
        rooms,
      };
    },
  };
}
