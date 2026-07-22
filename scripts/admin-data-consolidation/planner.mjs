const ACTIVE_BOOKING_STATUSES = new Set(["processing", "held", "payment_pending", "confirmed"]);

export function normalizeIdentity(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function rows(snapshot, table) {
  return Array.isArray(snapshot?.[table]) ? snapshot[table] : [];
}

function uniqueIdentityMap(records, label) {
  const result = new Map();
  for (const record of records) {
    const identity = normalizeIdentity(record.name);
    if (!identity) throw new Error(`${label}_MISSING_IDENTITY`);
    if (result.has(identity)) throw new Error(`DUPLICATE_${label}_IDENTITY:${identity}`);
    result.set(identity, record);
  }
  return result;
}

function expandStayDates(checkin, checkout) {
  const start = new Date(`${String(checkin).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(checkout).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("INVALID_STAY_RANGE");
  }
  const result = [];
  for (let cursor = start; cursor < end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    result.push(cursor.toISOString().slice(0, 10));
  }
  return result;
}

function withoutPlannerFields(record) {
  const databaseRecord = { ...record };
  delete databaseRecord.inbound_ical_url_plaintext;
  return databaseRecord;
}

function mappedActor(actorId, actorMap, fallbackActorId) {
  if (!actorId) return null;
  return actorMap[actorId] ?? fallbackActorId;
}

function buildActorMap(source, destination, fallbackActorId) {
  const destinationByEmail = new Map(rows(destination, "users")
    .filter((user) => user.email)
    .map((user) => [normalizeIdentity(user.email), user.id]));
  return Object.fromEntries(rows(source, "users").map((user) => [
    user.id,
    destinationByEmail.get(normalizeIdentity(user.email)) ?? fallbackActorId,
  ]));
}

function addInventoryOwner(owners, row) {
  const key = `${row.property_id}:${row.stay_date}`;
  const existing = owners.get(key);
  if (existing && (existing.source_kind !== row.source_kind || existing.source_id !== row.source_id)) {
    throw new Error(`INVENTORY_OVERLAP:${key}:${existing.source_kind}:${row.source_kind}`);
  }
  if (!existing) owners.set(key, row);
}

export function buildConsolidationPlan({
  source,
  destination,
  fallbackActorId,
  manualIcalReattach = false,
}) {
  if (!fallbackActorId) throw new Error("MISSING_FALLBACK_ACTOR");
  const sourcePropertiesByName = uniqueIdentityMap(rows(source, "properties"), "SOURCE_PROPERTY");
  const destinationPropertiesByName = uniqueIdentityMap(rows(destination, "properties"), "DESTINATION_PROPERTY");
  const actorMap = buildActorMap(source, destination, fallbackActorId);
  const propertyMap = {};
  const mappedDestinationPropertyIds = new Set();

  for (const [identity, property] of sourcePropertiesByName) {
    const destinationProperty = destinationPropertiesByName.get(identity);
    const targetId = destinationProperty?.id ?? property.id;
    propertyMap[property.id] = targetId;
    if (destinationProperty) mappedDestinationPropertyIds.add(destinationProperty.id);
  }

  const bookingPropertyIds = new Set(rows(destination, "bookings").map((booking) => booking.property_id));
  const fallbackProperties = rows(destination, "properties")
    .filter((property) => bookingPropertyIds.has(property.id) && !mappedDestinationPropertyIds.has(property.id))
    .map((property) => ({
      ...property,
      active: false,
      archived_at: property.archived_at ?? "__MIGRATION_TIMESTAMP__",
    }));
  const sourceProperties = rows(source, "properties").map((property) => ({
    ...property,
    id: propertyMap[property.id],
  }));
  const properties = [...sourceProperties, ...fallbackProperties];
  const targetPropertyIds = new Set(properties.map((property) => property.id));

  const destinationListingsByProperty = new Map();
  for (const listing of rows(destination, "listings")) {
    const current = destinationListingsByProperty.get(listing.property_id) ?? [];
    current.push(listing);
    destinationListingsByProperty.set(listing.property_id, current);
  }
  const listingMap = {};
  const destinationListingMap = {};
  const listings = [];
  for (const sourceListing of rows(source, "listings")) {
    const targetPropertyId = propertyMap[sourceListing.property_id];
    if (!targetPropertyId) throw new Error(`UNMAPPED_SOURCE_PROPERTY:${sourceListing.property_id}`);
    const nameIdentity = normalizeIdentity(sourceListing.display_name);
    const nameMatches = (destinationListingsByProperty.get(targetPropertyId) ?? [])
      .filter((listing) => normalizeIdentity(listing.display_name) === nameIdentity);
    if (nameMatches.length > 1) throw new Error(`DUPLICATE_DESTINATION_LISTING_IDENTITY:${targetPropertyId}:${nameIdentity}`);
    const match = nameMatches[0];
    if (!manualIcalReattach && match && sourceListing.inbound_ical_url_plaintext
      && match.inbound_ical_url_plaintext
      && sourceListing.inbound_ical_url_plaintext !== match.inbound_ical_url_plaintext) {
      throw new Error(`LISTING_IDENTITY_CONFLICT:${targetPropertyId}:${nameIdentity}`);
    }
    const targetId = match?.id ?? sourceListing.id;
    listingMap[sourceListing.id] = targetId;
    if (match) destinationListingMap[match.id] = targetId;
    const plannedListing = {
      ...sourceListing,
      id: targetId,
      property_id: targetPropertyId,
      ...(manualIcalReattach ? {
        inbound_ical_url_encrypted: null,
        last_sync_at: null,
        last_sync_status: null,
        last_sync_error_code: null,
      } : {}),
    };
    listings.push(withoutPlannerFields(plannedListing));
  }
  if (new Set(listings.map((listing) => listing.id)).size !== listings.length) {
    throw new Error("DUPLICATE_TARGET_LISTING_ID");
  }

  const propertyRates = rows(destination, "property_rates")
    .filter((rate) => targetPropertyIds.has(rate.property_id));
  const propertyRateOverrides = rows(destination, "property_rate_overrides")
    .filter((rate) => targetPropertyIds.has(rate.property_id));
  const bookingLocalEntries = rows(destination, "local_calendar_entries")
    .filter((entry) => entry.booking_id)
    .map((entry) => ({
      ...entry,
      listing_id: entry.listing_id ? (destinationListingMap[entry.listing_id] ?? null) : null,
    }));
  const preservedLocalIds = new Set(bookingLocalEntries.map((entry) => entry.id));

  const externalCalendarEvents = rows(source, "external_calendar_events").map((event) => ({
    ...event,
    listing_id: listingMap[event.listing_id],
  }));
  const localCalendarEntries = rows(source, "local_calendar_entries")
    .filter((entry) => !entry.booking_id)
    .map((entry) => {
      if (preservedLocalIds.has(entry.id)) throw new Error(`LOCAL_ENTRY_ID_COLLISION:${entry.id}`);
      return {
        ...entry,
        property_id: propertyMap[entry.property_id],
        listing_id: entry.listing_id ? listingMap[entry.listing_id] : null,
        created_by: mappedActor(entry.created_by, actorMap, fallbackActorId),
        booking_id: null,
      };
    });
  const importedExternalIds = new Set(externalCalendarEvents.map((event) => event.id));
  const importedLocalIds = new Set(localCalendarEntries.map((entry) => entry.id));
  const operationOverrides = rows(source, "operation_overrides").map((override) => {
    if (override.external_event_id && !importedExternalIds.has(override.external_event_id)) {
      throw new Error(`UNMAPPED_OVERRIDE_EVENT:${override.id}`);
    }
    if (override.local_entry_id && !importedLocalIds.has(override.local_entry_id)) {
      throw new Error(`UNMAPPED_OVERRIDE_ENTRY:${override.id}`);
    }
    return { ...override, updated_by: mappedActor(override.updated_by, actorMap, fallbackActorId) };
  });
  const cleaningTasks = rows(source, "cleaning_tasks").map((task) => ({
    ...task,
    property_id: propertyMap[task.property_id],
  }));
  const syncRuns = rows(source, "sync_runs").map((run) => ({
    ...run,
    listing_id: run.listing_id ? listingMap[run.listing_id] : null,
  }));
  const auditLog = rows(source, "audit_log").map((event) => ({
    ...event,
    property_id: event.property_id ? propertyMap[event.property_id] : null,
    actor_id: mappedActor(event.actor_id, actorMap, fallbackActorId),
    changes: {
      ...(event.changes ?? {}),
      migration_source_audit_id: event.id,
    },
  }));

  const memberMap = new Map();
  for (const member of rows(source, "property_members")) {
    const mapped = {
      ...member,
      property_id: propertyMap[member.property_id],
      user_id: mappedActor(member.user_id, actorMap, fallbackActorId),
    };
    memberMap.set(`${mapped.property_id}:${mapped.user_id}`, mapped);
  }
  for (const property of properties) {
    memberMap.set(`${property.id}:${fallbackActorId}`, {
      property_id: property.id,
      user_id: fallbackActorId,
      role: "owner",
      created_at: property.created_at,
    });
    for (const user of rows(destination, "users")) {
      const key = `${property.id}:${user.id}`;
      if (!memberMap.has(key)) memberMap.set(key, {
        property_id: property.id,
        user_id: user.id,
        role: "manager",
        created_at: property.created_at,
      });
    }
  }
  const propertyMembers = [...memberMap.values()];

  const inventoryOwners = new Map();
  for (const event of externalCalendarEvents) {
    if (!event.active || event.archived_at || event.historical) continue;
    const listing = listings.find((candidate) => candidate.id === event.listing_id);
    if (!listing) throw new Error(`UNMAPPED_EVENT_LISTING:${event.id}`);
    const sourceKind = event.event_type === "reservation"
      ? "airbnb_reservation"
      : event.event_type === "unavailable" ? "airbnb_unavailable" : "airbnb_unknown";
    for (const stayDate of expandStayDates(event.start_date, event.end_date)) {
      addInventoryOwner(inventoryOwners, {
        property_id: listing.property_id,
        stay_date: stayDate,
        source_kind: sourceKind,
        source_id: event.id,
        booking_id: null,
        local_entry_id: null,
        external_event_id: event.id,
        status: "active",
        expires_at: null,
      });
    }
  }
  for (const entry of localCalendarEntries) {
    if (!entry.active || entry.archived_at) continue;
    for (const stayDate of expandStayDates(entry.start_date, entry.end_date)) {
      addInventoryOwner(inventoryOwners, {
        property_id: entry.property_id,
        stay_date: stayDate,
        source_kind: "manual_local",
        source_id: entry.id,
        booking_id: null,
        local_entry_id: entry.id,
        external_event_id: null,
        status: "active",
        expires_at: null,
      });
    }
  }
  for (const booking of rows(destination, "bookings")) {
    if (!ACTIVE_BOOKING_STATUSES.has(booking.status) || booking.archived_at) continue;
    const sourceKind = booking.status === "confirmed" ? "website_booking" : "website_hold";
    for (const stayDate of expandStayDates(booking.checkin, booking.checkout)) {
      addInventoryOwner(inventoryOwners, {
        property_id: booking.property_id,
        stay_date: stayDate,
        source_kind: sourceKind,
        source_id: booking.id,
        booking_id: booking.id,
        local_entry_id: null,
        external_event_id: null,
        status: "active",
        expires_at: sourceKind === "website_hold" ? booking.hold_expires_at : null,
      });
    }
  }

  return {
    actorMap,
    propertyMap,
    listingMap,
    properties,
    propertyMembers,
    listings,
    externalCalendarEvents,
    localCalendarEntries,
    bookingLocalEntries,
    operationOverrides,
    cleaningTasks,
    syncRuns,
    auditLog,
    propertyRates,
    propertyRateOverrides,
    inventoryNights: [...inventoryOwners.values()],
    counts: {
      properties: properties.length,
      listings: listings.length,
      disconnectedListings: listings
        .filter((listing) => listing.inbound_ical_url_encrypted === null).length,
      externalCalendarEvents: externalCalendarEvents.length,
      localCalendarEntries: localCalendarEntries.length + bookingLocalEntries.length,
      inventoryNights: inventoryOwners.size,
      preservedBookings: rows(destination, "bookings").length,
    },
  };
}
