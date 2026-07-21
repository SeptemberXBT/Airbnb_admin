import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { createBookingService, BookingServiceError } from "./booking-service";
import { RazorpayClientError, type RazorpayOrder } from "@/features/payments/razorpay-client";
import { createInventoryService, releaseSourceNights } from "@/features/inventory/inventory-service";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-21T10:00:00.000Z");
const request = {
  publicRoomSlug: "shade-of-love" as const,
  checkin: "2026-08-14",
  checkout: "2026-08-17",
  guests: 2,
  guestName: "Website Guest",
  guestEmail: "website@example.test",
  guestPhone: "+919999999999",
};

let propertyId: string;
let orderSequence: number;

function order(receipt: string, amount = 1_900_000): RazorpayOrder {
  orderSequence += 1;
  return { id: `order_test_${orderSequence}`, amount, currency: "INR", receipt, status: "created" };
}

function fakeRazorpay() {
  return {
    publicKeyId: "rzp_test_public",
    createOrder: vi.fn(async ({ amountPaise, receipt }: { amountPaise: number; receipt: string }) => order(receipt, amountPaise)),
    findOrderByReceipt: vi.fn(async () => null as RazorpayOrder | null),
    fetchOrderPayments: vi.fn(async () => []),
  };
}

async function seedRoom() {
  await testSql`insert into auth.users (id, email) values (${USER_ID}, 'owner@example.test')`;
  const [property] = await testSql<{ id: string }[]>`
    insert into public.properties (name) values ('Shade of Love') returning id
  `;
  propertyId = property.id;
  await testSql`
    insert into public.property_rates (
      property_id, public_room_slug, max_guests, weekday_price_paise,
      weekend_price_paise, booking_enabled, updated_by
    ) values (${propertyId}, 'shade-of-love', 2, 500000, 700000, true, ${USER_ID})
  `;
  await testSql`
    insert into public.property_rate_overrides (property_id, stay_date, price_paise, updated_by)
    values (${propertyId}, '2026-08-15', 750000, ${USER_ID})
  `;
}

