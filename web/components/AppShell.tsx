"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Building2,
  Cpu,
  LayoutDashboard,
  LogOut,
  Users,
  Sparkles,
  Zap,
} from "lucide-react";
import { WorkerStatusBadge, WorkerStatusProvider } from "./WorkerStatusBadge";
import { CockpitCardHUD } from "./CockpitCardHUD";
import { CopilotProvider, useCopilot } from "@/lib/copilot-context";
import { createClient } from "@/lib/supabase/client";
import { AgentHubDrawer } from "./hub/AgentHubDrawer";
import { FloatingCardStage } from "./hub/stage/FloatingCardStage";

export interface AppShellMember {
  user_id?: string;
  agency_id?: string;
  role: "ADMIN" | "BROKER" | "SMM" | string;
  display_name: string;
  is_active?: boolean;
}

const NAV_ITEMS = [
  { href: "/", label: "İcmal", shortLabel: "İcmal", icon: LayoutDashboard },
  {
    href: "/listings",
    label: "Elanlar Reyestri",
    shortLabel: "Elanlar",
    icon: Building2,
  },
  {
    href: "/analytics",
    label: "Analitika",
    shortLabel: "Analitika",
    icon: BarChart3,
  },
  {
    href: "/leads",
    label: "Müştəri CRM",
    shortLabel: "Müştərilər",
    icon: Users,
  },
  {
    href: "/jobs",
    label: "İş Növbəsi & Worker",
    shortLabel: "Növbə",
    icon: Cpu,
  },
];

function CopilotSidebarButton() {
  const { openAgentHub } = useCopilot();

  return (
    <button
      type="button"
      onClick={() => openAgentHub("mudir")}
      className="w-full flex items-center justify-between gap-2.5 rounded-xl border border-gold-400/40 bg-gradient-to-r from-gold-500/20 via-gold-500/10 to-transparent p-3 text-left transition hover:border-gold-400 hover:bg-gold-500/25 group"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-gold-400 to-amber-500 text-obsidian-950 shadow-sm">
          <Zap className="h-4 w-4 fill-obsidian-950 text-obsidian-950" />
        </div>
        <div>
          <p className="text-xs font-bold text-gold-300 group-hover:text-gold-200">
            ⚡ AI Qərargahı
          </p>
          <p className="text-[10px] text-slate-400">
            Copilot • Danışıq Qalxanı
          </p>
        </div>
      </div>
      <span className="text-[10px] font-bold uppercase tracking-wider text-gold-400 bg-gold-500/20 px-2 py-0.5 rounded-full border border-gold-400/30">
        Aç
      </span>
    </button>
  );
}

function CopilotFloatingTrigger() {
  const { openAgentHub } = useCopilot();

  return (
    <button
      type="button"
      onClick={() => openAgentHub("mudir")}
      className="md:hidden fixed bottom-20 right-4 z-50 flex items-center gap-2 rounded-full border border-gold-400/60 bg-gradient-to-r from-gold-500 via-gold-400 to-amber-500 px-4 py-2.5 text-xs font-extrabold text-obsidian-950 shadow-[0_10px_35px_rgba(207,160,65,0.5)] hover:brightness-110 active:scale-95 transition-all cursor-pointer"
      aria-label="AI Qərargahını Aç"
    >
      <Zap className="h-4 w-4 fill-obsidian-950 text-obsidian-950" />
      <span className="tracking-wide">AI Qərargahı</span>
    </button>
  );
}

