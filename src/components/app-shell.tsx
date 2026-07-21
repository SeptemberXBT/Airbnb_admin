"use client";

import {
  Building2,
  CalendarDays,
  ClipboardCheck,
  IndianRupee,
  House,
  ReceiptText,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PropsWithChildren } from "react";
import { ConnectionStatus } from "./connection-status";
import { SharedWorkspaceRefresh } from "./shared-workspace-refresh";

const destinations = [
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/today", label: "Today", icon: ClipboardCheck },
  { href: "/properties", label: "Properties", icon: Building2 },
  { href: "/pricing", label: "Pricing", icon: IndianRupee },
  { href: "/bookings", label: "Bookings", icon: ReceiptText },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavigationLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname() ?? "";

  return destinations.map(({ href, label, icon: Icon }) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        className={mobile ? `bottom-nav__link ${active ? "is-active" : ""}` : `side-nav__link ${active ? "is-active" : ""}`}
        href={href}
        key={href}
        aria-current={active ? "page" : undefined}
      >
        <Icon aria-hidden="true" size={mobile ? 21 : 19} strokeWidth={1.9} />
        <span>{label}</span>
      </Link>
    );
  });
}

export function AppShell({ children }: PropsWithChildren) {
  return (
    <div className="app-shell">
      <ConnectionStatus />
      <SharedWorkspaceRefresh />
      <aside className="sidebar">
        <Link href="/calendar" className="brand" aria-label="Noir Haus Admin calendar">
          <span className="brand__mark"><House aria-hidden="true" size={18} /></span>
          <span><strong>Noir Haus</strong><small>Admin</small></span>
        </Link>
        <nav className="side-nav" aria-label="Primary navigation">
          <NavigationLinks />
        </nav>
        <div className="sidebar__footer">
          <span className="live-dot" aria-hidden="true" />
          <span>India Standard Time</span>
        </div>
      </aside>
      <main className="main-content">{children}</main>
      <nav className="bottom-nav" aria-label="Primary navigation">
        <NavigationLinks mobile />
      </nav>
    </div>
  );
}
