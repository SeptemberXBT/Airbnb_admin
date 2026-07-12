import "server-only";
import type postgres from "postgres";
import type { CleaningTaskReconciliationStore } from "./queue-reconciliation";

export function createPostgresCleaningTaskStore(tx: postgres.TransactionSql): CleaningTaskReconciliationStore {
  return {
    archiveStale(propertyIds, serviceDate, desired) {
      return tx`
        with desired as (
          select * from jsonb_to_recordset(${tx.json(desired)}::jsonb) as d(
            "propertyId" uuid, "outgoingEntryKey" text, "incomingEntryKey" text
          )
        )
        update public.cleaning_tasks t set archived_at = now(), updated_at = now()
        where t.service_date = ${serviceDate} and t.property_id in ${tx(propertyIds)}
          and t.archived_at is null
          and (
            (t.status in ('queued', 'delayed') and not exists (
              select 1 from desired d where d."propertyId" = t.property_id
            ))
            or
            (t.status <> 'cleaning_now' and exists (
              select 1 from desired d where d."propertyId" = t.property_id
            ) and not exists (
              select 1 from desired d where d."propertyId" = t.property_id
                and d."outgoingEntryKey" is not distinct from t.outgoing_entry_key
                and d."incomingEntryKey" is not distinct from t.incoming_entry_key
            ))
          )
      `;
    },
    upsertDerived(desired) {
      return tx`
        with desired as (
          select * from jsonb_to_recordset(${tx.json(desired)}::jsonb) as d(
            "propertyId" uuid, "serviceDate" date, "outgoingEntryKey" text,
            "incomingEntryKey" text, "releaseTime" timestamptz,
            "readyDeadline" timestamptz, "guestArrivalTime" timestamptz,
            "durationMinutes" integer
          )
        )
        insert into public.cleaning_tasks (
          property_id, service_date, outgoing_entry_key, incoming_entry_key, release_time,
          ready_deadline, guest_arrival_time, expected_duration_minutes
        ) select
          d."propertyId", d."serviceDate", d."outgoingEntryKey", d."incomingEntryKey",
          d."releaseTime", d."readyDeadline", d."guestArrivalTime", d."durationMinutes"
        from desired d
        on conflict (property_id, service_date) where archived_at is null do update set
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
        where public.cleaning_tasks.status <> 'cleaning_now' and (
          public.cleaning_tasks.outgoing_entry_key is distinct from excluded.outgoing_entry_key
          or public.cleaning_tasks.incoming_entry_key is distinct from excluded.incoming_entry_key
          or public.cleaning_tasks.release_time is distinct from excluded.release_time
          or public.cleaning_tasks.ready_deadline is distinct from excluded.ready_deadline
          or public.cleaning_tasks.guest_arrival_time is distinct from excluded.guest_arrival_time
          or public.cleaning_tasks.expected_duration_minutes is distinct from excluded.expected_duration_minutes
        )
      `;
    },
  };
}