function AppShellContent({
  children,
  pathname,
  member,
}: {
  children: React.ReactNode;
  pathname: string;
  member: AppShellMember | null;
}) {
  const router = useRouter();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    if (href === "/jobs" && pathname.startsWith("/worker")) return true;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  async function handleSignOut() {
    if (typeof window !== "undefined") {
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key && key.startsWith("bakuestate_")) {
            keysToRemove.push(key);
          }
        }
        for (const k of keysToRemove) {
          localStorage.removeItem(k);
        }
        localStorage.removeItem("last_cockpit_generated_at");
      } catch {
        // ignore storage errors
      }
    }

    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch {
      // ignore signOut network error and proceed to login
    }

    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Desktop Executive Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 border-r border-slate-800/80 bg-obsidian-900/95 backdrop-blur-md z-30">
        <div className="flex items-center gap-3 px-5 py-5 border-b border-slate-800/80">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 text-obsidian-950 shadow-md">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-bold tracking-tight text-slate-100">
              BakuEstate-AI
            </p>
            <p className="text-[11px] font-medium uppercase tracking-widest text-gold-400">
              24/7 Veb CRM
            </p>
          </div>
        </div>

        <nav className="flex-1 space-y-1.5 px-3 py-4">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                  active
                    ? "bg-gold-500/15 text-gold-300 border border-gold-500/30 shadow-sm"
                    : "text-slate-400 hover:bg-obsidian-850 hover:text-slate-100 border border-transparent"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </Link>
            );
          })}

          <div className="pt-4">
            <CopilotSidebarButton />
          </div>
        </nav>

        <div className="space-y-3 border-t border-slate-800/80 p-4">
          <WorkerStatusBadge compact />
          <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-800/70 bg-obsidian-950/50 px-3 py-2 text-xs">
            <div className="min-w-0">
              <p className="truncate font-semibold text-slate-200">
                {member?.display_name || "Operator"}
              </p>
              <p className="text-[10px] font-mono uppercase tracking-wider text-gold-400">
                {member?.role || "BROKER"}
              </p>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-obsidian-900 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-rose-500/40 hover:text-rose-200 transition"
              title="Çıxış (Sign Out)"
              aria-label="Sign Out"
            >
              <LogOut className="h-3 w-3" />
              <span>Çıxış</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Top Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800/80 bg-obsidian-900/95 px-4 py-3 backdrop-blur-md md:hidden">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 text-obsidian-950">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-bold leading-none text-slate-100">
              BakuEstate-AI
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-wider text-gold-400">
              {member?.role || "Veb CRM"}
            </p>
          </div>
        </Link>

        <div className="flex items-center gap-2">
          <WorkerStatusBadge compact />
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 md:pl-64 pb-20 md:pb-8">
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
          {pathname === "/" && <CockpitCardHUD agencyId={member?.agency_id} />}
          {children}
        </div>
      </main>

      {/* Mobile Bottom Tab Bar */}
      <nav className="fixed bottom-0 inset-x-0 z-30 flex items-center justify-around border-t border-slate-800/90 bg-obsidian-900/95 px-2 py-2 backdrop-blur-md md:hidden">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-1 rounded-xl px-3 py-1.5 text-[11px] font-medium transition ${
                active ? "text-gold-300" : "text-slate-400"
              }`}
            >
              <Icon className="h-5 w-5" />
              <span>{item.shortLabel}</span>
            </Link>
          );
        })}
      </nav>

      {/* Persistent Floating Copilot Trigger Button */}
      <CopilotFloatingTrigger />

      {/* Autonomous Floating Card Stage */}
      <FloatingCardStage />

      {/* Slide-over Agent Hub Drawer */}
      <AgentHubDrawer />
    </div>
  );
}

export function AppShell({
  children,
  member,
  initialMember,
}: {
  children: React.ReactNode;
  member?: AppShellMember | null;
  initialMember?: AppShellMember | null;
}) {
  const pathname = usePathname();
  const activeMember = member ?? initialMember ?? null;

  if (pathname === "/login") {
    return <>{children}</>;
  }

  return (
    <CopilotProvider>
      <WorkerStatusProvider agencyId={activeMember?.agency_id}>
        <AppShellContent pathname={pathname} member={activeMember}>
          {children}
        </AppShellContent>
      </WorkerStatusProvider>
    </CopilotProvider>
  );
}
