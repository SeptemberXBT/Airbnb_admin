import { beforeEach, describe, expect, it } from "vitest";

import { resetDb, testSql } from "@/test/db-test-client";
import { createBookingResumeService } from "./booking-resume-service";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const HOLD_EXPIRES_AT = new Date("2026-07-26T12:10:00.000Z");
const ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64url");

async function seedHeldBooking(reference = "NH-RESUMETEST001") {
  const orderId = `order_${reference.toLowerCase()}`;
  const [property] = await testSql<{ id: string }[]>`
    insert into public.properties (name)
    values ('Resume Suite')
    returning id
  `;
  const [booking] = await testSql<{
    id: string;
    public_reference: string;
  }[]>`
    insert into public.bookings (
      public_reference, property_id, guest_name, guest_email, guest_phone,
      guest_count, checkin, checkout, status, hold_expires_at, amount_paise,
      razorpay_order_id, razorpay_key_id
    ) values (
      ${reference}, ${property.id}, 'Resume Guest',
      'resume@example.test', '+919999999999', 1, '2026-08-14', '2026-08-15',
      'held', ${HOLD_EXPIRES_AT}, 10000, ${orderId},
      'rzp_test_resume'
    )
    returning id, public_reference
  `;
  return { ...booking, propertyId: property.id };
}

describe("booking resume token lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("stores only encrypted token material and authorizes the matching booking", async () => {
    const booking = await seedHeldBooking();
    const service = createBookingResumeService(testSql, {
      encryptionKey: ENCRYPTION_KEY,
      clock: () => NOW,
    });

    const issued = await service.issue(booking.id, HOLD_EXPIRES_AT);

    expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await testSql<{
      token_hash: string;
      token_ciphertext: string;
      revoked_at: Date | null;
    }[]>`
      select token_hash, token_ciphertext, revoked_at
      from public.booking_resume_tokens
      where booking_id = ${booking.id}
    `;
    expect(JSON.stringify(stored)).not.toContain(issued);
    await expect(
      service.authorize(booking.public_reference, issued, NOW),
    ).resolves.toMatchObject({
      bookingId: booking.id,
      propertyId: booking.propertyId,
      publicReference: booking.public_reference,
      razorpayOrderId: "order_nh-resumetest001",
      razorpayKeyId: "rzp_test_resume",
    });
    await expect(
      service.authorize(booking.public_reference, `${issued}x`, NOW),
    ).rejects.toMatchObject({ code: "BOOKING_RESUME_TOKEN_INVALID" });
  });

  it("reveals the original token without rotating it", async () => {
    const booking = await seedHeldBooking();
    const service = createBookingResumeService(testSql, {
      encryptionKey: ENCRYPTION_KEY,
      clock: () => NOW,
    });

    const issued = await service.issue(booking.id, HOLD_EXPIRES_AT);

    await expect(service.issue(booking.id, HOLD_EXPIRES_AT)).resolves.toBe(
      issued,
    );
    await expect(service.reveal(booking.id)).resolves.toBe(issued);
    await expect(
      testSql`select booking_id from public.booking_resume_tokens`,
    ).resolves.toHaveLength(1);
  });

  it("rejects revoked and expired tokens", async () => {
    const booking = await seedHeldBooking();
    const service = createBookingResumeService(testSql, {
      encryptionKey: ENCRYPTION_KEY,
      clock: () => NOW,
    });
    const issued = await service.issue(booking.id, HOLD_EXPIRES_AT);

    await service.revoke(testSql, booking.id, NOW);
    await expect(
      service.authorize(booking.public_reference, issued, NOW),
    ).rejects.toMatchObject({ code: "BOOKING_RESUME_TOKEN_REVOKED" });

    const second = await seedHeldBooking("NH-RESUMETEST002");
    const expiredAt = new Date("2026-07-26T11:59:59.000Z");
    await testSql`
      update public.bookings
      set hold_expires_at = ${expiredAt}
      where id = ${second.id}
    `;
    const secondToken = await createBookingResumeService(testSql, {
      encryptionKey: ENCRYPTION_KEY,
      clock: () => new Date("2026-07-26T11:50:00.000Z"),
    }).issue(second.id, expiredAt);
    await expect(
      service.authorize("NH-RESUMETEST002", secondToken, NOW),
    ).rejects.toMatchObject({ code: "BOOKING_RESUME_TOKEN_EXPIRED" });
  });
});
