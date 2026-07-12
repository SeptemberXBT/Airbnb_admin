import "server-only";
import { getDb } from "@/lib/db/client";
import { addMinutes, subMinutes } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { deriveTurnovers, type TurnoverProperty, type TurnoverReservation } from "./derive-turnovers";
import { buildCleaningSchedule, type CleaningCandidate, type CleaningStatus, type WarningLevel } from "./scheduler";
import { externalTurnoverTypes } from "./turnover-sources";

export type CleaningTaskView = {
  id: string; propertyId: string; propertyName: string; serviceDate: string;
  outgoingEntryKey: string | null; incomingEntryKey: string | null;
  checkoutTime: string; checkinTime: string | null;
  releaseTime: string; readyDeadline: string; guestArrivalTime: string | null;
  plannedStart: string | null; plannedEnd: string | null; durationMinutes: number;
  status: CleaningStatus; warningLevel: WarningLevel; actualStart: string | null;
  actualEnd: string | null; delayMinutes: number;
};

function demoQueue(serviceDate: string, now: Date): CleaningTaskView[] {
  const names = ["Courtyard Studio", "Mango Room", "Terrace Suite", "Garden Annex", "Library Loft"];
  const checkout = fromZonedTime(`${serviceDate}T11:00:00`, "Asia/Kolkata");
  const checkin = fromZonedTime(`${serviceDate}T13:00:00`, "Asia/Kolkata");
  const release = addMinutes(checkout, 5);
  const candidates: CleaningCandidate[] = names.map((name, index) => ({
    id: `demo-clean-${index}`, propertyId: `demo-property-${index}`, propertyName: name,
    releaseTime: release, readyDeadline: addMinutes(checkin, -5), guestArrivalTime: checkin,
    durationMinutes: index === 0 ? 20 : 15, status: "queued", actualStart: null,
    actualEnd: null, delayMinutes: 0,
  }));
  return buildCleaningSchedule(candidates, now).map((task) => ({
    id: task.id, propertyId: task.propertyId, propertyName: task.propertyName, serviceDate,
    outgoingEntryKey: null, incomingEntryKey: null, checkoutTime: "11:00", checkinTime: "13:00",
    releaseTime: task.releaseTime.toISOString(),
    readyDeadline: task.readyDeadline.toISOString(), guestArrivalTime: task.guestArrivalTime?.toISOString() ?? null,
    plannedStart: task.plannedStart?.toISOString() ?? null, plannedEnd: task.plannedEnd?.toISOString() ?? null,
    durationMinutes: task.durationMinutes, status: task.status, warningLevel: task.warningLevel,
    actualStart: task.actualStart?.toISOString() ?? null, actualEnd: task.actualEnd?.toISOString() ?? null, delayMinutes: task.delayMinutes,
  }));
}

