import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { getDb } from "@/lib/db/client";
import { buildQuote, enumerateStayDates } from "@/features/pricing/quote";
import { claimStayNights, createInventoryService, releaseSourceNights } from "@/features/inventory/inventory-service";
import {
  createRazorpayClient,
  RazorpayClientError,
  type RazorpayClient,
  type RazorpayOrder,
} from "@/features/payments/razorpay-client";
import { orderReceipt } from "@/features/payments/order-recovery";
import { createAttemptService } from "./attempt-service";
import {
  type AvailabilityBatchRequest,
  createAvailabilityRequestSchema,
  createBookingRequestSchema,
  currentIndiaStayDate,
  type AvailabilityRequest,
  type CreateBookingRequest,
  type ValidatedCreateBookingRequest,
} from "./booking-schema";
import { createBatchAvailabilityService } from "./batch-availability-service";

type BookingSql = postgres.Sql;
type Queryable = postgres.Sql;
type RazorpayAdapter = Pick<RazorpayClient, "publicKeyId" | "createOrder" | "findOrderByReceipt" | "fetchOrderPayments">;

export class BookingServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "BookingServiceError";
  }
}

export type CheckoutResponse = {
  kind: "created";
  bookingReference: string;
  orderId: string;
  amountPaise: number;
  currency: "INR";
  razorpayKeyId: string;
  holdExpiresAt: string;
};

type StoredBooking = {
  id: string;
  property_id: string;
  public_reference: string;
  amount_paise: number;
  currency: "INR";
  hold_expires_at: Date | string;
  razorpay_order_id: string | null;
  razorpay_key_id: string | null;
  status: string;
};

