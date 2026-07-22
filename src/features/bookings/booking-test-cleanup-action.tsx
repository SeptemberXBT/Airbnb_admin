"use client";

import { useState } from "react";

export function BookingTestCleanupAction({
  bookingId,
  publicReference,
}: { bookingId: string; publicReference: string }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return <button className="button button--danger" type="button" onClick={() => setOpen(true)}>
      Remove test booking
    </button>;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/remove-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicReference: confirmation }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "test_cleanup_failed");
      }
      window.location.reload();
    } catch {
      setError("The test booking could not be removed. No live payment or refund was changed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="booking-refund" onSubmit={submit}>
      <p>This archives the Razorpay test-mode booking and releases its dates without requesting a refund. Type <strong>{publicReference}</strong> to confirm.</p>
      <label htmlFor={`test-cleanup-${bookingId}`}>Booking reference</label>
      <input id={`test-cleanup-${bookingId}`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
      {error ? <p role="alert">{error}</p> : null}
      <div>
        <button className="button" type="button" onClick={() => setOpen(false)} disabled={pending}>Keep booking</button>
        <button className="button button--danger" type="submit" disabled={pending || confirmation !== publicReference}>
          {pending ? "Removing test booking…" : "Confirm test removal"}
        </button>
      </div>
    </form>
  );
}
