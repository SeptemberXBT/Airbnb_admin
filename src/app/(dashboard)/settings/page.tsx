import { getAuditHistory } from "@/features/calendar/history-service";
import { requireUser } from "@/lib/auth/require-user";
import { formatInTimeZone } from "date-fns-tz";
import { LogOut } from "lucide-react";
import { signOut } from "./actions";

export default async function SettingsPage() {
  const user = await requireUser();
  const history = await getAuditHistory(user.id);
  return (
    <div className="workspace workspace--narrow">
      <header className="page-header"><div><p className="eyebrow">Workspace</p><h1>Settings</h1></div><form action={signOut}><button className="button button--quiet" type="submit"><LogOut size={16} /> Sign out</button></form></header>
      <section className="settings-band">
        <h2>Operating timezone</h2>
        <div className="setting-row"><div><strong>Asia/Kolkata</strong><p>All dates and operational times use India Standard Time.</p></div><span className="status status--safe">Active</span></div>
      </section>
      <section className="history-section">
        <div className="section-heading"><div><p className="eyebrow">Permanent record</p><h2>Recent history</h2></div><span>{history.length} changes</span></div>
        <div className="history-list">{history.map((item) => <div className="history-row" key={item.id}><div><strong>{item.propertyName}</strong><span>{item.action.replaceAll("_", " ")} · {item.entityType}</span></div><div><time dateTime={item.createdAt}>{formatInTimeZone(new Date(item.createdAt), "Asia/Kolkata", "d MMM, h:mm a")}</time><small>{item.actorId === user.id ? "You" : "Manager"}</small></div></div>)}</div>
      </section>
    </div>
  );
}
