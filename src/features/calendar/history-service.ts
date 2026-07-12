import "server-only";
import { getDb } from "@/lib/db/client";

export type AuditItem = { id: string; propertyName: string; action: string; entityType: string; actorId: string | null; createdAt: string };

export async function getAuditHistory(userId: string): Promise<AuditItem[]> {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") {
    return [{ id: "demo-1", propertyName: "Courtyard Studio", action: "created", entityType: "local calendar entry", actorId: userId, createdAt: new Date().toISOString() }];
  }
  const sql = getDb();
  const rows = await sql<{ id: string; property_name: string; action: string; entity_type: string; actor_id: string | null; created_at: string }[]>`
    select a.id::text, p.name as property_name, a.action, a.entity_type, a.actor_id::text, a.created_at::text
    from public.audit_log a join public.properties p on p.id = a.property_id
    join public.property_members pm on pm.property_id = p.id and pm.user_id = ${userId}
    order by a.created_at desc limit 50
  `;
  return rows.map((row) => ({ id: row.id, propertyName: row.property_name, action: row.action,
    entityType: row.entity_type.replaceAll("_", " "), actorId: row.actor_id, createdAt: row.created_at }));
}
