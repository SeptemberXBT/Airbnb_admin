"use client";

import { assignEventLanes, eventSpan } from "./calendar-layout";
import { mergeCalendarWindows, trimCalendarWindow } from "./calendar-window";
import type { CalendarEntry, CalendarProperty } from "./calendar-types";
import { calculateVacancy, type VacancySummary } from "./vacancy";
import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
  subDays,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type EditorState = { property: CalendarProperty; entry?: CalendarEntry; startDate: string };
type VacancyPanel = { kind: "day"; date: string } | { kind: "summary" };
type WindowResponse = { startDate: string; days: number; properties: CalendarProperty[] };

const CHUNK_DAYS = 28;
const MAX_WINDOW_DAYS = 168;
const dateString = (date: Date) => format(date, "yyyy-MM-dd");
const kindClass: Record<CalendarEntry["kind"], string> = {
  reservation: "reservation", unavailable: "unavailable", unknown: "unknown",
  direct_reservation: "direct", blocked: "blocked",
};

export function CalendarWorkspace({ properties: initialProperties, startDate, anchorDate, zoom, demoMode }: {
  properties: CalendarProperty[];
  startDate: string;
  anchorDate: string;
  zoom: 14 | 30;
  demoMode: boolean;
}) {
  const editorDialog = useRef<HTMLDialogElement>(null);
  const vacancyDialog = useRef<HTMLDialogElement>(null);
  const exportDialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const loadingRef = useRef(false);
  const mutationRef = useRef(false);
  const [properties, setProperties] = useState(initialProperties);
  const [windowStart, setWindowStart] = useState(startDate);
  const [dayCount, setDayCount] = useState(CHUNK_DAYS);
  const [calendarZoom, setCalendarZoom] = useState<14 | 30>(zoom);
  const [visibleDate, setVisibleDate] = useState(anchorDate);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [filter, setFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [overlap, setOverlap] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [mutationPending, setMutationPending] = useState<"save" | "archive" | "">("");
  const [loadingDirection, setLoadingDirection] = useState<"previous" | "next" | "jump" | "">("");
  const [vacancyPanel, setVacancyPanel] = useState<VacancyPanel | null>(null);
  const [summaryStart, setSummaryStart] = useState(dateString(subDays(new Date(), 6)));
  const [summaryEnd, setSummaryEnd] = useState(dateString(new Date()));
  const [summary, setSummary] = useState<VacancySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [exportStart, setExportStart] = useState(anchorDate);
  const [exportEnd, setExportEnd] = useState(dateString(addDays(parseISO(anchorDate), zoom - 1)));
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState("");
  const dates = useMemo(() => Array.from({ length: dayCount }, (_, index) => addDays(parseISO(windowStart), index)), [dayCount, windowStart]);
  const today = dateString(new Date());
  const vacancy = useMemo(() => calculateVacancy(properties, windowStart, dateString(addDays(parseISO(windowStart), dayCount - 1))), [dayCount, properties, windowStart]);
  const propertiesById = useMemo(() => new Map(properties.map((property) => [property.id, property])), [properties]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const cell = scroller.current?.querySelector<HTMLElement>(".date-strip > div");
      if (cell && scroller.current) scroller.current.scrollLeft = 7 * cell.getBoundingClientRect().width;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function cellWidth() {
    return scroller.current?.querySelector<HTMLElement>(".date-strip > div")?.getBoundingClientRect().width ?? 52;
  }

  function updateLocation(date: string, nextZoom = calendarZoom) {
    setVisibleDate(date);
    const url = new URL(window.location.href);
    url.searchParams.set("start", date);
    url.searchParams.set("zoom", String(nextZoom));
    window.history.replaceState(null, "", url);
  }

  async function fetchWindow(start: string) {
    const response = await fetch(`/api/calendar-window?start=${encodeURIComponent(start)}`);
    if (!response.ok) throw new Error("WINDOW_FAILED");
    return response.json() as Promise<WindowResponse>;
  }

  async function extendWindow(direction: "previous" | "next") {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingDirection(direction);
    setMessage("");
    const width = cellWidth();
    try {
      const requestedStart = direction === "previous"
        ? dateString(addDays(parseISO(windowStart), -CHUNK_DAYS))
        : dateString(addDays(parseISO(windowStart), dayCount));
      const incoming = await fetchWindow(requestedStart);
      let nextStart = direction === "previous" ? requestedStart : windowStart;
      let nextCount = dayCount + CHUNK_DAYS;
      let scrollAdjustment = direction === "previous" ? CHUNK_DAYS * width : 0;
      if (nextCount > MAX_WINDOW_DAYS) {
        nextCount -= CHUNK_DAYS;
        if (direction === "next") {
          nextStart = dateString(addDays(parseISO(windowStart), CHUNK_DAYS));
          scrollAdjustment -= CHUNK_DAYS * width;
        }
      }
      const nextEnd = dateString(addDays(parseISO(nextStart), nextCount));
      setProperties(trimCalendarWindow(mergeCalendarWindows(properties, incoming.properties), nextStart, nextEnd));
      setWindowStart(nextStart);
      setDayCount(nextCount);
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollLeft += scrollAdjustment;
      });
    } catch {
      setMessage("Could not load more dates. Scroll or use the arrow to retry.");
    } finally {
      loadingRef.current = false;
      setLoadingDirection("");
    }
  }

  async function jumpTo(date: string) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingDirection("jump");
    setMessage("");
    try {
      const nextStart = dateString(addDays(parseISO(date), -7));
      const incoming = await fetchWindow(nextStart);
      setProperties(incoming.properties);
      setWindowStart(nextStart);
      setDayCount(CHUNK_DAYS);
      updateLocation(date);
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollLeft = 7 * cellWidth();
      });
    } catch {
      setMessage("Could not jump to that date. Try again.");
    } finally {
      loadingRef.current = false;
      setLoadingDirection("");
    }
  }

  function handleScroll() {
    const element = scroller.current;
    if (!element) return;
    const width = cellWidth();
    const index = Math.max(0, Math.min(dayCount - 1, Math.floor(element.scrollLeft / width)));
    updateLocation(dateString(addDays(parseISO(windowStart), index)));
    if (element.scrollLeft < width * 4) void extendWindow("previous");
    else if (element.scrollWidth - element.clientWidth - element.scrollLeft < width * 4) void extendWindow("next");
  }

  function moveViewport(direction: -1 | 1) {
    const element = scroller.current;
    if (!element) return;
    element.scrollBy({ left: direction * calendarZoom * cellWidth(), behavior: "smooth" });
  }

  function changeZoom(nextZoom: 14 | 30) {
    setCalendarZoom(nextZoom);
    updateLocation(visibleDate, nextZoom);
  }

  function openEditor(property: CalendarProperty, date: string, entry?: CalendarEntry) {
    setEditor({ property, entry, startDate: date });
    setOverlap(false);
    setMessage("");
    editorDialog.current?.showModal();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    if (demoMode) { setMessage("Connect Supabase to save calendar changes."); return; }
    const data = new FormData(event.currentTarget);
    const status = String(data.get("entryType"));
    if (status === "available") {
      if (editor.entry?.source === "local") await archive(editor.entry.id);
      else editorDialog.current?.close();
      return;
    }
    if (mutationRef.current) return;
    mutationRef.current = true;
    setMutationPending("save");
    const time = (name: string) => String(data.get(name) ?? "") || null;
    const durationValue = String(data.get("cleaningDurationMinutes") ?? "");
    const paymentValue = String(data.get("paymentAmount") ?? "");
    try {
      if (editor.entry?.source === "airbnb") {
        const response = await fetch("/api/operation-overrides", {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetType: "external", targetId: editor.entry.id, propertyId: editor.property.id,
            expectedCheckinTime: time("expectedCheckinTime"), expectedCheckoutTime: time("expectedCheckoutTime"),
            cleaningDurationMinutes: durationValue ? Number(durationValue) : null, operationalNote: time("privateNote") }),
        });
        if (!response.ok) { setMessage("Could not save the operational override."); return; }
      } else {
        const body = {
          ...(editor.entry ? { id: editor.entry.id } : {}), propertyId: editor.property.id,
          listingId: editor.entry?.listingId ?? null, entryType: status,
          startDate: String(data.get("startDate")), endDate: String(data.get("endDate")),
          privateBookingName: time("privateBookingName"), privateContact: time("privateContact"),
          paymentAmount: paymentValue ? Number(paymentValue) : null,
          privateNote: time("privateNote"), bookingSource: time("bookingSource"),
          syncToAirbnb: data.get("syncToAirbnb") === "on", expectedCheckinTime: time("expectedCheckinTime"),
          expectedCheckoutTime: time("expectedCheckoutTime"), cleaningDurationMinutes: durationValue ? Number(durationValue) : null,
          allowOverlap: data.get("allowOverlap") === "on",
        };
        const response = await fetch("/api/local-entries", {
          method: editor.entry ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (response.status === 409) { setOverlap(true); setMessage("This range overlaps another entry. Confirm the overlap to continue."); return; }
        if (!response.ok) { setMessage("Could not save this calendar entry."); return; }
      }
      editorDialog.current?.close();
      await jumpTo(visibleDate);
    } catch {
      setMessage("Could not save this calendar entry.");
    } finally {
      mutationRef.current = false;
      setMutationPending("");
    }
  }

  async function archive(id: string) {
    if (demoMode) { setMessage("Connect Supabase to archive entries."); return; }
    if (mutationRef.current) return;
    mutationRef.current = true;
    setMutationPending("archive");
    try {
      const response = await fetch(`/api/local-entries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) { setMessage("Could not archive this entry."); return; }
      editorDialog.current?.close();
      await jumpTo(visibleDate);
    } catch {
      setMessage("Could not archive this entry.");
    } finally {
      mutationRef.current = false;
      setMutationPending("");
    }
  }

  async function refreshNow() {
    if (demoMode) { setMessage("Demo calendar refreshed."); return; }
    setSyncing(true);
    setMessage("");
    const response = await fetch("/api/sync/manual", { method: "POST" });
    setSyncing(false);
    setMessage(response.status === 429 ? "Refresh is cooling down. Try again in a minute." : response.ok ? "Calendar synchronized." : "Calendar refresh failed.");
    if (response.ok) await jumpTo(visibleDate);
  }

  function openExport() {
    setExportStart(visibleDate);
    setExportEnd(dateString(addDays(parseISO(visibleDate), calendarZoom - 1)));
    setExportError("");
    exportDialog.current?.showModal();
  }

  async function downloadExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (exportPending) return;
    setExportPending(true);
    setExportError("");
    try {
      const response = await fetch(`/api/manual-bookings-export?start=${encodeURIComponent(exportStart)}&end=${encodeURIComponent(exportEnd)}`);
      if (!response.ok) { setExportError("Could not export that date range."); return; }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `noir-haus-manual-bookings-${exportStart}-to-${exportEnd}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      exportDialog.current?.close();
    } catch {
      setExportError("Could not export that date range.");
    } finally {
      setExportPending(false);
    }
  }

  const shown = (entry: CalendarEntry) => filter === "all"
    || (filter === "bookings" && ["reservation", "direct_reservation"].includes(entry.kind))
    || (filter === "blocks" && ["blocked", "unavailable", "unknown"].includes(entry.kind));
  const syncText = (property: CalendarProperty) => property.lastSyncStatus === "failure"
    ? "Sync error"
    : property.isStale
      ? "Stale"
      : property.lastSyncAt
        ? `Synced ${formatInTimeZone(new Date(property.lastSyncAt), "Asia/Kolkata", "h:mm a")}`
        : "Not synced";

  function showVacancyPanel(panel: VacancyPanel) {
    setVacancyPanel(panel);
    requestAnimationFrame(() => vacancyDialog.current?.showModal());
  }

  async function loadSummary(start: string, end: string) {
    setSummaryLoading(true);
    setMessage("");
    const response = await fetch(`/api/vacancy-summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    setSummaryLoading(false);
    if (!response.ok) { setSummary(null); setMessage("Could not calculate vacancy for that range."); return; }
    setSummary(await response.json() as VacancySummary);
  }

  function openSummary() {
    const end = today;
    const start = dateString(subDays(parseISO(end), 6));
    setSummaryStart(start);
    setSummaryEnd(end);
    showVacancyPanel({ kind: "summary" });
    void loadSummary(start, end);
  }

  function applySummaryRange(start: string, end: string) {
    setSummaryStart(start);
    setSummaryEnd(end);
    void loadSummary(start, end);
  }

  const selectedVacancy = vacancyPanel?.kind === "day"
    ? vacancy.byDate.find((day) => day.date === vacancyPanel.date)
    : null;

  return (
    <div className="workspace workspace--calendar">
      <header className="page-header calendar-header">
        <div><p className="eyebrow">Master schedule</p><h1>Calendar</h1></div>
        <div className="toolbar calendar-toolbar">
          <button className="icon-button" onClick={() => moveViewport(-1)} aria-label="Previous dates" title="Previous dates"><ChevronLeft /></button>
          <button className="button button--quiet" onClick={() => void jumpTo(today)}><CalendarDays size={17} /> Today</button>
          <button className="icon-button" onClick={() => moveViewport(1)} aria-label="Next dates" title="Next dates"><ChevronRight /></button>
          <label className="date-jump"><span>Jump to date</span><input type="date" value={visibleDate} onChange={(event) => void jumpTo(event.target.value)} /></label>
          <div className="segmented" aria-label="Calendar zoom">
            {[14, 30].map((value) => <button className={calendarZoom === value ? "is-active" : ""} key={value} onClick={() => changeZoom(value as 14 | 30)}>{value}d</button>)}
          </div>
          <select className="compact-select" aria-label="Filter calendar entries" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All entries</option><option value="bookings">Bookings</option><option value="blocks">Blocks</option></select>
          <button className="button button--quiet" type="button" onClick={openExport}><Download size={17} /> Export CSV</button>
          <button className="button button--primary" onClick={refreshNow} disabled={syncing}><RefreshCw className={syncing ? "spin" : ""} size={17} /> {syncing ? "Syncing..." : "Refresh now"}</button>
        </div>
      </header>
      {message ? <div className="notice" role="status">{message}</div> : null}
      <div className="calendar-key" aria-label="Calendar legend"><span><i className="key-airbnb" />Airbnb</span><span><i className="key-direct" />Direct</span><span><i className="key-blocked" />Blocked</span></div>
      <section className="calendar-scroller" ref={scroller} onScroll={handleScroll} aria-label="Infinite property calendar">
        <div className={`calendar-table calendar-table--${calendarZoom}`} style={{ "--day-count": dayCount, "--calendar-zoom": calendarZoom } as React.CSSProperties}>
          <div className="calendar-dates">
            <div className="property-heading">Property</div>
            <div className="date-strip">{dates.map((date) => { const value = dateString(date); return <div className={`${value === today ? "is-today" : ""} ${[0, 6].includes(date.getDay()) ? "is-weekend" : ""}`} key={value}><span>{format(date, "EEE")}</span><strong>{format(date, "d")}</strong><small>{format(date, "MMM")}</small></div>; })}</div>
          </div>
          {properties.map((property) => {
            const entries = assignEventLanes(property.entries.filter(shown));
            const laneCount = Math.max(1, ...entries.map((entry) => entry.lane + 1));
            return <div className="calendar-property-row" key={property.id} style={{ "--lanes": laneCount } as React.CSSProperties}>
              <div className="property-sticky"><strong>{property.name}</strong><span className={property.lastSyncStatus === "failure" || property.isStale ? "sync-error" : ""}>{syncText(property)}</span></div>
              <div className="property-timeline">
                <div className="day-buttons">{dates.map((date) => { const value = dateString(date); return <button key={value} aria-label={`Add entry for ${property.name} on ${format(date, "d MMMM yyyy")}`} onClick={() => openEditor(property, value)} />; })}</div>
                <div className="event-layer">{entries.map((entry) => { const span = eventSpan(entry.startDate, entry.endDate, windowStart, dayCount); if (!span) return null; return <button key={entry.id} className={`calendar-event calendar-event--${kindClass[entry.kind]}`} style={{ gridColumn: `${span.column} / span ${span.span}`, top: `${entry.lane * 30 + 7}px` }} onClick={() => openEditor(property, entry.startDate, entry)} aria-label={`${entry.label}, ${entry.startDate} to ${entry.endDate}`} title={entry.privateBookingName || entry.label}><span>{entry.privateBookingName || entry.label}</span></button>; })}</div>
              </div>
            </div>;
          })}
          <div className="calendar-property-row vacancy-row">
            <div className="property-sticky vacancy-heading"><button type="button" onClick={openSummary}><BarChart3 size={16} /><span><strong>Vacant rooms</strong><small>Range summary</small></span></button></div>
            <div className="vacancy-timeline">{vacancy.byDate.map((day) => <button type="button" key={day.date} onClick={() => showVacancyPanel({ kind: "day", date: day.date })} aria-label={`${day.vacantPropertyIds.length} vacant rooms on ${day.date}`}><strong>{day.vacantPropertyIds.length}</strong>{day.stalePropertyIds.length ? <AlertTriangle size={10} /> : null}</button>)}</div>
          </div>
        </div>
        {loadingDirection ? <div className="calendar-loading" role="status"><RefreshCw className="spin" size={15} /> Loading {loadingDirection === "previous" ? "earlier" : loadingDirection === "next" ? "later" : "selected"} dates</div> : null}
        {!properties.length ? <div className="calendar-empty"><p>No properties yet.</p><a className="button button--primary" href="/properties">Add property</a></div> : null}
      </section>

      <dialog className="entry-dialog" ref={editorDialog} onClose={() => { setEditor(null); setMessage(""); }}>
        {editor ? <form onSubmit={submit}>
          <header><div><span>{editor.entry?.source === "airbnb" ? "Airbnb source" : editor.entry ? "Local entry" : "New entry"}</span><h2>{editor.property.name}</h2></div><button type="button" className="icon-button" aria-label="Close entry editor" onClick={() => editorDialog.current?.close()}><X size={18} /></button></header>
          {message ? <div className="notice" role="status">{message}</div> : null}
          <div className="form-grid editor-fields">
            <div className="field"><label>Status</label><select name="entryType" defaultValue={editor.entry?.kind ?? "blocked"} disabled={editor.entry?.source === "airbnb"}><option value="available">Available</option><option value="blocked">Blocked</option><option value="direct_reservation">Direct reservation</option>{editor.entry?.source === "airbnb" ? <option value={editor.entry.kind}>{editor.entry.label}</option> : null}</select></div>
            <div className="field"><label>Start date</label><input name="startDate" type="date" defaultValue={editor.entry?.startDate ?? editor.startDate} readOnly={editor.entry?.source === "airbnb"} required /></div>
            <div className="field"><label>End date</label><input name="endDate" type="date" defaultValue={editor.entry?.endDate ?? dateString(addDays(parseISO(editor.startDate), 1))} readOnly={editor.entry?.source === "airbnb"} required /></div>
            {editor.entry?.source !== "airbnb" ? <><div className="field"><label htmlFor="entry-guest-name">Guest name</label><input id="entry-guest-name" name="privateBookingName" defaultValue={editor.entry?.privateBookingName ?? ""} /></div><div className="field"><label htmlFor="entry-payment">Total payment (INR)</label><input id="entry-payment" name="paymentAmount" type="number" min="0" max="9999999999.99" step="0.01" inputMode="decimal" defaultValue={editor.entry?.paymentAmount ?? ""} /></div><div className="field"><label>Private contact</label><input name="privateContact" defaultValue={editor.entry?.privateContact ?? ""} /></div><div className="field"><label>Booking source</label><input name="bookingSource" defaultValue="direct" /></div></> : null}
            <div className="field"><label>Expected check-in</label><input name="expectedCheckinTime" type="time" defaultValue={editor.entry?.expectedCheckinTime ?? editor.property.defaultCheckinTime} /></div>
            <div className="field"><label>Expected checkout</label><input name="expectedCheckoutTime" type="time" defaultValue={editor.entry?.expectedCheckoutTime ?? editor.property.defaultCheckoutTime} /></div>
            <div className="field"><label>Cleaning minutes</label><input name="cleaningDurationMinutes" type="number" min="5" max="480" defaultValue={editor.entry?.cleaningDurationMinutes ?? editor.property.defaultCleaningMinutes} /></div>
            <div className="field field--wide"><label>Private operational note</label><textarea name="privateNote" defaultValue={editor.entry?.privateNote ?? ""} /></div>
          </div>
          {editor.entry?.source !== "airbnb" ? <div className="toggle-stack"><label className="toggle"><input name="syncToAirbnb" type="checkbox" defaultChecked={editor.entry?.syncToAirbnb} /><span />Block on Airbnb</label>{editor.entry?.syncToAirbnb ? <span className={`status ${editor.entry.airbnbObserved ? "status--safe" : "status--waiting"}`}>{editor.entry.airbnbObserved ? "Observed on Airbnb" : "Pending Airbnb refresh"}</span> : null}{overlap ? <label className="toggle toggle--warning"><input name="allowOverlap" type="checkbox" /><span />Confirm overlapping entry</label> : null}</div> : <p className="source-lock">Airbnb dates cannot be cancelled or made available here.</p>}
          {editor.entry?.reservationUrl ? <a className="source-link" href={editor.entry.reservationUrl} target="_blank" rel="noreferrer">Open Airbnb reservation <ExternalLink size={14} /></a> : null}
          <footer>{editor.entry?.source === "local" ? <button className="button button--danger" type="button" disabled={Boolean(mutationPending)} onClick={() => archive(editor.entry!.id)}>{mutationPending === "archive" ? <RefreshCw className="spin" size={15} /> : null} {mutationPending === "archive" ? "Archiving..." : "Archive"}</button> : <span /> }<button className="button button--primary" type="submit" disabled={Boolean(mutationPending)}>{mutationPending === "save" ? <RefreshCw className="spin" size={15} /> : null} {mutationPending === "save" ? "Saving..." : "Save"}</button></footer>
        </form> : null}
      </dialog>

      <dialog className="export-dialog" ref={exportDialog} onClose={() => setExportError("")}>
        <form onSubmit={downloadExport}>
          <header><div><span>Private report</span><h2>Export manual bookings</h2></div><button type="button" className="icon-button" aria-label="Close export dialog" onClick={() => exportDialog.current?.close()}><X size={18} /></button></header>
          {exportError ? <div className="notice" role="status">{exportError}</div> : null}
          <div className="form-grid export-fields"><div className="field"><label>Start date<input type="date" value={exportStart} onChange={(event) => setExportStart(event.target.value)} required /></label></div><div className="field"><label>End date<input type="date" value={exportEnd} onChange={(event) => setExportEnd(event.target.value)} required /></label></div></div>
          <footer><span /><button className="button button--primary" type="submit" disabled={exportPending}>{exportPending ? <RefreshCw className="spin" size={16} /> : <Download size={16} />} {exportPending ? "Preparing..." : "Download CSV"}</button></footer>
        </form>
      </dialog>

      <dialog className="vacancy-dialog" ref={vacancyDialog} onClose={() => setVacancyPanel(null)}>
        <header><div><span>{vacancyPanel?.kind === "day" ? "Night availability" : "Vacancy analysis"}</span><h2>{vacancyPanel?.kind === "day" ? format(parseISO(vacancyPanel.date), "EEEE, d MMMM") : "Vacant room-nights"}</h2></div><button className="icon-button" type="button" aria-label="Close vacancy details" onClick={() => vacancyDialog.current?.close()}><X size={18} /></button></header>
        {vacancyPanel?.kind === "day" ? <div className="vacancy-day-list">
          <p><strong>{selectedVacancy?.vacantPropertyIds.length ?? 0}</strong> properties have no reservation or block.</p>
          {(selectedVacancy?.vacantPropertyIds ?? []).map((id) => { const property = propertiesById.get(id); return <div key={id}><span>{property?.name}</span>{property?.isStale ? <small><AlertTriangle size={12} /> Stale calendar</small> : <small>Available</small>}</div>; })}
          {!selectedVacancy?.vacantPropertyIds.length ? <div className="list-empty">No vacant properties</div> : null}
        </div> : <div className="vacancy-summary">
          <div className="summary-presets">
            <button className="button button--quiet" type="button" onClick={() => applySummaryRange(dateString(subDays(parseISO(today), 6)), today)}>Last 7 nights</button>
            <button className="button button--quiet" type="button" onClick={() => applySummaryRange(dateString(subDays(parseISO(today), 13)), today)}>Last 14 nights</button>
            <button className="button button--quiet" type="button" onClick={() => { const prior = subDays(startOfWeek(parseISO(today), { weekStartsOn: 1 }), 1); applySummaryRange(dateString(startOfWeek(prior, { weekStartsOn: 1 })), dateString(endOfWeek(prior, { weekStartsOn: 1 }))); }}>Previous week</button>
            <label className="month-picker"><span>Month</span><input type="month" onChange={(event) => { if (!event.target.value) return; const month = parseISO(`${event.target.value}-01`); applySummaryRange(dateString(startOfMonth(month)), dateString(endOfMonth(month))); }} /></label>
          </div>
          <form className="summary-range" onSubmit={(event) => { event.preventDefault(); void loadSummary(summaryStart, summaryEnd); }}><div className="field"><label>Start night</label><input type="date" value={summaryStart} onChange={(event) => setSummaryStart(event.target.value)} required /></div><div className="field"><label>End night</label><input type="date" value={summaryEnd} onChange={(event) => setSummaryEnd(event.target.value)} required /></div><button className="button button--primary" type="submit">Calculate</button></form>
          {summaryLoading ? <div className="summary-loading"><RefreshCw className="spin" size={16} /> Calculating vacancy</div> : summary ? <>
            {summary.hasStaleData ? <div className="notice notice--warning"><AlertTriangle size={15} /> Includes last-known data from stale calendars.</div> : null}
            <div className="vacancy-total"><span>Total vacant room-nights</span><strong>{summary.totalVacantRoomNights}</strong><small>{format(parseISO(summary.startDate), "d MMM yyyy")} – {format(parseISO(summary.endDate), "d MMM yyyy")}</small></div>
            <div className="vacancy-breakdown">{summary.byProperty.map((property) => <div key={property.propertyId}><span>{property.propertyName}{property.isStale ? <AlertTriangle size={12} /> : null}</span><strong>{property.vacantNights} nights</strong></div>)}</div>
          </> : null}
        </div>}
      </dialog>
    </div>
  );
}
