"use client";

import type { CleaningTaskView } from "./cleaning-service";
import { formatInTimeZone } from "date-fns-tz";
import { Check, CheckCircle2, Clock3, Edit3, LoaderCircle, Play, SkipForward, TimerReset, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

const time = (value: string | null) => value ? formatInTimeZone(new Date(value), "Asia/Kolkata", "h:mm a") : "--";
const warningLabel = { safe: "Safe", tight: "Tight", impossible: "Impossible", overdue: "Overdue", waiting: "Waiting" } as const;

function TaskCard({ task, demoMode, activeId, onAction }: {
  task: CleaningTaskView; demoMode: boolean; activeId: string; onAction: (task: CleaningTaskView, action: string, values?: Record<string, unknown>) => Promise<void>;
}) {
  const running = task.status === "cleaning_now";
  const done = task.status === "ready";
  async function edit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onAction(task, "edit", {
      durationMinutes: Number(data.get("durationMinutes")),
      expectedCheckoutTime: String(data.get("expectedCheckoutTime") || "") || undefined,
      expectedCheckinTime: String(data.get("expectedCheckinTime") || "") || undefined,
    });
  }
  return <article className={`cleaning-card ${running ? "cleaning-card--active" : ""} ${done ? "cleaning-card--done" : ""}`}>
    <div className="cleaning-card__top">
      <div className="queue-position">{running ? <LoaderCircle className="spin" size={17} /> : done ? <CheckCircle2 size={17} /> : <span>{task.status === "skipped" ? "-" : ""}</span>}</div>
      <div className="cleaning-title"><strong>{task.propertyName}</strong><span>{running ? "Cleaning now" : done ? "Room ready" : task.status === "skipped" ? "Skipped" : `Release ${time(task.releaseTime)}`}</span></div>
      <span className={`status status--${task.warningLevel}`} aria-label={`Schedule status: ${warningLabel[task.warningLevel]}`}>{task.warningLevel === "safe" ? <Check size={12} /> : task.warningLevel === "waiting" ? <Clock3 size={12} /> : <TriangleAlert size={12} />}{warningLabel[task.warningLevel]}</span>
    </div>
    <div className="cleaning-times">
      <div><span>Start</span><strong>{time(task.plannedStart)}</strong></div>
      <div><span>Ready</span><strong>{time(task.plannedEnd)}</strong></div>
      <div><span>Deadline</span><strong>{time(task.readyDeadline)}</strong></div>
      <div><span>Duration</span><strong>{task.durationMinutes} min</strong></div>
    </div>
    {!done && task.status !== "skipped" ? <div className="cleaning-actions">
      {running ? <button className="quick-action quick-action--ready" disabled={activeId === task.id} onClick={() => onAction(task, "ready")}><CheckCircle2 size={18} /> Ready</button> : <button className="quick-action quick-action--start" disabled={activeId === task.id} onClick={() => onAction(task, "start")}><Play size={17} /> Start</button>}
      {!running ? <button className="quick-action" disabled={activeId === task.id} onClick={() => onAction(task, "delay", { delayMinutes: task.delayMinutes + 10 })}><TimerReset size={17} /> Delay</button> : null}
      {!running ? <button className="icon-button" title="Skip cleaning task" aria-label={`Skip ${task.propertyName}`} disabled={activeId === task.id} onClick={() => onAction(task, "skip")}><SkipForward size={17} /></button> : null}
      <details className="quick-editor"><summary className="icon-button" title="Edit times and duration" aria-label={`Edit ${task.propertyName} times`}><Edit3 size={17} /></summary><form onSubmit={edit}><div className="field"><label>Checkout</label><input type="time" name="expectedCheckoutTime" /></div><div className="field"><label>Check-in</label><input type="time" name="expectedCheckinTime" /></div><div className="field"><label>Minutes</label><input type="number" name="durationMinutes" min="5" max="480" defaultValue={task.durationMinutes} required /></div><button className="button button--primary" type="submit" disabled={demoMode}>Apply</button></form></details>
    </div> : null}
  </article>;
}

export function TodayQueue({ tasks, demoMode }: { tasks: CleaningTaskView[]; demoMode: boolean }) {
  const router = useRouter();
  const [activeId, setActiveId] = useState("");
  const [message, setMessage] = useState("");
  const active = tasks.filter((task) => task.status === "cleaning_now");
  const queued = tasks.filter((task) => !["cleaning_now", "ready", "skipped"].includes(task.status));
  const completed = tasks.filter((task) => ["ready", "skipped"].includes(task.status));
  const safe = queued.filter((task) => task.warningLevel === "safe").length;
  const risk = queued.filter((task) => ["tight", "impossible", "overdue"].includes(task.warningLevel)).length;

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [router]);

  async function onAction(task: CleaningTaskView, action: string, values: Record<string, unknown> = {}) {
    if (demoMode) { setMessage("Connect Supabase to update the live queue."); return; }
    setActiveId(task.id); setMessage("");
    const response = await fetch("/api/cleaning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id, action, ...values }) });
    setActiveId("");
    setMessage(response.status === 409 ? "Another property is already being cleaned." : response.ok ? "Queue updated." : "Could not update the queue.");
    if (response.ok) router.refresh();
  }
  return <>
    <div className="queue-summary"><div><span>Remaining</span><strong>{queued.length + active.length}</strong></div><div><span>Safe</span><strong>{safe}</strong></div><div><span>At risk</span><strong className={risk ? "risk" : ""}>{risk}</strong></div><div><span>Ready</span><strong>{completed.filter((task) => task.status === "ready").length}</strong></div></div>
    {message ? <div className="notice" role="status">{message}</div> : null}
    {active.length ? <section className="queue-section queue-section--active"><div className="queue-heading"><span className="live-dot" />Cleaning now</div>{active.map((task) => <TaskCard key={task.id} task={task} demoMode={demoMode} activeId={activeId} onAction={onAction} />)}</section> : null}
    <section className="queue-section"><div className="queue-heading">Up next <span>{queued.length}</span></div><div className="queue-list">{queued.map((task) => <TaskCard key={task.id} task={task} demoMode={demoMode} activeId={activeId} onAction={onAction} />)}{!queued.length && !active.length ? <div className="list-empty"><CheckCircle2 size={26} /><span>No turnovers queued</span></div> : null}</div></section>
    {completed.length ? <details className="completed-list"><summary>Completed and skipped · {completed.length}</summary>{completed.map((task) => <TaskCard key={task.id} task={task} demoMode={demoMode} activeId={activeId} onAction={onAction} />)}</details> : null}
  </>;
}
