"use client";

import { Building2, Check, Copy, Link2, PauseCircle, PlayCircle, Plus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { PropertySummary } from "./property-service";

const defaults = {
  timezone: "Asia/Kolkata",
  defaultCleaningMinutes: 15,
  checkoutBufferMinutes: 5,
};

function formPayload(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    name: String(data.get("name")),
    displayName: String(data.get("displayName")),
    timezone: "Asia/Kolkata",
    defaultCleaningMinutes: Number(data.get("defaultCleaningMinutes")),
    checkoutBufferMinutes: Number(data.get("checkoutBufferMinutes")),
    checkinBufferMinutes: 5,
    inboundIcalUrl: String(data.get("inboundIcalUrl")),
  };
}

function PropertyFields({ property }: { property?: PropertySummary }) {
  return (
    <div className="form-grid">
      <div className="field"><label>Property name</label><input name="name" defaultValue={property?.name} required minLength={2} /></div>
      <div className="field"><label>Airbnb listing name</label><input name="displayName" defaultValue={property?.listingName} required minLength={2} /></div>
      <div className="field field--wide"><label>Private Airbnb iCal URL</label><input name="inboundIcalUrl" type="url" inputMode="url" placeholder={property ? "Paste a new URL to replace the stored feed" : "https://www.airbnb.com/calendar/ical/..."} required /></div>
      <div className="field field--wide"><label>Standard guest times</label><div className="fixed-defaults"><span>Checkout <strong>11:00 AM</strong></span><span>Check-in <strong>1:00 PM</strong></span></div></div>
      <div className="field"><label>Cleaning minutes</label><input name="defaultCleaningMinutes" type="number" min="5" max="480" defaultValue={property?.defaultCleaningMinutes ?? defaults.defaultCleaningMinutes} required /></div>
      <div className="field"><label>Checkout buffer</label><input name="checkoutBufferMinutes" type="number" min="0" max="120" defaultValue={defaults.checkoutBufferMinutes} required /></div>
    </div>
  );
}

function propertyStatus(property: PropertySummary) {
  if (!property.inboundIcalConnected) {
    return { className: "status--impossible", label: "iCal required" };
  }
  if (property.lastSyncStatus === "failure") {
    return { className: "status--impossible", label: "Sync error" };
  }
  return { className: "status--safe", label: "Active" };
}