function requestHash(request: ValidatedCreateBookingRequest) {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function bookingGuestName(input: ValidatedCreateBookingRequest) {
  return input.fullGuestName
    ?? input.guestName
    ?? `${input.firstName ?? ""} ${input.lastName ?? ""}`.trim();
}

function publicReference() {
  return `NH-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
}

function asIso(value: Date | string) {
  return new Date(value).toISOString();
}

async function propertyForSlug(sql: Queryable, publicRoomSlug: string) {
  const [row] = await sql<{ property_id: string }[]>`
    select r.property_id from public.property_rates r
    join public.properties p on p.id = r.property_id
    where r.public_room_slug = ${publicRoomSlug}
      and r.booking_enabled = true and p.active = true and p.archived_at is null
  `;
  if (!row) throw new BookingServiceError("ROOM_NOT_BOOKABLE", 409);
  return row.property_id;
}

async function authoritativeQuote(
  sql: Queryable,
  propertyId: string,
  input: AvailabilityRequest,
) {
  const [rate] = await sql<{
    property_id: string;
    max_guests: number;
    weekday_price_paise: number;
    weekend_price_paise: number;
  }[]>`
    select r.property_id, r.max_guests, r.weekday_price_paise, r.weekend_price_paise
    from public.property_rates r
    join public.properties p on p.id = r.property_id
    where r.property_id = ${propertyId} and r.public_room_slug = ${input.publicRoomSlug}
      and r.booking_enabled = true and p.active = true and p.archived_at is null
  `;
  if (!rate) throw new BookingServiceError("ROOM_NOT_BOOKABLE", 409);
  if (input.guests > rate.max_guests) throw new BookingServiceError("CAPACITY_EXCEEDED", 400);
  const dates = enumerateStayDates(input.checkin, input.checkout);
  const overrides = await sql<{ stay_date: string; price_paise: number }[]>`
    select stay_date::text, price_paise from public.property_rate_overrides
    where property_id = ${propertyId} and stay_date in ${sql(dates)}
  `;
  return {
    propertyId,
    dates,
    ...buildQuote(
      dates,
      { weekdayPricePaise: rate.weekday_price_paise, weekendPricePaise: rate.weekend_price_paise },
      new Map(overrides.map((override) => [override.stay_date, override.price_paise])),
    ),
  };
}

function checkoutResponse(booking: StoredBooking, orderId: string, razorpayKeyId: string): CheckoutResponse {
  return {
    kind: "created",
    bookingReference: booking.public_reference,
    orderId,
    amountPaise: booking.amount_paise,
    currency: booking.currency,
    razorpayKeyId,
    holdExpiresAt: asIso(booking.hold_expires_at),
  };
}

function validateExpectedOrder(order: RazorpayOrder, booking: StoredBooking) {
  if (
    order.amount !== booking.amount_paise
    || order.currency !== "INR"
    || order.receipt !== orderReceipt(booking.public_reference)
  ) throw new RazorpayClientError("ambiguous", "RAZORPAY_INVALID_RESPONSE");
  return order;
}

export function createBookingService(
  sql: BookingSql,
  dependencies: { razorpay?: RazorpayAdapter; clock?: () => Date },
) {
  const clock = dependencies.clock ?? (() => new Date());
  const inventory = createInventoryService(sql);
  const attempts = createAttemptService(sql, { clock });

  function requireRazorpay() {
    if (!dependencies.razorpay) throw new Error("RAZORPAY_NOT_CONFIGURED");
    return dependencies.razorpay;
  }

  async function terminalFailure(
    idempotencyKey: string,
    leaseToken: string,
    code: string,
    httpStatus: number,
  ): Promise<never> {
    await attempts.completeTerminal(idempotencyKey, leaseToken, {
      status: "definitive_failure",
      httpStatus,
      response: { error: code },
    });
    throw new BookingServiceError(code, httpStatus);
  }

  async function loadAttemptBooking(idempotencyKey: string) {
    const [booking] = await sql<StoredBooking[]>`
      select b.id, b.property_id, b.public_reference, b.amount_paise, b.currency,
        b.hold_expires_at, b.razorpay_order_id, b.razorpay_key_id, b.status
      from public.booking_attempts a
      join public.bookings b on b.id = a.booking_id
      where a.idempotency_key = ${idempotencyKey}
    `;
    return booking ?? null;
  }

  async function attemptBookingHasActiveHold(booking: StoredBooking) {
    return inventory.withPropertyInventory(booking.property_id, async (tx) => {
      const [active] = await tx`
        select 1 from public.bookings b
        where b.id = ${booking.id} and b.status in ('processing', 'held')
          and b.hold_expires_at > ${clock()}
          and exists (
            select 1 from public.inventory_nights i
            where i.booking_id = b.id and i.property_id = b.property_id
              and i.source_kind = 'website_hold' and i.status = 'active'
          )
        for update of b
      `;
      return Boolean(active);
    });
  }

  async function finalizeAttachedOrder(
    booking: StoredBooking,
    idempotencyKey: string,
    leaseToken: string,
  ) {
    if (!booking.razorpay_order_id) throw new Error("ORDER_ID_REQUIRED");
    const orderId = booking.razorpay_order_id;
    const razorpayKeyId = requireRazorpay().publicKeyId;
    return inventory.withPropertyInventory(booking.property_id, async (tx) => {
      const now = clock();
      const [active] = await tx`
        select 1 from public.bookings b
        where b.id = ${booking.id} and b.status in ('processing', 'held')
          and b.hold_expires_at > ${now} and b.razorpay_order_id = ${orderId}
          and exists (
            select 1 from public.inventory_nights i
            where i.booking_id = b.id and i.property_id = b.property_id
              and i.source_kind = 'website_hold' and i.status = 'active'
          )
        for update of b
      `;
      if (!active) return null;
      const [accountBound] = await tx`
        update public.bookings set razorpay_key_id = ${razorpayKeyId}, updated_at = ${now}
        where id = ${booking.id}
        returning id
      `;
      if (!accountBound) throw new BookingServiceError("PAYMENT_ACCOUNT_MISMATCH", 503);
      if (booking.razorpay_key_id !== razorpayKeyId) {
        const changes = tx.json({ previousKeyId: booking.razorpay_key_id, currentKeyId: razorpayKeyId, source: "checkout_resume" });
        await tx`
          insert into public.booking_events (property_id, booking_id, event_type, metadata)
          values (${booking.property_id}, ${booking.id}, 'razorpay_account_rebound', ${changes})
        `;
        await tx`
          insert into public.audit_log (property_id, action, entity_type, entity_id, changes)
          values (${booking.property_id}, 'razorpay_account_rebound', 'website_booking', ${booking.id}, ${changes})
        `;
      }
      const response = checkoutResponse(booking, orderId, razorpayKeyId);
      await tx`
        update public.payment_jobs set status = 'succeeded', provider_id = ${orderId},
          terminal_result = ${tx.json(response)}, lease_token = null, lease_expires_at = null,
          last_error_code = null, updated_at = ${now}
        where booking_id = ${booking.id} and job_kind = 'order_recovery'
      `;
      const [attempt] = await tx<{ idempotency_key: string }[]>`
        update public.booking_attempts set status = 'succeeded', durable_step = 'razorpay_order_created',
          terminal_http_status = 201, terminal_response = ${tx.json(response)},
          replay_until = ${new Date(now.getTime() + 30 * 60_000)}, lease_token = null,
          lease_expires_at = null, updated_at = ${now}
        where idempotency_key = ${idempotencyKey} and status = 'processing' and lease_token = ${leaseToken}
        returning idempotency_key
      `;
      if (!attempt) throw new Error("ATTEMPT_LEASE_LOST");
      return response;
    });
  }

  async function markOrderRecoveryInactive(booking: StoredBooking, providerId: string | null = null) {
    await sql`
      update public.payment_jobs set status = 'definitive_failure', provider_id = coalesce(${providerId}, provider_id),
        last_error_code = 'booking_no_longer_active', lease_token = null, lease_expires_at = null,
        updated_at = ${clock()}
      where booking_id = ${booking.id} and job_kind = 'order_recovery' and status <> 'succeeded'
    `;
  }

  async function createHold(
    input: ValidatedCreateBookingRequest,
    idempotencyKey: string,
    leaseToken: string,
  ) {
    const propertyId = await propertyForSlug(sql, input.publicRoomSlug);
    return inventory.withPropertyInventory(propertyId, async (tx) => {
      const query = tx as unknown as Queryable;
      const quote = await authoritativeQuote(query, propertyId, input);
      const holdExpiresAt = new Date(clock().getTime() + 10 * 60_000);
      const reference = publicReference();
      const guestName = bookingGuestName(input);
      const [booking] = await tx<StoredBooking[]>`
        insert into public.bookings (
          public_reference, property_id, guest_name, guest_email, guest_phone,
          guest_count, checkin, checkout, status, hold_expires_at, amount_paise, currency,
          booker_first_name, booker_last_name, country_code, special_requests
        ) values (
          ${reference}, ${propertyId}, ${guestName}, ${input.guestEmail}, ${input.guestPhone},
          ${input.guests}, ${input.checkin}, ${input.checkout}, 'held', ${holdExpiresAt}, ${quote.totalPaise}, 'INR',
          ${input.firstName ?? null}, ${input.lastName ?? null}, ${input.countryCode}, ${input.notes ?? null}
        ) returning id, property_id, public_reference, amount_paise, currency,
          hold_expires_at, razorpay_order_id, razorpay_key_id, status
      `;
      for (const night of quote.nights) {
        await tx`
          insert into public.booking_night_prices (booking_id, stay_date, price_paise, price_source)
          values (${booking.id}, ${night.date}, ${night.amountPaise}, ${night.source})
        `;
      }
      await claimStayNights(tx, {
        propertyId,
        stayDates: quote.dates,
        sourceKind: "website_hold",
        sourceId: booking.id,
        expiresAt: holdExpiresAt,
      });
      const [attempt] = await tx<{ idempotency_key: string }[]>`
        update public.booking_attempts
        set booking_id = ${booking.id}, durable_step = 'hold_committed', updated_at = ${clock()}
        where idempotency_key = ${idempotencyKey} and status = 'processing' and lease_token = ${leaseToken}
        returning idempotency_key
      `;
      if (!attempt) throw new Error("ATTEMPT_LEASE_LOST");
      await tx`
        insert into public.booking_events (property_id, booking_id, event_type, metadata)
        values (${propertyId}, ${booking.id}, 'hold_created', ${tx.json({ holdExpiresAt: holdExpiresAt.toISOString() })})
      `;
      return booking;
    });
  }

  async function releaseDefinitiveOrderFailure(booking: StoredBooking) {
    await inventory.withPropertyInventory(booking.property_id, async (tx) => {
      await tx`
        update public.bookings set status = 'payment_failed', updated_at = ${clock()}
        where id = ${booking.id} and status in ('held', 'processing')
      `;
      await releaseSourceNights(tx, "website_hold", booking.id, "razorpay_order_rejected");
      await tx`
        insert into public.booking_events (property_id, booking_id, event_type, metadata)
        values (${booking.property_id}, ${booking.id}, 'payment_order_failed', '{}')
      `;
      await tx`
        update public.payment_jobs set status = 'definitive_failure', last_error_code = 'order_rejected',
          lease_token = null, lease_expires_at = null, updated_at = ${clock()}
        where booking_id = ${booking.id} and job_kind = 'order_recovery'
      `;
    });
  }

  return {
    async quoteAvailability(rawInput: AvailabilityRequest) {
      const input = createAvailabilityRequestSchema(currentIndiaStayDate(clock())).parse(rawInput);
      const propertyId = await propertyForSlug(sql, input.publicRoomSlug);
      return inventory.withPropertyInventory(propertyId, async (tx) => {
        const query = tx as unknown as Queryable;
        const quote = await authoritativeQuote(query, propertyId, input);
        const [occupied] = await tx`
          select 1 from public.inventory_nights
          where property_id = ${propertyId} and stay_date in ${tx(quote.dates)} and status = 'active'
          limit 1
        `;
        return {
          available: !occupied,
          publicRoomSlug: input.publicRoomSlug,
          checkin: input.checkin,
          checkout: input.checkout,
          guests: input.guests,
          currency: quote.currency,
          nights: quote.nights,
          totalPaise: quote.totalPaise,
        };
      });
    },

    async createBooking(rawInput: CreateBookingRequest, idempotencyKey: string): Promise<CheckoutResponse> {
      const razorpay = requireRazorpay();
      const input = createBookingRequestSchema(currentIndiaStayDate(clock())).parse(rawInput);
      const acquisition = await attempts.acquire(idempotencyKey, requestHash(input));
      if (acquisition.kind === "processing") {
        throw new BookingServiceError("ATTEMPT_PROCESSING", 202, acquisition.retryAfterSeconds);
      }
      if (acquisition.kind === "conflict") throw new BookingServiceError("IDEMPOTENCY_CONFLICT", 409);
      if (acquisition.kind === "expired") throw new BookingServiceError("IDEMPOTENCY_KEY_EXPIRED", 409);
      if (acquisition.kind === "replay") {
        if (acquisition.httpStatus >= 200 && acquisition.httpStatus < 300) return acquisition.response as CheckoutResponse;
        const code = (acquisition.response as { error?: string } | null)?.error ?? "BOOKING_FAILED";
        throw new BookingServiceError(code, acquisition.httpStatus);
      }

      let booking = await loadAttemptBooking(idempotencyKey);
      if (!booking) {
        try {
          booking = await createHold(input, idempotencyKey, acquisition.leaseToken);
        } catch (error) {
          if (error instanceof BookingServiceError) {
            return terminalFailure(idempotencyKey, acquisition.leaseToken, error.code, error.httpStatus);
          }
          if (error instanceof Error && error.message === "INVENTORY_UNAVAILABLE") {
            return terminalFailure(idempotencyKey, acquisition.leaseToken, "ROOM_UNAVAILABLE", 409);
          }
          await attempts.markRetryable(idempotencyKey, acquisition.leaseToken);
          throw new BookingServiceError("BOOKING_RETRYABLE", 503);
        }
      } else {
        if (booking.razorpay_order_id) {
          if (booking.razorpay_key_id !== razorpay.publicKeyId) {
            try {
              await razorpay.fetchOrderPayments(booking.razorpay_order_id);
            } catch {
              await attempts.markRetryable(idempotencyKey, acquisition.leaseToken);
              throw new BookingServiceError("PAYMENT_ACCOUNT_MISMATCH", 503);
            }
          }
          const response = await finalizeAttachedOrder(booking, idempotencyKey, acquisition.leaseToken);
          if (response) return response;
          await markOrderRecoveryInactive(booking);
          return terminalFailure(idempotencyKey, acquisition.leaseToken, "BOOKING_NO_LONGER_ACTIVE", 409);
        }
        if (!await attemptBookingHasActiveHold(booking)) {
          await markOrderRecoveryInactive(booking);
          return terminalFailure(idempotencyKey, acquisition.leaseToken, "BOOKING_NO_LONGER_ACTIVE", 409);
        }
      }

      await attempts.recordProgress(idempotencyKey, acquisition.leaseToken, "razorpay_order_pending");
      await sql`
        insert into public.payment_jobs (
          booking_id, job_kind, idempotency_identity, status, next_attempt_at
        ) values (
          ${booking.id}, 'order_recovery', ${`order-recovery:${booking.id}`}, 'pending',
          ${new Date(clock().getTime() + 60_000)}
        ) on conflict (idempotency_identity) do nothing
      `;
      const receipt = orderReceipt(booking.public_reference);
      let providerOrder: RazorpayOrder;
      let recovered: RazorpayOrder | null = null;
      if (acquisition.resumed) {
        try {
          recovered = await razorpay.findOrderByReceipt(receipt);
          if (recovered) validateExpectedOrder(recovered, booking);
        } catch {
          await attempts.markRetryable(idempotencyKey, acquisition.leaseToken);
          throw new BookingServiceError("PAYMENT_ORDER_RETRYABLE", 503);
        }
      }
      if (recovered) {
        providerOrder = recovered;
      } else {
        try {
          providerOrder = validateExpectedOrder(
            await razorpay.createOrder({ amountPaise: booking.amount_paise, receipt }),
            booking,
          );
        } catch (error) {
          if (error instanceof RazorpayClientError && error.kind === "definitive") {
            await releaseDefinitiveOrderFailure(booking);
            return terminalFailure(idempotencyKey, acquisition.leaseToken, "PAYMENT_ORDER_FAILED", 503);
          }
          await attempts.markRetryable(idempotencyKey, acquisition.leaseToken);
          throw new BookingServiceError("PAYMENT_ORDER_RETRYABLE", 503);
        }
      }

      const orderAttached = await inventory.withPropertyInventory(booking.property_id, async (tx) => {
        const [active] = await tx`
          select 1 from public.bookings b
          where b.id = ${booking.id} and b.status in ('processing', 'held')
            and b.hold_expires_at > ${clock()}
            and exists (
              select 1 from public.inventory_nights i
              where i.booking_id = b.id and i.property_id = b.property_id
                and i.source_kind = 'website_hold' and i.status = 'active'
            )
          for update of b
        `;
        if (!active) return false;
        const [saved] = await tx`
          update public.bookings set razorpay_order_id = ${providerOrder.id},
            razorpay_key_id = ${razorpay.publicKeyId}, updated_at = ${clock()}
          where id = ${booking.id} and razorpay_order_id is null
            and status in ('processing', 'held') and hold_expires_at > ${clock()}
          returning id
        `;
        if (!saved) {
          const [existing] = await tx<{ razorpay_order_id: string; razorpay_key_id: string | null }[]>`
            select razorpay_order_id, razorpay_key_id from public.bookings where id = ${booking.id}
          `;
          if (!existing || existing.razorpay_order_id !== providerOrder.id
            || existing.razorpay_key_id !== razorpay.publicKeyId) throw new Error("ORDER_ID_CONFLICT");
        }
        const [attempt] = await tx`
          update public.booking_attempts set durable_step = 'razorpay_order_created', updated_at = ${clock()}
          where idempotency_key = ${idempotencyKey} and status = 'processing' and lease_token = ${acquisition.leaseToken}
          returning idempotency_key
        `;
        if (!attempt) throw new Error("ATTEMPT_LEASE_LOST");
        await tx`
          update public.payment_jobs set status = 'succeeded', provider_id = ${providerOrder.id},
            terminal_result = ${tx.json(checkoutResponse(booking, providerOrder.id, razorpay.publicKeyId))},
            lease_token = null, lease_expires_at = null, last_error_code = null, updated_at = ${clock()}
          where booking_id = ${booking.id} and job_kind = 'order_recovery'
        `;
        return true;
      });
      if (!orderAttached) {
        await markOrderRecoveryInactive(booking, providerOrder.id);
        return terminalFailure(idempotencyKey, acquisition.leaseToken, "BOOKING_NO_LONGER_ACTIVE", 409);
      }
      booking = { ...booking, razorpay_order_id: providerOrder.id, razorpay_key_id: razorpay.publicKeyId };
      const response = checkoutResponse(booking, providerOrder.id, razorpay.publicKeyId);
      await attempts.completeTerminal(idempotencyKey, acquisition.leaseToken, {
        status: "succeeded", httpStatus: 201, response,
      });
      return response;
    },

    async getPublicBookingStatus(reference: string) {
      const [booking] = await sql<{
        status: string;
        refund_status: string;
        public_reference: string;
        property_name: string;
        checkin: string;
        checkout: string;
        guest_count: number;
        amount_paise: number;
        currency: "INR";
      }[]>`
        select b.status, b.refund_status, b.public_reference, p.name as property_name,
          b.checkin::text, b.checkout::text, b.guest_count, b.amount_paise, b.currency
        from public.bookings b join public.properties p on p.id = b.property_id
        where b.public_reference = ${reference}
      `;
      if (!booking) throw new BookingServiceError("BOOKING_NOT_FOUND", 404);
      return {
        status: booking.status === "held" ? "processing" : booking.status,
        refundStatus: booking.refund_status,
        bookingReference: booking.public_reference,
        propertyName: booking.property_name,
        checkin: booking.checkin,
        checkout: booking.checkout,
        guestCount: booking.guest_count,
        amountPaise: booking.amount_paise,
        currency: booking.currency,
      };
    },
  };
}

function configuredService() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("RAZORPAY_NOT_CONFIGURED");
  return createBookingService(getDb(), {
    razorpay: createRazorpayClient({ keyId, keySecret }),
  });
}

function configuredAvailabilityService() {
  return createBookingService(getDb(), {});
}

export function quoteAvailability(input: AvailabilityRequest) {
  return configuredAvailabilityService().quoteAvailability(input);
}

export function quoteAvailabilityBatch(input: AvailabilityBatchRequest) {
  return createBatchAvailabilityService(getDb()).quoteBatch(input);
}

export function createBooking(input: CreateBookingRequest, idempotencyKey: string) {
  return configuredService().createBooking(input, idempotencyKey);
}

export function getPublicBookingStatus(reference: string) {
  return configuredAvailabilityService().getPublicBookingStatus(reference);
}
