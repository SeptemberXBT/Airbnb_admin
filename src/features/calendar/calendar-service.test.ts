import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createCalendarService } from "./calendar-service";

function sqlReturning(...queryResults: unknown[]) {
  let queryIndex = 0;
  return ((first: TemplateStringsArray | unknown) => {
    if (Array.isArray(first) && "raw" in first) {
      return Promise.resolve(queryResults[queryIndex++]);
    }
    return first;
  }) as postgres.Sql;
}

describe("calendar entry labels", () => {
  it("uses the entered guest name for a manual direct reservation", async () => {
    const sql = sqlReturning(
      [{
        id: "property-1",
        name: "Named Direct Suite",
        default_checkin_time: "13:00:00",
        default_checkout_time: "11:00:00",
        default_cleaning_minutes: 30,
        last_sync_at: "2026-07-25T09:00:00.000Z",
        last_sync_status: "success",
      }],
      [],
      [{
        id: "entry-1",
        property_id: "property-1",
        listing_id: null,
        entry_type: "direct_reservation",
        start_date: "2026-08-14",
        end_date: "2026-08-16",
        private_booking_name: "Aarav Sharma",
        private_contact: null,
        private_note: null,
        payment_amount: null,
        sync_to_airbnb: false,
        expected_checkin_time: null,
        expected_checkout_time: null,
        cleaning_duration_minutes: null,
        booking_id: null,
        public_reference: null,
      }],
      [],
      [],
    );

    const [room] = await createCalendarService(sql).getCalendarData("user-1", "2026-08-14", 3);

    expect(room.entries[0]).toMatchObject({
      source: "local",
      kind: "direct_reservation",
      label: "Aarav Sharma",
      privateBookingName: "Aarav Sharma",
    });
  });
});