export function PropertyManager({ initialProperties, demoMode }: { initialProperties: PropertySummary[]; demoMode: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [outboundUrl, setOutboundUrl] = useState("");
  const [properties, setProperties] = useState(initialProperties);
  const [savingKey, setSavingKey] = useState("");
  const savingRef = useRef(false);
  const creationRequestId = useRef(crypto.randomUUID());

  async function reloadProperties() {
    const response = await fetch("/api/properties", { cache: "no-store" });
    if (!response.ok) return;
    const result = await response.json() as { properties: PropertySummary[] };
    setProperties(result.properties);
  }

  async function submit(event: FormEvent<HTMLFormElement>, property?: PropertySummary) {
    event.preventDefault();
    if (demoMode) { setMessage("Connect Supabase to save property changes."); return; }
    if (savingRef.current) return;
    const form = event.currentTarget;
    const key = property ? `edit:${property.id}` : "create";
    savingRef.current = true;
    setSavingKey(key);
    setMessage("");
    try {
      const body = { ...formPayload(form), ...(property ? { propertyId: property.id, listingId: property.listingId } : { creationRequestId: creationRequestId.current }) };
      const response = await fetch("/api/properties", { method: property ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setMessage("Could not save this property. Check every field."); return; }
      setMessage(property ? "Property updated." : result.duplicate ? "Property already created." : "Property created.");
      if (result.outboundUrl) setOutboundUrl(result.outboundUrl);
      form.reset();
      const disclosure = form.closest("details");
      if (disclosure) disclosure.open = false;
      if (!property) creationRequestId.current = crypto.randomUUID();
      await reloadProperties();
      router.refresh();
    } finally {
      savingRef.current = false;
      setSavingKey("");
    }
  }

  async function rotateFeed(property: PropertySummary) {
    if (demoMode) { setMessage("Connect Supabase to rotate outbound feeds."); return; }
    if (savingRef.current) return;
    savingRef.current = true; setSavingKey(`rotate:${property.id}`);
    try {
      const response = await fetch("/api/listings/outbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listingId: property.listingId }) });
      const result = await response.json();
      if (!response.ok) { setMessage("Could not rotate the outbound feed."); return; }
      setOutboundUrl(result.outboundUrl); setMessage("Previous outbound link disabled. New link ready.");
      await reloadProperties(); router.refresh();
    } finally { savingRef.current = false; setSavingKey(""); }
  }

  async function toggleFeed(property: PropertySummary) {
    if (demoMode) { setMessage("Connect Supabase to change outbound feeds."); return; }
    if (savingRef.current) return;
    savingRef.current = true; setSavingKey(`toggle:${property.id}`);
    try {
      const response = await fetch("/api/listings/outbound", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ listingId: property.listingId, enabled: !property.outboundEnabled }) });
      setMessage(response.ok ? `Outbound feed ${property.outboundEnabled ? "disabled" : "enabled"}.` : "Could not change the outbound feed.");
      if (response.ok) { await reloadProperties(); router.refresh(); }
    } finally { savingRef.current = false; setSavingKey(""); }
  }

  return (
    <>
      {message ? <div className="notice" role="status">{message}</div> : null}
      {outboundUrl ? <div className="outbound-result"><div><strong>Outbound Airbnb feed</strong><code>{outboundUrl}</code><small>Import this URL in the Airbnb listing&apos;s calendar settings. It is shown only once.</small></div><button className="icon-button" title="Copy outbound feed URL" aria-label="Copy outbound feed URL" onClick={() => navigator.clipboard.writeText(outboundUrl)}><Copy size={18} /></button></div> : null}
      <details className="form-panel">
        <summary><Plus size={18} /> Add property</summary>
        <form onSubmit={(event) => submit(event)}>
          <PropertyFields />
          <div className="form-actions"><button className="button button--primary" disabled={savingKey === "create"} type="submit">{savingKey === "create" ? <RefreshCw className="spin" size={16} /> : <Check size={16} />} Save property</button></div>
        </form>
      </details>
      <div className="property-list">
        {properties.map((property) => (
          <article className="property-row" key={property.listingId}>
            <div className="property-icon"><Building2 aria-hidden="true" size={20} /></div>
            <div className="property-main"><strong>{property.name}</strong><span>{property.listingName}</span></div>
            <div className="property-default"><span>Checkout</span><strong>{property.defaultCheckoutTime}</strong></div>
            <div className="property-default"><span>Check-in</span><strong>{property.defaultCheckinTime}</strong></div>
            <span className={`status ${propertyStatus(property).className}`}>{propertyStatus(property).label}</span>
            <div className="feed-actions"><button className="icon-button" type="button" title="Rotate outbound feed link" aria-label={`Rotate outbound feed for ${property.name}`} disabled={savingKey === `rotate:${property.id}`} onClick={() => rotateFeed(property)}><Link2 size={17} /></button><button className="icon-button" type="button" title={property.outboundEnabled ? "Disable outbound feed" : "Enable outbound feed"} aria-label={`${property.outboundEnabled ? "Disable" : "Enable"} outbound feed for ${property.name}`} disabled={savingKey === `toggle:${property.id}`} onClick={() => toggleFeed(property)}>{property.outboundEnabled ? <PauseCircle size={17} /> : <PlayCircle size={17} />}</button></div>
            <details className="row-editor"><summary className="button button--quiet">Edit</summary><form onSubmit={(event) => submit(event, property)}><PropertyFields property={property} /><div className="form-actions"><button className="button button--primary" disabled={savingKey === `edit:${property.id}`} type="submit">{savingKey === `edit:${property.id}` ? <RefreshCw className="spin" size={16} /> : <Check size={16} />} Save changes</button></div></form></details>
          </article>
        ))}
        {!properties.length ? <div className="list-empty"><Building2 size={24} /><span>No properties yet</span></div> : null}
      </div>
    </>
  );
}
