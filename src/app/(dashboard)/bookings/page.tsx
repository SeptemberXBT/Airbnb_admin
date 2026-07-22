import { BookingList } from "@/features/bookings/booking-list";
import { listBookingsForUser } from "@/features/bookings/admin-booking-service";
import { requireUser } from "@/lib/auth/require-user";

export default async function BookingsPage({ searchParams }: { searchParams: Promise<{ search?: string; view?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const search = params.search?.trim().slice(0, 200) ?? "";
  const view = params.view === "archived" || params.view === "all" ? params.view : "active";
  const bookings = await listBookingsForUser(user.id, search, view);
  return (
    <div className="workspace workspace--bookings">
      <header className="page-header">
        <div><p className="eyebrow">Website booking operations</p><h1>Bookings</h1></div>
        <p className="page-header__note">Private guest, payment, email, and booking-event detail with guarded full-refund cancellation.</p>
      </header>
      <form className="booking-search" action="/bookings" method="get" role="search">
        <label htmlFor="booking-search">Search reference, guest, or email</label>
        <div><input id="booking-search" name="search" type="search" defaultValue={search} maxLength={200} /><select name="view" defaultValue={view} aria-label="Booking visibility"><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select><button className="button button--primary" type="submit">Search</button></div>
      </form>
      <BookingList bookings={bookings} />
    </div>
  );
}
