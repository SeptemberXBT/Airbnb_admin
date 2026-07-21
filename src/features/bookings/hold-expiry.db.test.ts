import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testSql } from "@/test/db-test-client";
import { claimStayNights, createInventoryService } from "@/features/inventory/inventory-service";
import { createPaymentReconciliationService } from "@/features/payments/payment-reconciliation";
import { processExpiredHolds } from "./hold-expiry";

const NOW = new Date("2026-07-21T10:15:00.000Z");

describe("hold expiry worker", () => {
  beforeEach(resetDb);

  it("processes only expired holds in bounded batches after a final provider check", async () => {
    const [property] = await testSql<{ id: string }[]>`insert into public.properties (name) values ('Expiry Worker Suite') returning id`;
    const add = async (reference: string, expiresAt: Date) => {
      const [booking] = await testSql<{ id: string }[]>`
        insert into public.bookings (
          public_reference, property_id, guest_name, guest_email, guest_phone, guest_count,
          checkin, checkout, status, hold_expires_at, amount_paise, razorpay_order_id
        ) values (${reference}, ${property.id}, 'Expiry Guest', 'expiry@example.test', '+919999999999', 1,
          '2026-08-14', '2026-08-15', 'held', ${expiresAt}, 500000, ${`order-${reference}`}) returning id
      `;
      await createInventoryService(testSql).withPropertyInventory(property.id, (tx) => claimStayNights(tx, {
        propertyId: property.id, stayDates: [reference.endsWith("1") ? "2026-08-14" : "2026-08-15"],
        sourceKind: "website_hold", sourceId: booking.id, expiresAt,
      }));
    };
    await add("NH-EXPIRYWORKER001", new Date("2026-07-21T10:10:00.000Z"));
    await add("NH-EXPIRYWORKER002", new Date("2026-07-21T10:20:00.000Z"));
    const reconciliation = createPaymentReconciliationService(testSql, {
      razorpay: { fetchOrderPayments: vi.fn(async () => []) }, clock: () => NOW,
    });

    expect(await processExpiredHolds(testSql, reconciliation, { now: NOW, limit: 1 })).toEqual({ processed: 1, failed: 0 });
    const rows = await testSql<{ public_reference: string; status: string }[]>`
      select public_reference, status from public.bookings order by public_reference
    `;
    expect(rows).toEqual([
      { public_reference: "NH-EXPIRYWORKER001", status: "expired" },
      { public_reference: "NH-EXPIRYWORKER002", status: "held" },
    ]);
  });
});
