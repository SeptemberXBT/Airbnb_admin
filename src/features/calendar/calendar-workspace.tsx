"use client";

import { assignEventLanes, eventSpan } from "./calendar-layout";
import type { CalendarEntry, CalendarProperty } from "./calendar-types";
import { addDays, format, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";

type EditorState = { property: CalendarProperty; entry?: CalendarEntry; startDate: string };

const dateString = (date: Date) => format(date, "yyyy-MM-dd");
const kindClass: Record<CalendarEntry["kind"], string> = {
  reservation: "reservation", unavailable: "unavailable", unknown: "unknown",
  direct_reservation: "direct", blocked: "blocked",
};

export function CalendarWorkspace({ properties, startDate, days, demoMode }: {
  properties: CalendarProperty[]; startDate: string; days: number; demoMode: boolean;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [filter, setFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [overlap, setOverlap] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const dates = useMemo(() => Array.from({ length: days }, (_, index) => addDays(parseISO(startDate), index)), [days, startDate]);
  const today = dateString(new Date());

  function navigate(nextStart: string, nextDays = days) {
    router.replace(`/calendar?start=${nextStart}&range=${nextDays}`);
  }

  function openEditor(property: CalendarProperty, date: string, entry?: CalendarEntry) {
    setEditor({ property, entry, startDate: date });
    setOverlap(false); setMessage("");
    dialog.current?.showModal();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    if (demoMode) { setMessage("Connect Supabase to save calendar changes."); return; }
    const data = new FormData(event.currentTarget);
    const status = String(data.get("entryType"));
    if (status === "available") {
      if (editor.entry?.source === "local") await archive(editor.entry.id);
      else dialog.current?.close();
      return;
    }
    const time = (name: string) => String(data.get(name) ?? "") || null;
    const durationValue = String(data.get("cleaningDurationMinutes") ?? "");
    if (editor.entry?.source === "airbnb") {
      const response = await fetch("/api/operation-overrides", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetType: "external", targetId: editor.entry.id, propertyId: editor.property.id,
          expectedCheckinTime: time("expectedCheckinTime"), expectedCheckoutTime: time("expectedCheckoutTime"),
          cleaningDurationMinutes: durationValue ? Number(durationValue) : null,
          operationalNote: time("privateNote") }),
      });
      if (!response.ok) { setMessage("Could not save the operational override."); return; }
    } else {
      const body = {
        ...(editor.entry ? { id: editor.entry.id } : {}), propertyId: editor.property.id,
        listingId: editor.entry?.listingId ?? null, entryType: status,
        startDate: String(data.get("startDate")), endDate: String(data.get("endDate")),
        privateBookingName: time("privateBookingName"), privateContact: time("privateContact"),
        privateNote: time("privateNote"), bookingSource: time("bookingSource"),
        syncToAirbnb: data.get("syncToAirbnb") === "on",
        expectedCheckinTime: time("expectedCheckinTime"), expectedCheckoutTime: time("expectedCheckoutTime"),
        cleaningDurationMinutes: durationValue ? Number(durationValue) : null,
        allowOverlap: data.get("allowOverlap") === "on",
      };
      const response = await fetch("/api/local-entries", {
        method: editor.entry ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (response.status === 409) { setOverlap(true); setMessage("This range overlaps another entry. Confirm the overlap to continue."); return; }
      if (!response.ok) { setMessage("Could not save this calendar entry."); return; }
    }
    dialog.current?.close();
    router.refresh();
  }

  async function archive(id: string) {
    if (demoMode) { setMessage("Connect Supabase to archive entries."); return; }
    const response = await fetch(`/api/local-entries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) { setMessage("Could not archive this entry."); return; }
    dialog.current?.close(); router.refresh();
  }

  async function refreshNow() {
    if (demoMode) { setMessage("Demo calendar refreshed."); return; }
    setSyncing(true); setMessage("");
    const response = await fetch("/api/sync/manual", { method: "POST" });
    setSyncing(false);
    setMessage(response.status === 429 ? "Refresh is cooling down. Try again in a minute." : response.ok ? "Calendar synchronized." : "Calendar refresh failed.");
    if (response.ok) router.refresh();
  }

  const shown = (entry: CalendarEntry) => filter === "all" ||
    (filter === "bookings" && ["reservation", "direct_reservation"].includes(entry.kind)) ||
    (filter === "blocks" && ["blocked", "unavailable"].includes(entry.kind));
  const syncText = (property: CalendarProperty) => property.lastSyncStatus === "failure"
    ? "Sync error"
    : property.isStale
      ? "Stale"
      : property.lastSyncAt
        ? `Synced ${formatInTimeZone(new Date(property.lastSyncAt), "Asia/Kolkata", "h:mm a")}`
        : "Not synced";

  return (
    <div className="workspace workspace--calendar">
      <header className="page-header calendar-header">
        <div><p className="eyebrow">Master schedule</p><h1>Calendar</h1></div>
        <div className="toolbar">
          <button className="icon-button" onClick={() => navigate(dateString(addDays(parseISO(startDate), -days)))} aria-label="Previous date range" title="Previous date range"><ChevronLeft /></button>
          <button className="button button--quiet" onClick={() => navigate(today)}><CalendarDays size={17} /> Today</button>
          <button className="icon-button" onClick={() => navigate(dateString(addDays(parseISO(startDate), days)))} aria-label="Next date range" title="Next date range"><ChevronRight /></button>
          <div className="segmented" aria-label="Calendar range">
            {[7, 14, 30, 90].map((range) => <button className={`${range === 7 ? "mobile-range" : ""} ${days === range ? "is-active" : ""}`} key={range} onClick={() => navigate(startDate, range)}>{range}d</button>)}
          </div>
          <select className="compact-select" aria-label="Filter calendar entries" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All entries</option><option value="bookings">Bookings</option><option value="blocks">Blocks</option></select>
          <button className="button button--primary" onClick={refreshNow} disabled={syncing}><RefreshCw className={syncing ? "spin" : ""} size={17} /> {syncing ? "Syncing..." : "Refresh now"}</button>
        </div>
      </header>
      {message && !editor ? <div className="notice" role="status">{message}</div> : null}
      <div className="calendar-key" aria-label="Calendar legend"><span><i className="key-airbnb" />Airbnb</span><span><i className="key-direct" />Direct</span><span><i className="key-blocked" />Blocked</span></div>
      <section className="calendar-scroller" aria-label={`${days}-day property calendar`}>
        <div className="calendar-table" style={{ "--day-count": days } as React.CSSProperties}>
          <div className="calendar-dates">
            <div className="property-heading">Property</div>
            <div className="date-strip">{dates.map((date) => { const value = dateString(date); return <div className={value === today ? "is-today" : ""} key={value}><span>{format(date, "EEE")}</span><strong>{format(date, "d")}</strong></div>; })}</div>
          </div>
          {properties.map((property) => {
            const entries = assignEventLanes(property.entries.filter(shown));
            const laneCount = Math.max(1, ...entries.map((entry) => entry.lane + 1));
            return <div className="calendar-property-row" key={property.id} style={{ "--lanes": laneCount } as React.CSSProperties}>
              <div className="property-sticky"><strong>{property.name}</strong><span className={property.lastSyncStatus === "failure" || property.isStale ? "sync-error" : ""}>{syncText(property)}</span></div>
              <div className="property-timeline">
                <div className="day-buttons">{dates.map((date) => { const value = dateString(date); return <button key={value} aria-label={`Add entry for ${property.name} on ${format(date, "d MMMM yyyy")}`} onClick={() => openEditor(property, value)} />; })}</div>
                <div className="event-layer">{entries.map((entry) => { const span = eventSpan(entry.startDate, entry.endDate, startDate, days); if (!span) return null; return <button key={entry.id} className={`calendar-event calendar-event--${kindClass[entry.kind]}`} style={{ gridColumn: `${span.column} / span ${span.span}`, top: `${entry.lane * 30 + 7}px` }} onClick={() => openEditor(property, entry.startDate, entry)} aria-label={`${entry.label}, ${entry.startDate} to ${entry.endDate}`}><span>{entry.privateBookingName || entry.label}</span></button>; })}</div>
              </div>
            </div>;
          })}
        </div>
        {!properties.length ? <div className="calendar-empty"><p>No properties yet.</p><a className="button button--primary" href="/properties">Add property</a></div> : null}
      </section>
      <dialog className="entry-dialog" ref={dialog} onClose={() => { setEditor(null); setMessage(""); }}>
        {editor ? <form onSubmit={submit}>
          <header><div><span>{editor.entry?.source === "airbnb" ? "Airbnb source" : editor.entry ? "Local entry" : "New entry"}</span><h2>{editor.property.name}</h2></div><button type="button" className="icon-button" aria-label="Close entry editor" onClick={() => dialog.current?.close()}><X size={18} /></button></header>
          {message ? <div className="notice" role="status">{message}</div> : null}
          <div className="form-grid editor-fields">
            <div className="field"><label>Status</label><select name="entryType" defaultValue={editor.entry?.kind ?? "blocked"} disabled={editor.entry?.source === "airbnb"}><option value="available">Available</option><option value="blocked">Blocked</option><option value="direct_reservation">Direct reservation</option>{editor.entry?.source === "airbnb" ? <option value={editor.entry.kind}>{editor.entry.label}</option> : null}</select></div>
            <div className="field"><label>Start date</label><input name="startDate" type="date" defaultValue={editor.entry?.startDate ?? editor.startDate} readOnly={editor.entry?.source === "airbnb"} required /></div>
            <div className="field"><label>End date</label><input name="endDate" type="date" defaultValue={editor.entry?.endDate ?? dateString(addDays(parseISO(editor.startDate), 1))} readOnly={editor.entry?.source === "airbnb"} required /></div>
            {editor.entry?.source !== "airbnb" ? <><div className="field"><label>Private booking label</label><input name="privateBookingName" defaultValue={editor.entry?.privateBookingName ?? ""} /></div><div className="field"><label>Private contact</label><input name="privateContact" defaultValue={editor.entry?.privateContact ?? ""} /></div><div className="field"><label>Booking source</label><input name="bookingSource" defaultValue="direct" /></div></> : null}
            <div className="field"><label>Expected check-in</label><input name="expectedCheckinTime" type="time" defaultValue={editor.entry?.expectedCheckinTime ?? editor.property.defaultCheckinTime} /></div>
            <div className="field"><label>Expected checkout</label><input name="expectedCheckoutTime" type="time" defaultValue={editor.entry?.expectedCheckoutTime ?? editor.property.defaultCheckoutTime} /></div>
            <div className="field"><label>Cleaning minutes</label><input name="cleaningDurationMinutes" type="number" min="5" max="480" defaultValue={editor.entry?.cleaningDurationMinutes ?? editor.property.defaultCleaningMinutes} /></div>
            <div className="field field--wide"><label>Private operational note</label><textarea name="privateNote" defaultValue={editor.entry?.privateNote ?? ""} /></div>
          </div>
          {editor.entry?.source !== "airbnb" ? <div className="toggle-stack"><label className="toggle"><input name="syncToAirbnb" type="checkbox" defaultChecked={editor.entry?.syncToAirbnb} /><span />Block on Airbnb</label>{editor.entry?.syncToAirbnb ? <span className={`status ${editor.entry.airbnbObserved ? "status--safe" : "status--waiting"}`}>{editor.entry.airbnbObserved ? "Observed on Airbnb" : "Pending Airbnb refresh"}</span> : null}{overlap ? <label className="toggle toggle--warning"><input name="allowOverlap" type="checkbox" /><span />Confirm overlapping entry</label> : null}</div> : <p className="source-lock">Airbnb dates cannot be cancelled or made available here.</p>}
          {editor.entry?.reservationUrl ? <a className="source-link" href={editor.entry.reservationUrl} target="_blank" rel="noreferrer">Open Airbnb reservation <ExternalLink size={14} /></a> : null}
          <footer>{editor.entry?.source === "local" ? <button className="button button--danger" type="button" onClick={() => archive(editor.entry!.id)}>Archive</button> : <span /> }<button className="button button--primary" type="submit">Save</button></footer>
        </form> : null}
      </dialog>
    </div>
  );
}
