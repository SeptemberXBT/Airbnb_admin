"use client";

import type { CleaningTaskView } from "./cleaning-service";
import { formatCaretakerPlan } from "./caretaker-export";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  Check,
  Clock3,
  Copy,
  Edit3,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  RotateCcw,
  SkipForward,
  SquareCheckBig,
  TimerReset,
  TriangleAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type MouseEvent } from "react";

const zone = "Asia/Kolkata";
const time = (value: string | null) => value ? formatInTimeZone(new Date(value), zone, "h:mm a") : "--";
const guestTime = (serviceDate: string, value: string | null) => value
  ? formatInTimeZone(fromZonedTime(`${serviceDate}T${value}:00`, zone), zone, "h:mm a")
  : "No arrival";
const warningLabel = { safe: "Safe", tight: "Tight", impossible: "Impossible", overdue: "Overdue", waiting: "Waiting" } as const;

function TaskCard({ task, demoMode, activeId, onAction }: {
  task: CleaningTaskView;
  demoMode: boolean;
  activeId: string;
  onAction: (task: CleaningTaskView, action: string, values?: Record<string, unknown>) => Promise<void>;
}) {
  const running = task.status === "cleaning_now";
  const done = task.status === "ready";
  const finished = done || task.status === "skipped";
  async function edit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onAction(task, "edit", {
      durationMinutes: Number(data.get("durationMinutes")),
      expectedCheckoutTime: String(data.get("expectedCheckoutTime") || "") || undefined,
      expectedCheckinTime: String(data.get("expectedCheckinTime") || "") || undefined,
    });
  }
  function resetTimes(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.closest("form");
    const checkout = form?.elements.namedItem("expectedCheckoutTime") as HTMLInputElement | null;
    const checkin = form?.elements.namedItem("expectedCheckinTime") as HTMLInputElement | null;
    if (checkout) checkout.value = "11:00";
    if (checkin) checkin.value = "13:00";
  }
  return <article className={`cleaning-card ${running ? "cleaning-card--active" : ""} ${done ? "cleaning-card--done" : ""}`}>
    <div className="cleaning-card__top">
      <div className="queue-position">{running ? <LoaderCircle className="spin" size={17} /> : done ? <SquareCheckBig aria-label="Completed" size={18} /> : <span>{task.status === "skipped" ? "-" : ""}</span>}</div>
      <div className="cleaning-title"><strong>{task.propertyName}</strong><span>{running ? "Cleaning now" : done ? task.actualEnd ? `Completed at ${time(task.actualEnd)}` : "Room ready" : task.status === "skipped" ? "Skipped" : `Available ${time(task.releaseTime)}`}</span></div>
      <span className={`status status--${task.warningLevel}`} aria-label={`Schedule status: ${warningLabel[task.warningLevel]}`}>{task.warningLevel === "safe" ? <Check size={12} /> : task.warningLevel === "waiting" ? <Clock3 size={12} /> : <TriangleAlert size={12} />}{warningLabel[task.warningLevel]}</span>
    </div>
    <div className="cleaning-times">
      <div><span>Checkout</span><strong>{guestTime(task.serviceDate, task.checkoutTime)}</strong></div>
      <div><span>Clean</span><strong>{time(task.plannedStart)}</strong></div>
      <div><span>Ready</span><strong>{time(task.plannedEnd)}</strong></div>
      <div><span>Check-in</span><strong>{guestTime(task.serviceDate, task.checkinTime)}</strong></div>
      <div><span>Duration</span><strong>{task.durationMinutes} min</strong></div>
    </div>
    {!done && task.status !== "skipped" ? <div className="cleaning-actions">
      {running ? <button className="quick-action quick-action--ready" disabled={activeId === task.id} onClick={() => onAction(task, "ready")}><SquareCheckBig size={18} /> Ready</button> : <button className="quick-action quick-action--start" disabled={activeId === task.id} onClick={() => onAction(task, "start")}><Play size={17} /> Start</button>}
      {!running ? <button className="quick-action" disabled={activeId === task.id} onClick={() => onAction(task, "delay", { delayMinutes: task.delayMinutes + 10 })}><TimerReset size={17} /> Delay</button> : null}
      {!running ? <button className="icon-button" title="Skip cleaning task" aria-label={`Skip ${task.propertyName}`} disabled={activeId === task.id} onClick={() => onAction(task, "skip")}><SkipForward size={17} /></button> : null}
      <details className="quick-editor"><summary className="icon-button" title="Edit times and duration" aria-label={`Edit ${task.propertyName} times`}><Edit3 size={17} /></summary><form onSubmit={edit}><div className="field"><label>Checkout</label><input type="time" name="expectedCheckoutTime" defaultValue={task.checkoutTime} /></div><div className="field"><label>Check-in</label><input type="time" name="expectedCheckinTime" defaultValue={task.checkinTime ?? ""} disabled={!task.incomingEntryKey} /></div><div className="field"><label>Minutes</label><input type="number" name="durationMinutes" min="5" max="480" defaultValue={task.durationMinutes} required /></div><button className="button button--quiet" type="button" onClick={resetTimes}>Use standard times</button><button className="button button--primary" type="submit" disabled={demoMode}>Apply</button></form></details>
    </div> : null}
    {finished ? <div className="cleaning-actions"><button className="quick-action" type="button" aria-label={`Return ${task.propertyName} to queue`} disabled={activeId === task.id} onClick={() => onAction(task, "requeue")}><RotateCcw size={17} /> Return to queue</button></div> : null}
  </article>;
}

