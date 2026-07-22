"use client";

import { useState } from "react";

export function BookingRefundAction({
  bookingId,
  publicReference,
  retry = false,
}: { bookingId: string; publicReference: string; retry?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return <button className="button button--danger" type="button" onClick={() => setOpen(true)}>
      {retry ? "Retry full refund" : "Refund, cancel & archive"}
    </button>;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/refund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicReference: confirmation }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "refund_failed");
      }
      window.location.reload();
    } catch {
      setError("The refund could not be started. No additional refund was created.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="booking-refund" onSubmit={submit}>
      <p>{retry ? "This retries the same full Razorpay refund; it cannot create a second refund." : "This releases the dates immediately and starts a full Razorpay refund."} Type <strong>{publicReference}</strong> to confirm.</p>
      <label htmlFor={`refund-${bookingId}`}>Booking reference</label>
      <input id={`refund-${bookingId}`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
      {error ? <p role="alert">{error}</p> : null}
      <div>
        <button className="button" type="button" onClick={() => setOpen(false)} disabled={pending}>Keep booking</button>
        <button className="button button--danger" type="submit" disabled={pending || confirmation !== publicReference}>
          {pending ? "Starting full refund…" : retry ? "Confirm refund retry" : "Confirm full refund"}
        </button>
      </div>
    </form>
  );
}
