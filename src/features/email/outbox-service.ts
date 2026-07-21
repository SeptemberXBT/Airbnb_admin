import "server-only";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { EmailTemplateKey } from "./templates";
import type { ZeptoMailClient } from "./zeptomail-client";

type NotificationInput = {
  bookingId: string;
  recipientKind: "guest" | "admin";
  recipientEmail: string;
  templateKey: EmailTemplateKey | string;
  deduplicationKey: string;
  subject: string;
  htmlBody: string;
  textBody: string;
};

export async function enqueueNotification(
  sql: postgres.Sql | postgres.TransactionSql,
  input: NotificationInput,
) {
  const query = sql as unknown as postgres.Sql;
  const [message] = await query<{ id: string }[]>`
    insert into public.notification_outbox (
      booking_id, recipient_kind, recipient_email, template_key, deduplication_key,
      subject, html_body, text_body
    ) values (
      ${input.bookingId}, ${input.recipientKind}, ${input.recipientEmail}, ${input.templateKey},
      ${input.deduplicationKey}, ${input.subject}, ${input.htmlBody}, ${input.textBody}
    ) on conflict (deduplication_key) do nothing returning id
  `;
  return message?.id ?? null;
}

export function createNotificationOutboxService(
  sql: postgres.Sql,
  dependencies: { mailer: Pick<ZeptoMailClient, "send">; clock?: () => Date },
) {
  const clock = dependencies.clock ?? (() => new Date());
  return {
    async processBatch(limit = 25) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_OUTBOX_LIMIT");
      const now = clock();
      const leaseToken = randomUUID();
      const rows = await sql<{
        id: string;
        recipient_email: string;
        subject: string;
        html_body: string;
        text_body: string;
        attempt_count: number;
      }[]>`
        with ready as (
          select id from public.notification_outbox
          where status in ('pending', 'retryable_failure') and next_attempt_at <= ${now}
          order by next_attempt_at, created_at
          limit ${limit}
          for update skip locked
        )
        update public.notification_outbox o
        set status = 'processing', lease_token = ${leaseToken},
          lease_expires_at = ${new Date(now.getTime() + 60_000)},
          attempt_count = attempt_count + 1, updated_at = ${now}
        from ready where o.id = ready.id
        returning o.id, o.recipient_email, o.subject, o.html_body, o.text_body, o.attempt_count
      `;
      let sent = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          const result = await dependencies.mailer.send({
            to: row.recipient_email,
            subject: row.subject,
            htmlBody: row.html_body,
            textBody: row.text_body,
          });
          await sql`
            update public.notification_outbox
            set status = 'sent', provider_message_id = ${result.providerMessageId}, sent_at = ${clock()},
              lease_token = null, lease_expires_at = null, last_error_code = null, updated_at = ${clock()}
            where id = ${row.id} and status = 'processing' and lease_token = ${leaseToken}
          `;
          sent += 1;
        } catch {
          if (row.attempt_count >= 8) {
            await sql.begin(async (tx) => {
              const [terminal] = await tx<{ booking_id: string }[]>`
                update public.notification_outbox set status = 'failed', lease_token = null,
                  lease_expires_at = null, last_error_code = 'mail_retry_exhausted', updated_at = ${clock()}
                where id = ${row.id} and status = 'processing' and lease_token = ${leaseToken}
                returning booking_id
              `;
              if (terminal) {
                await tx`
                  insert into public.booking_events (property_id, booking_id, event_type, metadata)
                  select b.property_id, b.id, 'notification_delivery_failed',
                    ${tx.json({ outboxId: row.id, attempts: row.attempt_count })}
                  from public.bookings b where b.id = ${terminal.booking_id}
                `;
              }
            });
          } else {
            const delayMinutes = Math.min(60, 2 ** Math.min(row.attempt_count, 6));
            await sql`
              update public.notification_outbox
              set status = 'retryable_failure', next_attempt_at = ${new Date(clock().getTime() + delayMinutes * 60_000)},
                lease_token = null, lease_expires_at = null, last_error_code = 'mail_unavailable', updated_at = ${clock()}
              where id = ${row.id} and status = 'processing' and lease_token = ${leaseToken}
            `;
          }
          failed += 1;
        }
      }
      return { sent, failed };
    },
  };
}
