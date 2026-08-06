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

  it("returns completed-early stays as observed, nonblocking history", async () => {
    const sql = sqlReturning(
      [{
        id: "property-1",
        name: "Released Suite",
        default_checkin_time: "13:00:00",
        default_checkout_time: "11:00:00",
        default_cleaning_minutes: 30,
        last_sync_at: "2026-08-16T09:00:00.000Z",
        last_sync_status: "success",
      }],
      [],
      [{
        id: "entry-released",
        property_id: "property-1",
        listing_id: "listing-1",
        entry_type: "direct_reservation",
        start_date: "2026-08-14",
        end_date: "2026-08-18",
        private_booking_name: "Early Guest",
        private_contact: null,
        private_note: null,
        payment_amount: "2500.00",
        sync_to_airbnb: true,
        expected_checkin_time: null,
        expected_checkout_time: null,
        cleaning_duration_minutes: null,
        booking_id: null,
        public_reference: null,
        completed_early_at: "2026-08-15T08:30:00.000Z",
        early_checkout_effective_date: "2026-08-15",
      }],
      [],
      [],
    );

    const [room] = await createCalendarService(sql).getCalendarData("user-1", "2026-08-14", 5);

    expect(room.entries).toHaveLength(1);
    expect(room.entries[0]).toMatchObject({
      source: "local",
      kind: "completed_early",
      label: "Completed early",
      startDate: "2026-08-14",
      endDate: "2026-08-18",
      completedEarlyAt: "2026-08-15T08:30:00.000Z",
      earlyCheckoutEffectiveDate: "2026-08-15",
      releaseObservedOnAirbnb: true,
      sameDayTurnover: false,
    });
  });
});
