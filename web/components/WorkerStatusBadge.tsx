"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { ArrowRight, Cpu } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { formatRelativeAz, JOB_TYPE_LABELS } from "@/lib/format";
import type { WorkerStatusRow } from "@/lib/types";

interface WorkerStatusContextValue {
  workers: WorkerStatusRow[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

const WorkerStatusContext = createContext<WorkerStatusContextValue | null>(null);

export function useWorkerStatus(): WorkerStatusContextValue | null {
  return useContext(WorkerStatusContext);
}

export function WorkerStatusProvider({
  children,
  agencyId,
  initialWorkers,
}: {
  children: React.ReactNode;
  agencyId?: string | null;
  initialWorkers?: WorkerStatusRow[];
}) {
  const [workers, setWorkers] = useState<WorkerStatusRow[]>(initialWorkers ?? []);
  const [loaded, setLoaded] = useState(Boolean(initialWorkers));
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured()) return;
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("worker_status")
        .select("*")
        .order("last_seen_at", { ascending: false })
        .limit(5);
      setWorkers((data as WorkerStatusRow[] | null) ?? []);
    } catch {
      // ignore transient status errors
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let active = true;
    let fallbackTimer: NodeJS.Timeout | null = null;

    if (!initialWorkers) {
      refresh();
    }

    const supabase = createClient();
    const changeFilter = agencyId
      ? {
          event: "*" as const,
          schema: "public",
          table: "worker_heartbeats",
          filter: `agency_id=eq.${agencyId}`,
        }
      : {
          event: "*" as const,
          schema: "public",
          table: "worker_heartbeats",
        };

    const startFallbackPolling = () => {
      if (fallbackTimer) return;
      fallbackTimer = setInterval(() => {
        if (active) refresh();
      }, 30_000);
    };

    const stopFallbackPolling = () => {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase
        .channel("shared_worker_status_realtime")
        .on("postgres_changes", changeFilter, () => {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = setTimeout(() => {
            if (active) refresh();
          }, 1500);
        })
        .subscribe((status: string) => {
          if (status === "SUBSCRIBED") {
            stopFallbackPolling();
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            startFallbackPolling();
          }
        });
    } catch {
      startFallbackPolling();
    }

    return () => {
      active = false;
      stopFallbackPolling();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [agencyId, initialWorkers, refresh]);

  return (
    <WorkerStatusContext.Provider value={{ workers, loaded, refresh }}>
      {children}
    </WorkerStatusContext.Provider>
  );
}

interface WorkerStatusBadgeProps {
  initialWorkers?: WorkerStatusRow[];
  compact?: boolean;
  showMonitorLink?: boolean;
  onOpenMonitor?: () => void;
}

export function WorkerStatusBadge({
  initialWorkers,
  compact = false,
  showMonitorLink = false,
  onOpenMonitor,
}: WorkerStatusBadgeProps) {
  const sharedCtx = useWorkerStatus();
  const [localWorkers, setLocalWorkers] = useState<WorkerStatusRow[]>(
    initialWorkers ?? []
  );
  const [localLoaded, setLocalLoaded] = useState(Boolean(initialWorkers));

  useEffect(() => {
    if (initialWorkers) {
      setLocalWorkers(initialWorkers);
      setLocalLoaded(true);
    }
  }, [initialWorkers]);

  useEffect(() => {
    if (initialWorkers || sharedCtx || !isSupabaseConfigured()) return;
    let active = true;
    const supabase = createClient();

    async function fetchOnce() {
      try {
        const { data } = await supabase
          .from("worker_status")
          .select("*")
          .order("last_seen_at", { ascending: false })
          .limit(5);
        if (active) {
          setLocalWorkers((data as WorkerStatusRow[] | null) ?? []);
          setLocalLoaded(true);
        }
      } catch {
        if (active) setLocalLoaded(true);
      }
    }

    fetchOnce();
    return () => {
      active = false;
    };
  }, [initialWorkers, sharedCtx]);

  const workers = initialWorkers ? localWorkers : (sharedCtx?.workers ?? localWorkers);
  const loaded = initialWorkers ? localLoaded : (sharedCtx?.loaded ?? localLoaded);

  const primary = workers[0] ?? null;
  const metaState = String(primary?.metadata_json?.state || "").toUpperCase();
  const isStopped = metaState === "STOPPED";
  const isOnline = Boolean(primary?.is_online) && !isStopped;
  const isBusy =
    isOnline &&
    (Boolean(primary?.current_job_id) || metaState === "PROCESSING");

  if (compact) {
    return (
      <Link
        href="/jobs?tab=worker"
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition hover:brightness-110 ${
          isBusy
            ? "border-violet-500/40 bg-violet-500/15 text-violet-200"
            : isOnline
              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
              : "border-slate-700/80 bg-obsidian-850 text-slate-400 hover:text-slate-200"
        }`}
        title={
          primary
            ? `Bulud Worker (${primary.worker_id}) • Son siqnal: ${formatRelativeAz(primary.last_seen_at)} — Monitoru aç`
            : "Bulud Worker (Railway) monitorunu aç"
        }
      >
        <span className="relative flex h-2 w-2">
          {isOnline && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${
                isBusy ? "bg-violet-400" : "bg-emerald-400"
              }`}
            />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              isBusy
                ? "bg-violet-400"
                : isOnline
                  ? "bg-emerald-400"
                  : "bg-slate-500"
            }`}
          />
        </span>
        <span>
          {!loaded
            ? "Worker..."
            : isBusy
              ? "Worker İşləyir"
              : isOnline
                ? "Worker Onlayn"
                : "Worker Oflayn"}
        </span>
      </Link>
    );
  }

  const phaseText =
    typeof primary?.metadata_json?.current_phase === "string"
      ? primary.metadata_json.current_phase
      : null;

  return (
    <div className="exec-card flex flex-wrap items-center justify-between gap-4 p-4">
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
            isBusy
              ? "border-violet-500/40 bg-violet-500/15 text-violet-300"
              : isOnline
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-slate-700 bg-obsidian-850 text-slate-400"
          }`}
        >
          <Cpu className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">
              Bulud Worker (Railway)
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                isBusy
                  ? "border-violet-500/40 bg-violet-500/15 text-violet-300"
                  : isOnline
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isBusy
                    ? "bg-violet-400 animate-pulse"
                    : isOnline
                      ? "bg-emerald-400 animate-pulse"
                      : "bg-rose-400"
                }`}
              />
              {isBusy ? "İŞLƏYİR" : isOnline ? "ONLAYN" : "OFLAYN"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400 truncate">
            {primary
              ? `${primary.worker_id} • Son siqnal: ${formatRelativeAz(primary.last_seen_at)}${isOnline && phaseText ? ` • ${phaseText}` : ""}`
              : "Hələ heç bir bulud worker siqnalı qeydə alınmayıb (Railway xidmətini yoxlayın)"}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {primary?.current_job_type && isOnline && (
          <div className="hidden sm:block text-right">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">
              Aktiv İş
            </p>
            <p className="text-xs font-medium text-gold-300">
              {JOB_TYPE_LABELS[primary.current_job_type] ??
                primary.current_job_type}
            </p>
          </div>
        )}

        {onOpenMonitor ? (
          <button
            type="button"
            onClick={onOpenMonitor}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gold-500/35 bg-gold-500/10 px-3 py-1.5 text-xs font-semibold text-gold-300 hover:bg-gold-500/20 transition"
          >
            <span>Worker Monitoru</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        ) : showMonitorLink ? (
          <Link
            href="/jobs?tab=worker"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gold-500/35 bg-gold-500/10 px-3 py-1.5 text-xs font-semibold text-gold-300 hover:bg-gold-500/20 transition"
          >
            <span>Worker Monitoru</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
