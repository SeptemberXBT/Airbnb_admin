import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testSql } from "./db-test-client";

describe("booking database harness", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("allows a released inventory night to be reclaimed", async () => {
    const [property] = await testSql<{ id: string }[]>`
      insert into public.properties (name)
      values ('Smoke Test Property')
      returning id
    `;
    const [booking] = await testSql<{ id: string }[]>`
      insert into public.bookings (
        public_reference,
        property_id,
        guest_name,
        guest_email,
        guest_phone,
        guest_count,
        checkin,
        checkout,
        amount_paise
      ) values (
        'NH-SMOKETEST001',
        ${property.id},
        'Smoke Guest',
        'smoke@example.com',
        '+919999999999',
        1,
        '2026-08-14',
        '2026-08-15',
        10000
      )
      returning id
    `;

    await testSql`
      insert into public.inventory_nights (
        property_id,
        stay_date,
        source_kind,
        source_id,
        booking_id,
        expires_at
      ) values (
        ${property.id},
        '2026-08-14',
        'website_hold',
        ${booking.id},
        ${booking.id},
        now() + interval '10 minutes'
      )
    `;
    await testSql`
      update public.inventory_nights
      set status = 'released', released_at = now(), release_reason = 'smoke_test'
      where property_id = ${property.id} and stay_date = '2026-08-14'
    `;
    await testSql`
      insert into public.inventory_nights (
        property_id,
        stay_date,
        source_kind,
        source_id,
        booking_id,
        expires_at
      ) values (
        ${property.id},
        '2026-08-14',
        'website_hold',
        ${booking.id},
        ${booking.id},
        now() + interval '10 minutes'
      )
    `;

    const [{ count }] = await testSql<{ count: number }[]>`
      select count(*)::int as count
      from public.inventory_nights
      where property_id = ${property.id}
        and stay_date = '2026-08-14'
        and status = 'active'
    `;

    expect(count).toBe(1);
  });
});
