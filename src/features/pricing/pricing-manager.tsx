"use client";

import { Check, CircleDollarSign, RefreshCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { priceNight } from "./quote";
import { PUBLIC_ROOM_SLUGS } from "./pricing-schema";
import type { PricingSummary } from "./pricing-service";

const DAY_COUNT = 14;

function indiaToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function displayDate(date: string) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .format(new Date(`${date}T00:00:00Z`));
}

function formatRupees(paise: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

function paiseToInput(paise: number | null) {
  if (paise === null) return "";
  return (paise / 100).toFixed(paise % 100 === 0 ? 0 : 2);
}

function rupeesToPaise(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("INVALID_PRICE");
  const [rupees, paise = ""] = text.split(".");
  const result = Number(rupees) * 100 + Number(paise.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("INVALID_PRICE");
  return result;
}

type PriceEditor = { propertyId: string; stayDate: string } | null;

export function PricingManager({
  initialPricing,
  demoMode,
  startDate = indiaToday(),
}: {
  initialPricing: PricingSummary[];
  demoMode: boolean;
  startDate?: string;
}) {
  const router = useRouter();
  const [pricing, setPricing] = useState(initialPricing);
  const [message, setMessage] = useState("");
  const [savingKey, setSavingKey] = useState("");
  const [editor, setEditor] = useState<PriceEditor>(null);
  const savingRef = useRef(false);
  const dates = Array.from({ length: DAY_COUNT }, (_, index) => addDays(startDate, index));

  async function mutate(body: object, key: string) {
    if (demoMode) {
      setMessage("Connect Supabase to save pricing changes.");
      return false;
    }
    if (savingRef.current) return false;
    savingRef.current = true;
    setSavingKey(key);
    setMessage("");
    try {
      const response = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setMessage("Could not save pricing. Check the values and try again.");
        return false;
      }
      router.refresh();
      return true;
    } finally {
      savingRef.current = false;
      setSavingKey("");
    }
  }

  async function saveBase(event: FormEvent<HTMLFormElement>, room: PricingSummary) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let weekdayPricePaise: number;
    let weekendPricePaise: number;
    try {
      weekdayPricePaise = rupeesToPaise(data.get("weekdayPrice"));
      weekendPricePaise = rupeesToPaise(data.get("weekendPrice"));
    } catch {
      setMessage("Enter positive prices with no more than two decimal places.");
      return;
    }
    const next: PricingSummary = {
      ...room,
      publicRoomSlug: String(data.get("publicRoomSlug")),
      maxGuests: Number(data.get("maxGuests")),
      weekdayPricePaise,
      weekendPricePaise,
      bookingEnabled: data.get("bookingEnabled") === "on",
    };
    if (await mutate({
      action: "save_base_rates",
      rate: {
        propertyId: room.propertyId,
        publicRoomSlug: next.publicRoomSlug,
        maxGuests: next.maxGuests,
        weekdayPricePaise,
        weekendPricePaise,
        bookingEnabled: next.bookingEnabled,
      },
    }, `base:${room.propertyId}`)) {
      setPricing((current) => current.map((value) => value.propertyId === room.propertyId ? next : value));
      setMessage("Base rates saved.");
    }
  }

  async function saveOverride(event: FormEvent<HTMLFormElement>, room: PricingSummary, stayDate: string) {
    event.preventDefault();
    let pricePaise: number;
    try {
      pricePaise = rupeesToPaise(new FormData(event.currentTarget).get("customPrice"));
    } catch {
      setMessage("Enter a positive custom price with no more than two decimal places.");
      return;
    }
    if (await mutate({ action: "save_override", propertyId: room.propertyId, stayDate, pricePaise }, `override:${room.propertyId}:${stayDate}`)) {
      setPricing((current) => current.map((value) => value.propertyId === room.propertyId ? {
        ...value,
        overrides: [...value.overrides.filter((override) => override.stayDate !== stayDate), { stayDate, pricePaise }],
      } : value));
      setEditor(null);
      setMessage("Custom night price saved.");
    }
  }

  async function clearOverride(room: PricingSummary, stayDate: string) {
    if (await mutate({ action: "clear_override", propertyId: room.propertyId, stayDate }, `override:${room.propertyId}:${stayDate}`)) {
      setPricing((current) => current.map((value) => value.propertyId === room.propertyId ? {
        ...value,
        overrides: value.overrides.filter((override) => override.stayDate !== stayDate),
      } : value));
      setEditor(null);
      setMessage("Custom night price cleared.");
    }
  }

  return (
    <>
      {message ? <div className="notice" role="status">{message}</div> : null}
      {pricing.length === 0 ? <div className="list-empty"><CircleDollarSign size={28} /><span>Add a property before configuring prices.</span></div> : null}
      <div className="pricing-scroller" data-testid="pricing-scroller">
        <div className="pricing-board" style={{ "--pricing-days": DAY_COUNT } as React.CSSProperties}>
          <div className="pricing-board__header" aria-hidden="true">
            <div className="pricing-board__property-heading">Property rates</div>
            <div className="pricing-date-strip">
              {dates.map((date) => <div key={date}><span>{displayDate(date)}</span></div>)}
            </div>
          </div>
          {pricing.map((room) => {
            const configured = room.weekdayPricePaise !== null && room.weekendPricePaise !== null;
            const overrides = new Map(room.overrides.map((override) => [override.stayDate, override.pricePaise]));
            return (
              <article className="pricing-property-row" aria-label={`Pricing for ${room.propertyName}`} key={room.propertyId}>
                <form className="pricing-base-form" onSubmit={(event) => saveBase(event, room)}>
                  <div className="pricing-property-name"><strong>{room.propertyName}</strong><span>{room.publicRoomSlug ?? "Not connected to a public room"}</span></div>
                  <label className="pricing-field">Public room<select name="publicRoomSlug" defaultValue={room.publicRoomSlug ?? ""} required><option value="" disabled>Select room</option>{PUBLIC_ROOM_SLUGS.map((slug) => <option value={slug} key={slug}>{slug}</option>)}</select></label>
                  <div className="pricing-base-grid">
                    <label className="pricing-field">Weekday price for {room.propertyName} (₹)<input name="weekdayPrice" type="number" min="0.01" step="0.01" defaultValue={paiseToInput(room.weekdayPricePaise)} required /></label>
                    <label className="pricing-field">Weekend price for {room.propertyName} (₹)<input name="weekendPrice" type="number" min="0.01" step="0.01" defaultValue={paiseToInput(room.weekendPricePaise)} required /></label>
                    <label className="pricing-field">Maximum guests<input name="maxGuests" type="number" min="1" max="20" defaultValue={room.maxGuests ?? 2} required /></label>
                  </div>
                  <label className="pricing-bookable"><input name="bookingEnabled" type="checkbox" defaultChecked={room.bookingEnabled} /> Available for website booking</label>
                  <button className="button button--primary" type="submit" disabled={savingKey === `base:${room.propertyId}`} aria-label={`Save base rates for ${room.propertyName}`}>
                    {savingKey === `base:${room.propertyId}` ? <RefreshCw className="spin" size={15} /> : <Check size={15} />} Save rates
                  </button>
                </form>
                <div className="pricing-night-strip">
                  {dates.map((date) => {
                    const night = configured ? priceNight(date, {
                      weekdayPricePaise: room.weekdayPricePaise!,
                      weekendPricePaise: room.weekendPricePaise!,
                    }, overrides) : null;
                    const selected = editor?.propertyId === room.propertyId && editor.stayDate === date;
                    const override = overrides.get(date);
                    return <div className={`pricing-night ${night?.source === "override" ? "pricing-night--override" : ""}`} key={date}>
                      <button type="button" aria-label={`Edit price for ${room.propertyName} on ${date}`} onClick={() => setEditor({ propertyId: room.propertyId, stayDate: date })}>
                        <strong>{night ? formatRupees(night.amountPaise) : "Set rates"}</strong>
                        <span>{night?.source ?? "unconfigured"}</span>
                      </button>
                      {selected ? <form className="pricing-override-editor" onSubmit={(event) => saveOverride(event, room, date)}>
                        <div><strong>{displayDate(date)}</strong><button type="button" aria-label="Close custom price editor" onClick={() => setEditor(null)}><X size={15} /></button></div>
                        <label className="pricing-field">Custom night price (₹)<input name="customPrice" type="number" min="0.01" step="0.01" defaultValue={paiseToInput(override ?? night?.amountPaise ?? null)} required autoFocus /></label>
                        <button className="button button--primary" type="submit" disabled={savingKey === `override:${room.propertyId}:${date}`}>Save custom price</button>
                        {override !== undefined ? <button className="button button--quiet" type="button" disabled={savingKey === `override:${room.propertyId}:${date}`} onClick={() => clearOverride(room, date)}>Clear custom price</button> : null}
                      </form> : null}
                    </div>;
                  })}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </>
  );
}