export async function getCleaningQueue(userId: string, serviceDate: string, now = new Date()): Promise<CleaningTaskView[]> {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") return demoQueue(serviceDate, now);
  const sql = getDb();
  const propertyRows = await sql<{
    id: string; name: string; default_checkin_time: string; default_checkout_time: string;
    default_cleaning_minutes: number; checkout_buffer_minutes: number; checkin_buffer_minutes: number;
    housekeeping_cutoff_time: string;
  }[]>`
    select p.id, p.name, p.default_checkin_time::text, p.default_checkout_time::text,
      p.default_cleaning_minutes, p.checkout_buffer_minutes, p.checkin_buffer_minutes,
      p.housekeeping_cutoff_time::text
    from public.properties p join public.property_members pm on pm.property_id = p.id and pm.user_id = ${userId}
    where p.active and p.archived_at is null order by p.name
  `;
  const propertyIds = propertyRows.map((row) => row.id);
  if (!propertyIds.length) return [];
  const external = await sql<{
    property_id: string; id: string; start_date: string; end_date: string;
    expected_checkin_time: string | null; expected_checkout_time: string | null; cleaning_duration_minutes: number | null;
  }[]>`
    select l.property_id, e.id, e.start_date::text, e.end_date::text, o.expected_checkin_time::text,
      o.expected_checkout_time::text, o.cleaning_duration_minutes
    from public.external_calendar_events e join public.listings l on l.id = e.listing_id
    left join public.operation_overrides o on o.external_event_id = e.id
    where l.property_id in ${sql(propertyIds)} and e.active and e.event_type in ${sql(externalTurnoverTypes)}
      and (e.start_date = ${serviceDate} or e.end_date = ${serviceDate})
  `;
  const local = await sql<{
    property_id: string; id: string; start_date: string; end_date: string;
    expected_checkin_time: string | null; expected_checkout_time: string | null; cleaning_duration_minutes: number | null;
  }[]>`
    select e.property_id, e.id, e.start_date::text, e.end_date::text, o.expected_checkin_time::text,
      o.expected_checkout_time::text, o.cleaning_duration_minutes
    from public.local_calendar_entries e left join public.operation_overrides o on o.local_entry_id = e.id
    where e.property_id in ${sql(propertyIds)} and e.active and e.entry_type = 'direct_reservation'
      and (e.start_date = ${serviceDate} or e.end_date = ${serviceDate})
  `;
  const reservations = new Map<string, TurnoverReservation[]>();
  const add = (propertyId: string, reservation: TurnoverReservation) => reservations.set(propertyId, [...(reservations.get(propertyId) ?? []), reservation]);
  for (const row of external) add(row.property_id, { key: `external:${row.id}`, startDate: row.start_date, endDate: row.end_date,
    expectedCheckinTime: row.expected_checkin_time?.slice(0, 5) ?? null, expectedCheckoutTime: row.expected_checkout_time?.slice(0, 5) ?? null,
    cleaningDurationMinutes: row.cleaning_duration_minutes });
  for (const row of local) add(row.property_id, { key: `local:${row.id}`, startDate: row.start_date, endDate: row.end_date,
    expectedCheckinTime: row.expected_checkin_time?.slice(0, 5) ?? null, expectedCheckoutTime: row.expected_checkout_time?.slice(0, 5) ?? null,
    cleaningDurationMinutes: row.cleaning_duration_minutes });
  const turnoverProperties: TurnoverProperty[] = propertyRows.map((row) => ({
    id: row.id, name: row.name, defaultCheckinTime: row.default_checkin_time.slice(0, 5),
    defaultCheckoutTime: row.default_checkout_time.slice(0, 5), defaultCleaningMinutes: row.default_cleaning_minutes,
    checkoutBufferMinutes: row.checkout_buffer_minutes, checkinBufferMinutes: row.checkin_buffer_minutes,
    housekeepingCutoffTime: row.housekeeping_cutoff_time.slice(0, 5), reservations: reservations.get(row.id) ?? [],
  }));
  const derived = deriveTurnovers(turnoverProperties, serviceDate);
  const derivedPropertyIds = derived.map((task) => task.propertyId);
  if (derivedPropertyIds.length) {
    await sql`
      update public.cleaning_tasks set archived_at = now(), updated_at = now()
      where service_date = ${serviceDate} and property_id in ${sql(propertyIds)}
        and property_id not in ${sql(derivedPropertyIds)} and status in ('queued', 'delayed') and archived_at is null
    `;
  } else {
    await sql`
      update public.cleaning_tasks set archived_at = now(), updated_at = now()
      where service_date = ${serviceDate} and property_id in ${sql(propertyIds)}
        and status in ('queued', 'delayed') and archived_at is null
    `;
  }
  for (const task of derived) {
    await sql`
      update public.cleaning_tasks set archived_at = now(), updated_at = now()
      where property_id = ${task.propertyId} and service_date = ${serviceDate} and archived_at is null
        and status <> 'cleaning_now'
        and (outgoing_entry_key is distinct from ${task.outgoingEntryKey}
          or incoming_entry_key is distinct from ${task.incomingEntryKey})
    `;
    await sql`
      insert into public.cleaning_tasks (
        property_id, service_date, outgoing_entry_key, incoming_entry_key, release_time,
        ready_deadline, guest_arrival_time, expected_duration_minutes
      ) values (
        ${task.propertyId}, ${serviceDate}, ${task.outgoingEntryKey}, ${task.incomingEntryKey},
        ${task.releaseTime}, ${task.readyDeadline}, ${task.guestArrivalTime}, ${task.durationMinutes}
      ) on conflict (property_id, service_date) where archived_at is null do update set
        outgoing_entry_key = case when public.cleaning_tasks.status = 'cleaning_now'
          then public.cleaning_tasks.outgoing_entry_key else excluded.outgoing_entry_key end,
        incoming_entry_key = case when public.cleaning_tasks.status = 'cleaning_now'
          then public.cleaning_tasks.incoming_entry_key else excluded.incoming_entry_key end,
        release_time = case when public.cleaning_tasks.status = 'cleaning_now'
          then public.cleaning_tasks.release_time else excluded.release_time end,
        ready_deadline = case when public.cleaning_tasks.status = 'cleaning_now'
          then public.cleaning_tasks.ready_deadline else excluded.ready_deadline end,
        guest_arrival_time = case when public.cleaning_tasks.status = 'cleaning_now'
          then public.cleaning_tasks.guest_arrival_time else excluded.guest_arrival_time end,
        expected_duration_minutes = case when public.cleaning_tasks.status = 'cleaning_now'
          then public.cleaning_tasks.expected_duration_minutes else excluded.expected_duration_minutes end,
        updated_at = now()
    `;
  }
  const rows = await sql<{
    id: string; property_id: string; property_name: string; outgoing_entry_key: string | null; incoming_entry_key: string | null;
    release_time: string; ready_deadline: string; guest_arrival_time: string | null; expected_duration_minutes: number;
    status: CleaningStatus; actual_start: string | null; actual_end: string | null; delay_minutes: number;
    checkout_buffer_minutes: number;
  }[]>`
    select t.id, t.property_id, p.name as property_name, t.outgoing_entry_key, t.incoming_entry_key,
      t.release_time::text, t.ready_deadline::text, t.guest_arrival_time::text,
      t.expected_duration_minutes, t.status, t.actual_start::text, t.actual_end::text, t.delay_minutes,
      p.checkout_buffer_minutes
    from public.cleaning_tasks t join public.properties p on p.id = t.property_id
    join public.property_members pm on pm.property_id = p.id and pm.user_id = ${userId}
    where t.service_date = ${serviceDate} and t.archived_at is null
    order by p.name
  `;
  const schedule = buildCleaningSchedule(rows.map((row) => ({
    id: row.id, propertyId: row.property_id, propertyName: row.property_name,
    releaseTime: new Date(row.release_time), readyDeadline: new Date(row.ready_deadline),
    guestArrivalTime: row.guest_arrival_time ? new Date(row.guest_arrival_time) : null,
    durationMinutes: row.expected_duration_minutes, status: row.status,
    actualStart: row.actual_start ? new Date(row.actual_start) : null,
    actualEnd: row.actual_end ? new Date(row.actual_end) : null, delayMinutes: row.delay_minutes,
  })), now);
  for (const task of schedule) await sql`
    update public.cleaning_tasks set planned_start = ${task.plannedStart}, planned_end = ${task.plannedEnd},
      warning_level = ${task.warningLevel}, updated_at = now() where id = ${task.id}
  `;
  const sourceById = new Map(rows.map((row) => [row.id, row]));
  return schedule.map((task) => ({
    id: task.id, propertyId: task.propertyId, propertyName: task.propertyName, serviceDate,
    outgoingEntryKey: sourceById.get(task.id)?.outgoing_entry_key ?? null,
    incomingEntryKey: sourceById.get(task.id)?.incoming_entry_key ?? null,
    checkoutTime: formatInTimeZone(subMinutes(task.releaseTime, sourceById.get(task.id)?.checkout_buffer_minutes ?? 0), "Asia/Kolkata", "HH:mm"),
    checkinTime: task.guestArrivalTime ? formatInTimeZone(task.guestArrivalTime, "Asia/Kolkata", "HH:mm") : null,
    releaseTime: task.releaseTime.toISOString(), readyDeadline: task.readyDeadline.toISOString(),
    guestArrivalTime: task.guestArrivalTime?.toISOString() ?? null,
    plannedStart: task.plannedStart?.toISOString() ?? null, plannedEnd: task.plannedEnd?.toISOString() ?? null,
    durationMinutes: task.durationMinutes, status: task.status, warningLevel: task.warningLevel,
    actualStart: task.actualStart?.toISOString() ?? null, actualEnd: task.actualEnd?.toISOString() ?? null,
    delayMinutes: task.delayMinutes,
  }));
}

