"use client";

import { Building2, Check, Copy, Link2, PauseCircle, PlayCircle, Plus, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { PropertySummary } from "./property-service";

const defaults = {
  timezone: "Asia/Kolkata",
  defaultCheckinTime: "13:00",
  defaultCheckoutTime: "11:00",
  defaultCleaningMinutes: 15,
  checkoutBufferMinutes: 5,
  checkinBufferMinutes: 5,
};

function formPayload(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    name: String(data.get("name")),
    displayName: String(data.get("displayName")),
    timezone: "Asia/Kolkata",
    defaultCheckinTime: String(data.get("defaultCheckinTime")),
    defaultCheckoutTime: String(data.get("defaultCheckoutTime")),
    defaultCleaningMinutes: Number(data.get("defaultCleaningMinutes")),
    checkoutBufferMinutes: Number(data.get("checkoutBufferMinutes")),
    checkinBufferMinutes: Number(data.get("checkinBufferMinutes")),
    inboundIcalUrl: String(data.get("inboundIcalUrl")),
  };
}

function PropertyFields({ property }: { property?: PropertySummary }) {
  return (
    <div className="form-grid">
      <div className="field"><label>Property name</label><input name="name" defaultValue={property?.name} required minLength={2} /></div>
      <div className="field"><label>Airbnb listing name</label><input name="displayName" defaultValue={property?.listingName} required minLength={2} /></div>
      <div className="field field--wide"><label>Private Airbnb iCal URL</label><input name="inboundIcalUrl" type="url" inputMode="url" placeholder={property ? "Paste a new URL to replace the stored feed" : "https://www.airbnb.com/calendar/ical/..."} required /></div>
      <div className="field"><label>Check-in</label><input name="defaultCheckinTime" type="time" defaultValue={property?.defaultCheckinTime ?? defaults.defaultCheckinTime} required /></div>
      <div className="field"><label>Checkout</label><input name="defaultCheckoutTime" type="time" defaultValue={property?.defaultCheckoutTime ?? defaults.defaultCheckoutTime} required /></div>
      <div className="field"><label>Cleaning minutes</label><input name="defaultCleaningMinutes" type="number" min="5" max="480" defaultValue={property?.defaultCleaningMinutes ?? defaults.defaultCleaningMinutes} required /></div>
      <div className="field"><label>Checkout buffer</label><input name="checkoutBufferMinutes" type="number" min="0" max="120" defaultValue={defaults.checkoutBufferMinutes} required /></div>
      <div className="field"><label>Check-in buffer</label><input name="checkinBufferMinutes" type="number" min="0" max="120" defaultValue={defaults.checkinBufferMinutes} required /></div>
    </div>
  );
}

export function PropertyManager({ initialProperties, demoMode }: { initialProperties: PropertySummary[]; demoMode: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [outboundUrl, setOutboundUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>, property?: PropertySummary) {
    event.preventDefault();
    if (demoMode) { setMessage("Connect Supabase to save property changes."); return; }
    setSaving(true); setMessage("");
    const body = { ...formPayload(event.currentTarget), ...(property ? { propertyId: property.id, listingId: property.listingId } : {}) };
    const response = await fetch("/api/properties", { method: property ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    setSaving(false);
    if (!response.ok) { setMessage("Could not save this property. Check every field."); return; }
    setMessage(property ? "Property updated." : "Property created.");
    if (result.outboundUrl) setOutboundUrl(result.outboundUrl);
    if (!property) event.currentTarget.reset();
    router.refresh();
  }

  async function rotateFeed(property: PropertySummary) {
    if (demoMode) { setMessage("Connect Supabase to rotate outbound feeds."); return; }
    const response = await fetch("/api/listings/outbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listingId: property.listingId }) });
    const result = await response.json();
    if (!response.ok) { setMessage("Could not rotate the outbound feed."); return; }
    setOutboundUrl(result.outboundUrl); setMessage("Previous outbound link disabled. New link ready."); router.refresh();
  }

  async function toggleFeed(property: PropertySummary) {
    if (demoMode) { setMessage("Connect Supabase to change outbound feeds."); return; }
    const response = await fetch("/api/listings/outbound", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ listingId: property.listingId, enabled: !property.outboundEnabled }) });
    setMessage(response.ok ? `Outbound feed ${property.outboundEnabled ? "disabled" : "enabled"}.` : "Could not change the outbound feed.");
    if (response.ok) router.refresh();
  }

  return (
    <>
      {message ? <div className="notice" role="status">{message}</div> : null}
      {outboundUrl ? <div className="outbound-result"><div><strong>Outbound Airbnb feed</strong><code>{outboundUrl}</code><small>Import this URL in the Airbnb listing&apos;s calendar settings. It is shown only once.</small></div><button className="icon-button" title="Copy outbound feed URL" aria-label="Copy outbound feed URL" onClick={() => navigator.clipboard.writeText(outboundUrl)}><Copy size={18} /></button></div> : null}
      <details className="form-panel">
        <summary><Plus size={18} /> Add property</summary>
        <form onSubmit={(event) => submit(event)}>
          <PropertyFields />
          <div className="form-actions"><button className="button button--primary" disabled={saving} type="submit">{saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />} Save property</button></div>
        </form>
      </details>
      <div className="property-list">
        {initialProperties.map((property) => (
          <article className="property-row" key={property.listingId}>
            <div className="property-icon"><Building2 aria-hidden="true" size={20} /></div>
            <div className="property-main"><strong>{property.name}</strong><span>{property.listingName}</span></div>
            <div className="property-default"><span>Checkout</span><strong>{property.defaultCheckoutTime}</strong></div>
            <div className="property-default"><span>Check-in</span><strong>{property.defaultCheckinTime}</strong></div>
            <span className={`status ${property.lastSyncStatus === "failure" ? "status--impossible" : "status--safe"}`}>{property.lastSyncStatus === "failure" ? "Sync error" : "Active"}</span>
            <div className="feed-actions"><button className="icon-button" type="button" title="Rotate outbound feed link" aria-label={`Rotate outbound feed for ${property.name}`} onClick={() => rotateFeed(property)}><Link2 size={17} /></button><button className="icon-button" type="button" title={property.outboundEnabled ? "Disable outbound feed" : "Enable outbound feed"} aria-label={`${property.outboundEnabled ? "Disable" : "Enable"} outbound feed for ${property.name}`} onClick={() => toggleFeed(property)}>{property.outboundEnabled ? <PauseCircle size={17} /> : <PlayCircle size={17} />}</button></div>
            <details className="row-editor"><summary className="button button--quiet">Edit</summary><form onSubmit={(event) => submit(event, property)}><PropertyFields property={property} /><div className="form-actions"><button className="button button--primary" type="submit">Save changes</button></div></form></details>
          </article>
        ))}
        {!initialProperties.length ? <div className="list-empty"><Building2 size={24} /><span>No properties yet</span></div> : null}
      </div>
    </>
  );
}