export function TodayQueue({ tasks, demoMode, serviceDate, dateLabel, clock }: {
  tasks: CleaningTaskView[];
  demoMode: boolean;
  serviceDate?: string;
  dateLabel?: string;
  clock?: string;
}) {
  const router = useRouter();
  const now = new Date();
  const resolvedServiceDate = serviceDate ?? formatInTimeZone(now, zone, "yyyy-MM-dd");
  const resolvedDateLabel = dateLabel ?? formatInTimeZone(now, zone, "EEEE, d MMMM");
  const resolvedClock = clock ?? formatInTimeZone(now, zone, "h:mm a");
  const [activeId, setActiveId] = useState("");
  const [message, setMessage] = useState("");
  const [fallbackText, setFallbackText] = useState("");
  const [localTasks, setLocalTasks] = useState(tasks);
  const [completedOpen, setCompletedOpen] = useState(false);
  const active = localTasks.filter((task) => task.status === "cleaning_now");
  const queued = localTasks.filter((task) => !["cleaning_now", "ready", "skipped"].includes(task.status));
  const completed = localTasks.filter((task) => ["ready", "skipped"].includes(task.status));
  const safe = queued.filter((task) => task.warningLevel === "safe").length;
  const risk = queued.filter((task) => ["tight", "impossible", "overdue"].includes(task.warningLevel)).length;
  const workRemaining = active.length + queued.length;

  async function onAction(task: CleaningTaskView, action: string, values: Record<string, unknown> = {}) {
    if (demoMode) { setMessage("Connect Supabase to update the live queue."); return; }
    if (activeId) return;
    setActiveId(task.id);
    setMessage("");
    try {
      const response = await fetch("/api/cleaning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id, action, ...values }) });
      if (!response.ok) {
        setMessage(response.status === 409 ? "Another property is already being cleaned." : "Could not update the queue.");
        return;
      }
      const nowIso = new Date().toISOString();
      setLocalTasks((current) => current.map((item) => item.id !== task.id ? item : {
        ...item,
        status: action === "requeue" ? "queued" : action === "ready" ? "ready" : action === "start" ? "cleaning_now" : action === "skip" ? "skipped" : action === "delay" ? "delayed" : item.status,
        actualStart: action === "requeue" ? null : action === "start" ? nowIso : item.actualStart,
        actualEnd: action === "requeue" ? null : action === "ready" ? nowIso : item.actualEnd,
        delayMinutes: action === "requeue" ? 0 : action === "delay" ? Number(values.delayMinutes ?? item.delayMinutes) : item.delayMinutes,
        durationMinutes: action === "edit" ? Number(values.durationMinutes ?? item.durationMinutes) : item.durationMinutes,
        checkoutTime: action === "edit" ? String(values.expectedCheckoutTime ?? item.checkoutTime) : item.checkoutTime,
        checkinTime: action === "edit" ? values.expectedCheckinTime === undefined ? item.checkinTime : String(values.expectedCheckinTime) : item.checkinTime,
      }));
      setMessage("Queue updated.");
      router.refresh();
    } finally {
      setActiveId("");
    }
  }

  async function copyPlan() {
    const text = formatCaretakerPlan(resolvedServiceDate, localTasks.map((task) => ({
      propertyName: task.propertyName,
      status: task.status,
      checkoutTime: task.checkoutTime,
      checkinTime: task.checkinTime,
      plannedStart: task.plannedStart,
      plannedEnd: task.plannedEnd,
      durationMinutes: task.durationMinutes,
    })));
    try {
      await navigator.clipboard.writeText(text);
      setFallbackText("");
      setMessage("Caretaker plan copied.");
    } catch {
      setFallbackText(text);
      setMessage("Clipboard access was unavailable. Select the plan below to copy it.");
    }
  }

  return <>
    <header className="page-header today-header"><div><p className="eyebrow">{resolvedDateLabel}</p><h1>Today&apos;s cleaning</h1></div><div className="today-header__actions"><span className="queue-clock">IST · {resolvedClock}</span><button className="button button--primary" type="button" onClick={copyPlan} disabled={!workRemaining}><Copy size={16} /> Copy caretaker plan</button></div></header>
    <div className="queue-summary"><div><span>Remaining</span><strong>{workRemaining}</strong></div><div><span>Safe</span><strong>{safe}</strong></div><div><span>At risk</span><strong className={risk ? "risk" : ""}>{risk}</strong></div><div><span>Ready</span><strong>{completed.filter((task) => task.status === "ready").length}</strong></div></div>
    {message ? <div className="notice" role="status">{message}</div> : null}
    {fallbackText ? <div className="export-fallback"><label htmlFor="caretaker-plan">Caretaker plan</label><textarea id="caretaker-plan" readOnly value={fallbackText} onFocus={(event) => event.currentTarget.select()} /></div> : null}
    {active.length ? <section className="queue-section queue-section--active"><div className="queue-heading"><span className="live-dot" />Cleaning now</div>{active.map((task) => <TaskCard key={task.id} task={task} demoMode={demoMode} activeId={activeId} onAction={onAction} />)}</section> : null}
    <section className="queue-section"><div className="queue-heading">Up next <span>{queued.length}</span></div><div className="queue-list">{queued.map((task) => <TaskCard key={task.id} task={task} demoMode={demoMode} activeId={activeId} onAction={onAction} />)}{!queued.length && !active.length ? <div className="list-empty"><SquareCheckBig size={26} /><span>No turnovers queued</span></div> : null}</div></section>
    {completed.length ? <section className="completed-list"><button className="completed-toggle" type="button" aria-expanded={completedOpen} aria-controls="completed-tasks" aria-label={`${completedOpen ? "Hide" : "Show"} completed and skipped tasks`} onClick={() => setCompletedOpen((open) => !open)}>{completedOpen ? <Minus size={16} /> : <Plus size={16} />}<span>Completed and skipped</span><strong>{completed.length}</strong></button>{completedOpen ? <div id="completed-tasks">{completed.map((task) => <TaskCard key={task.id} task={task} demoMode={demoMode} activeId={activeId} onAction={onAction} />)}</div> : null}</section> : null}
  </>;
}