describe("authoritative website booking holds", () => {
  beforeEach(async () => {
    await resetDb();
    orderSequence = 0;
    await seedRoom();
  });

  it("quotes and snapshots authoritative override/weekend/weekday prices into a ten-minute hold", async () => {
    const razorpay = fakeRazorpay();
    const service = createBookingService(testSql, { razorpay, clock: () => NOW });
    const quote = await service.quoteAvailability({
      publicRoomSlug: request.publicRoomSlug,
      checkin: request.checkin,
      checkout: request.checkout,
      guests: request.guests,
    });
    expect(quote).toMatchObject({ available: true, totalPaise: 1_950_000, currency: "INR" });
    expect(quote.nights.map((night) => night.source)).toEqual(["weekend", "override", "weekday"]);

    const result = await service.createBooking(request, randomUUID());
    expect(result).toMatchObject({
      kind: "created", amountPaise: 1_950_000, currency: "INR", razorpayKeyId: "rzp_test_public",
    });
    expect(result.holdExpiresAt).toBe("2026-07-21T10:10:00.000Z");
    const [booking] = await testSql<{ status: string; amount_paise: number; hold_expires_at: string }[]>`
      select status, amount_paise, hold_expires_at::text from public.bookings
    `;
    expect(booking).toMatchObject({ status: "held", amount_paise: 1_950_000 });
    const snapshots = await testSql<{ stay_date: string; price_paise: number; price_source: string }[]>`
      select stay_date::text, price_paise, price_source from public.booking_night_prices order by stay_date
    `;
    expect(snapshots).toEqual([
      { stay_date: "2026-08-14", price_paise: 700000, price_source: "weekend" },
      { stay_date: "2026-08-15", price_paise: 750000, price_source: "override" },
      { stay_date: "2026-08-16", price_paise: 500000, price_source: "weekday" },
    ]);
    expect(await testSql`select stay_date from public.inventory_nights where status = 'active'`).toHaveLength(3);
    await expect(service.getPublicBookingStatus(result.bookingReference)).resolves.toEqual({
      status: "processing",
      refundStatus: "not_required",
    });

    await testSql`update public.property_rates set weekday_price_paise = 999999, weekend_price_paise = 999999 where property_id = ${propertyId}`;
    expect(await testSql`select price_paise from public.booking_night_prices order by stay_date`).toEqual([
      { price_paise: 700000 }, { price_paise: 750000 }, { price_paise: 500000 },
    ]);
  });

  it("serializes simultaneous attempts so only one hold and one Razorpay order wins", async () => {
    const razorpay = fakeRazorpay();
    const service = createBookingService(testSql, { razorpay, clock: () => NOW });
    const results = await Promise.allSettled([
      service.createBooking(request, randomUUID()),
      service.createBooking(request, randomUUID()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
      reason: expect.objectContaining({ code: "ROOM_UNAVAILABLE" }),
    });
    expect(razorpay.createOrder).toHaveBeenCalledOnce();
  });

  it("replays the same completed attempt without another hold or order", async () => {
    const razorpay = fakeRazorpay();
    const service = createBookingService(testSql, { razorpay, clock: () => NOW });
    const key = randomUUID();
    const first = await service.createBooking(request, key);
    const second = await service.createBooking(request, key);
    expect(second).toEqual(first);
    expect(razorpay.createOrder).toHaveBeenCalledOnce();
    expect(await testSql`select id from public.bookings`).toHaveLength(1);
  });

  it("releases immediately after a definitive order rejection", async () => {
    const razorpay = fakeRazorpay();
    razorpay.createOrder.mockRejectedValueOnce(new RazorpayClientError("definitive", "RAZORPAY_REJECTED"));
    const service = createBookingService(testSql, { razorpay, clock: () => NOW });
    await expect(service.createBooking(request, randomUUID())).rejects.toMatchObject({
      code: "PAYMENT_ORDER_FAILED",
    });
    expect(await testSql`select id from public.inventory_nights where status = 'active'`).toHaveLength(0);
    const [booking] = await testSql<{ status: string }[]>`select status from public.bookings`;
    expect(booking.status).toBe("payment_failed");
  });

  it("retains an ambiguous hold and recovers the provider order by receipt on retry", async () => {
    const razorpay = fakeRazorpay();
    razorpay.createOrder.mockRejectedValueOnce(new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"));
    const service = createBookingService(testSql, { razorpay, clock: () => NOW });
    const key = randomUUID();
    await expect(service.createBooking(request, key)).rejects.toMatchObject({ code: "PAYMENT_ORDER_RETRYABLE" });
    expect(await testSql`select id from public.inventory_nights where status = 'active'`).toHaveLength(3);
    expect(await testSql`select status from public.payment_jobs where job_kind = 'order_recovery'`).toEqual([{ status: "pending" }]);

    const [booking] = await testSql<{ public_reference: string; amount_paise: number }[]>`
      select public_reference, amount_paise from public.bookings
    `;
    razorpay.findOrderByReceipt.mockResolvedValueOnce(order(`nh_${booking.public_reference}`, booking.amount_paise));
    const recovered = await service.createBooking(request, key);
    expect(recovered.kind).toBe("created");
    expect(razorpay.createOrder).toHaveBeenCalledOnce();
    expect(razorpay.findOrderByReceipt).toHaveBeenCalledOnce();
    expect(await testSql`select status from public.payment_jobs where job_kind = 'order_recovery'`).toEqual([{ status: "succeeded" }]);
  });

  it("releases a resumed hold when receipt recovery finds no order and creation is definitively rejected", async () => {
    const razorpay = fakeRazorpay();
    razorpay.createOrder
      .mockRejectedValueOnce(new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"))
      .mockRejectedValueOnce(new RazorpayClientError("definitive", "RAZORPAY_REJECTED"));
    const service = createBookingService(testSql, { razorpay, clock: () => NOW });
    const key = randomUUID();
    await expect(service.createBooking(request, key)).rejects.toMatchObject({ code: "PAYMENT_ORDER_RETRYABLE" });

    await expect(service.createBooking(request, key)).rejects.toMatchObject({ code: "PAYMENT_ORDER_FAILED" });
    expect(await testSql`select id from public.inventory_nights where status = 'active'`).toHaveLength(0);
    const [booking] = await testSql<{ status: string }[]>`select status from public.bookings`;
    expect(booking.status).toBe("payment_failed");
  });

  it("does not resume Razorpay order creation after Airbnb has cancelled the ambiguous hold", async () => {
    const razorpay = fakeRazorpay();
    razorpay.createOrder.mockRejectedValueOnce(new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"));
    const service = createBookingService(testSql, { razorpay, clock: () => NOW });
    const key = randomUUID();
    await expect(service.createBooking(request, key)).rejects.toMatchObject({ code: "PAYMENT_ORDER_RETRYABLE" });
    const [booking] = await testSql<{ id: string }[]>`select id from public.bookings`;
    await createInventoryService(testSql).withPropertyInventory(propertyId, async (tx) => {
      await tx`update public.bookings set status = 'cancelled', cancellation_reason = 'airbnb_collision' where id = ${booking.id}`;
      await releaseSourceNights(tx, "website_hold", booking.id, "airbnb_collision");
    });

    await expect(service.createBooking(request, key)).rejects.toMatchObject({ code: "BOOKING_NO_LONGER_ACTIVE" });
    expect(razorpay.findOrderByReceipt).not.toHaveBeenCalled();
    expect(razorpay.createOrder).toHaveBeenCalledOnce();
    await expect(testSql`select status, razorpay_order_id from public.bookings`).resolves.toEqual([
      { status: "cancelled", razorpay_order_id: null },
    ]);
  });

  it("does not finalize an already-attached order after Airbnb has cancelled its hold", async () => {
    const razorpay = fakeRazorpay();
    razorpay.createOrder.mockRejectedValueOnce(new RazorpayClientError("ambiguous", "RAZORPAY_UNAVAILABLE"));
    const service = createBookingService(testSql, { razorpay, clock: () => NOW });
    const key = randomUUID();
    await expect(service.createBooking(request, key)).rejects.toMatchObject({ code: "PAYMENT_ORDER_RETRYABLE" });
    const [booking] = await testSql<{ id: string }[]>`select id from public.bookings`;
    await testSql`update public.bookings set razorpay_order_id = 'order_attached_before_cancel' where id = ${booking.id}`;
    await createInventoryService(testSql).withPropertyInventory(propertyId, async (tx) => {
      await tx`update public.bookings set status = 'cancelled', cancellation_reason = 'airbnb_collision' where id = ${booking.id}`;
      await releaseSourceNights(tx, "website_hold", booking.id, "airbnb_collision");
    });

    await expect(service.createBooking(request, key)).rejects.toMatchObject({ code: "BOOKING_NO_LONGER_ACTIVE" });
    await expect(testSql`select status, terminal_response from public.booking_attempts`).resolves.toEqual([
      { status: "definitive_failure", terminal_response: { error: "BOOKING_NO_LONGER_ACTIVE" } },
    ]);
    await expect(testSql`select status, provider_id from public.payment_jobs`).resolves.toEqual([
      { status: "definitive_failure", provider_id: null },
    ]);
  });

  it("uses a domain error type without exposing database or provider details", () => {
    expect(new BookingServiceError("ROOM_UNAVAILABLE", 409).message).toBe("ROOM_UNAVAILABLE");
  });
});