export type CleaningUpdate = {
  taskId: string; action: "start" | "ready" | "delay" | "skip" | "edit" | "requeue";
  delayMinutes?: number; durationMinutes?: number; expectedCheckoutTime?: string; expectedCheckinTime?: string;
};

export async function updateCleaningTask(input: CleaningUpdate, userId: string) {
  const sql = getDb();
  const [task] = await sql<{ property_id: string; outgoing_entry_key: string | null; incoming_entry_key: string | null }[]>`
    select t.property_id, t.outgoing_entry_key, t.incoming_entry_key from public.cleaning_tasks t
    join public.property_members pm on pm.property_id = t.property_id and pm.user_id = ${userId}
    where t.id = ${input.taskId} and t.archived_at is null
  `;
  if (!task) throw new Error("NOT_FOUND");
  await sql.begin(async (tx) => {
    const target = (key: string | null) => {
      const [source, id] = key?.split(":") ?? [];
      return { externalId: source === "external" ? id : null, localId: source === "local" ? id : null };
    };
    const upsertCheckout = async (key: string | null, value: string) => {
      const { externalId, localId } = target(key);
      if (!externalId && !localId) return;
      await tx`
        insert into public.operation_overrides (external_event_id, local_entry_id, expected_checkout_time, updated_by)
        values (${externalId}, ${localId}, ${value}, ${userId})
        on conflict (external_event_id, local_entry_id) do update set
          expected_checkout_time = excluded.expected_checkout_time, updated_by = excluded.updated_by, updated_at = now()
      `;
    };
    const upsertCheckin = async (key: string | null, value: string) => {
      const { externalId, localId } = target(key);
      if (!externalId && !localId) return;
      await tx`
        insert into public.operation_overrides (external_event_id, local_entry_id, expected_checkin_time, updated_by)
        values (${externalId}, ${localId}, ${value}, ${userId})
        on conflict (external_event_id, local_entry_id) do update set
          expected_checkin_time = excluded.expected_checkin_time, updated_by = excluded.updated_by, updated_at = now()
      `;
    };
    const upsertDuration = async (key: string | null, value: number) => {
      const { externalId, localId } = target(key);
      if (!externalId && !localId) return;
      await tx`
        insert into public.operation_overrides (external_event_id, local_entry_id, cleaning_duration_minutes, updated_by)
        values (${externalId}, ${localId}, ${value}, ${userId})
        on conflict (external_event_id, local_entry_id) do update set
          cleaning_duration_minutes = excluded.cleaning_duration_minutes, updated_by = excluded.updated_by, updated_at = now()
      `;
    };
    if (input.action === "start") {
      const [active] = await tx`select id from public.cleaning_tasks where status = 'cleaning_now' and id <> ${input.taskId} limit 1`;
      if (active) throw new Error("TEAM_BUSY");
      await tx`update public.cleaning_tasks set status = 'cleaning_now', actual_start = coalesce(actual_start, now()), actual_end = null, updated_at = now() where id = ${input.taskId}`;
    } else if (input.action === "ready") {
      await tx`update public.cleaning_tasks set status = 'ready', actual_end = now(), updated_at = now() where id = ${input.taskId}`;
    } else if (input.action === "delay") {
      await tx`update public.cleaning_tasks set status = 'delayed', delay_minutes = ${input.delayMinutes ?? 10}, updated_at = now() where id = ${input.taskId}`;
    } else if (input.action === "skip") {
      await tx`update public.cleaning_tasks set status = 'skipped', updated_at = now() where id = ${input.taskId}`;
    } else if (input.action === "requeue") {
      await tx`
        update public.cleaning_tasks set status = 'queued', actual_start = null, actual_end = null,
          delay_minutes = 0, updated_at = now()
        where id = ${input.taskId}
      `;
    } else if (input.action === "edit" && input.durationMinutes) {
      await tx`update public.cleaning_tasks set expected_duration_minutes = ${input.durationMinutes}, updated_at = now() where id = ${input.taskId}`;
    }
    if (input.action === "edit") {
      if (input.expectedCheckoutTime) await upsertCheckout(task.outgoing_entry_key, input.expectedCheckoutTime);
      if (input.expectedCheckinTime) await upsertCheckin(task.incoming_entry_key, input.expectedCheckinTime);
      if (input.durationMinutes) await upsertDuration(task.outgoing_entry_key ?? task.incoming_entry_key, input.durationMinutes);
    }
    await tx`
      insert into public.audit_log (property_id, actor_id, action, entity_type, entity_id, changes)
      values (${task.property_id}, ${userId}, ${`cleaning_${input.action}`}, 'cleaning_task', ${input.taskId},
        ${tx.json({ delayMinutes: input.delayMinutes, durationMinutes: input.durationMinutes })})
    `;
  });
}
