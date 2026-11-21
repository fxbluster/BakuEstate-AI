"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { formatRelativeAz, JOB_TYPE_LABELS } from "@/lib/format";
import type { WorkerStatusRow } from "@/lib/types";

interface WorkerStatusBadgeProps {
  initialWorkers?: WorkerStatusRow[];
  compact?: boolean;
}

export function WorkerStatusBadge({
  initialWorkers,
  compact = false,
}: WorkerStatusBadgeProps) {
  const [workers, setWorkers] = useState<WorkerStatusRow[]>(
    initialWorkers ?? []
  );
  const [loaded, setLoaded] = useState(Boolean(initialWorkers));

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let active = true;
    const supabase = createClient();

    async function fetchStatus() {
      const { data } = await supabase
        .from("worker_status")
        .select("*")
        .order("last_seen_at", { ascending: false })
        .limit(5);
      if (active) {
        setWorkers((data as WorkerStatusRow[] | null) ?? []);
        setLoaded(true);
      }
    }

    if (!initialWorkers) {
      fetchStatus();
    }

    const timer = setInterval(fetchStatus, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [initialWorkers]);

  const primary = workers[0] ?? null;
  const isOnline = Boolean(primary?.is_online);

  if (compact) {
    return (
      <div
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
          isOnline
            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
            : "border-slate-700/80 bg-obsidian-850 text-slate-400"
        }`}
        title={
          primary
            ? `Worker: ${primary.worker_id} • Son siqnal: ${formatRelativeAz(primary.last_seen_at)}`
            : "Lokal Windows Worker hələ qoşulmayıb"
        }
      >
        <span className="relative flex h-2 w-2">
          {isOnline && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              isOnline ? "bg-emerald-400" : "bg-slate-500"
            }`}
          />
        </span>
        <span>
          {!loaded
            ? "Worker..."
            : isOnline
              ? "Worker Onlayn"
              : "Worker Oflayn"}
        </span>
      </div>
    );
  }

  return (
    <div className="exec-card flex items-center justify-between gap-4 p-4">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
            isOnline
              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
              : "border-slate-700 bg-obsidian-850 text-slate-400"
          }`}
        >
          <Cpu className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">
              Lokal Windows Worker
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                isOnline
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-300"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isOnline ? "bg-emerald-400" : "bg-rose-400"
                }`}
              />
              {isOnline ? "ONLAYN" : "OFLAYN"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {primary
              ? `${primary.worker_id} • Son ürək döyüntüsü: ${formatRelativeAz(primary.last_seen_at)}`
              : "Hələ heç bir lokal worker ürək döyüntüsü qeydə alınmayıb (PC sönülü ola bilər)"}
          </p>
        </div>
      </div>

      {primary?.current_job_type && isOnline && (
        <div className="hidden sm:block text-right">
          <p className="text-[11px] uppercase tracking-wider text-slate-500">
            Aktiv İş
          </p>
          <p className="text-xs font-medium text-gold-300">
            {JOB_TYPE_LABELS[primary.current_job_type] ?? primary.current_job_type}
          </p>
        </div>
      )}
    </div>
  );
}
