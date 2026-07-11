"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="workspace"><section className="empty-state"><AlertTriangle aria-hidden="true" /><h2>Workspace unavailable</h2><p>Your saved calendar data is unchanged.</p><button className="button button--primary" onClick={reset}><RefreshCw size={16} /> Try again</button></section></div>;
}
