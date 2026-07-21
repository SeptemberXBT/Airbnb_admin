import { BookingList } from "@/features/bookings/booking-list";
import { listBookingsForUser } from "@/features/bookings/admin-booking-service";
import { requireUser } from "@/lib/auth/require-user";

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ search?: string }> }) {
  const user = await requireUser();
  const search = (await searchParams).search?.trim().slice(0, 200) ?? "";
  const bookings = await listBookingsForUser(user.id, search);
  return (
    <div className="workspace workspace--bookings">
      <header className="page-header">
        <div><p className="eyebrow">Website booking operations</p><h1>Bookings</h1></div>
        <p className="page-header__note">Private guest, payment, email, and booking-event detail. Cancellations are not available in this release.</p>
      </header>
      <form className="booking-search" action="/bookings" method="get" role="search">
        <label htmlFor="booking-search">Search reference, guest, or email</label>
        <div><input id="booking-search" name="search" type="search" defaultValue={search} maxLength={200} /><button className="button button--primary" type="submit">Search</button></div>
      </form>
      <BookingList bookings={bookings} />
    </div>
  );
}
