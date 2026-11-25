"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Server,
  Terminal,
} from "lucide-react";
import {
  formatBakuDateTime,
  formatBakuTime,
  formatDurationAz,
  formatRelativeAz,
  JOB_TYPE_LABELS,
} from "@/lib/format";
import type { PipelineJob, WorkerStatusRow } from "@/lib/types";

interface WorkerLivePanelProps {
  workers: WorkerStatusRow[];
  jobs: PipelineJob[];
}

const STARTUP_COMMAND =
  "powershell -ExecutionPolicy Bypass -File scripts\\setup_worker_service.ps1 -Start";

export function WorkerLivePanel({ workers, jobs }: WorkerLivePanelProps) {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const tickTimer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tickTimer);
  }, []);

  const primary = workers[0] ?? null;
  const meta = primary?.metadata_json ?? {};
  const metaState = String(meta.state || "").toUpperCase();
  const isStopped = metaState === "STOPPED";
  const isRestarting = metaState === "RESTARTING";
  const isOnline = Boolean(primary?.is_online) && !isStopped;

  const activeJob = useMemo(() => {
    const running = jobs.find((j) => j.status === "RUNNING");
    if (running) return running;
    if (primary?.current_job_id) {
      return jobs.find((j) => j.id === primary.current_job_id) ?? null;
    }
    return null;
  }, [jobs, primary]);

  const isBusy =
    isOnline &&
    (Boolean(activeJob) ||
      Boolean(primary?.current_job_id) ||
      metaState === "PROCESSING");

  const queuedCount = useMemo(
    () => jobs.filter((j) => j.status === "QUEUED").length,
    [jobs]
  );

  const succeededRecentCount = useMemo(
    () => jobs.filter((j) => j.status === "SUCCEEDED").length,
    [jobs]
  );

  const failedRecentCount = useMemo(
    () => jobs.filter((j) => j.status === "FAILED").length,
    [jobs]
  );

  const logs = useMemo(() => {
    const raw = Array.isArray(meta.recent_logs) ? meta.recent_logs : [];
    return [...raw].reverse();
  }, [meta.recent_logs]);

  const activeBinaId =
    activeJob?.listings?.bina_id ||
    primary?.current_listing_bina_id ||
    (typeof meta.current_bina_id === "string" ? meta.current_bina_id : null);

  const activeTitle =
    activeJob?.listings?.title || primary?.current_listing_title || null;

  const activeStartedAt =
    activeJob?.started_at || primary?.current_job_started_at || null;

  const uptimeText = useMemo(() => {
    if (!isOnline || !meta.started_at) return "—";
    return formatDurationAz(meta.started_at, new Date(nowMs).toISOString());
  }, [isOnline, meta.started_at, nowMs]);

  async function handleCopyStartupCommand() {
    try {
      await navigator.clipboard.writeText(STARTUP_COMMAND);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2000);
    } catch {
      setCopiedCmd(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Worker Hero Telemetry Card */}
      <div className="exec-card p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div
              className={`flex h-11 w-11 items-center justify-center rounded-2xl border ${
                isBusy
                  ? "border-violet-500/50 bg-violet-500/15 text-violet-300"
                  : isOnline
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                    : isRestarting
                      ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                      : "border-rose-500/40 bg-rose-500/10 text-rose-300"
              }`}
            >
              <Server className="h-5 w-5" />
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-base font-bold text-slate-100 font-mono">
                  {primary?.worker_id ?? "win-local-worker"}
                </h2>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                    isBusy
                      ? "border-violet-500/50 bg-violet-500/15 text-violet-200"
                      : isOnline
                        ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                        : isRestarting
                          ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                          : "border-rose-500/40 bg-rose-500/15 text-rose-300"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isBusy
                        ? "bg-violet-400 animate-ping"
                        : isOnline
                          ? "bg-emerald-400 animate-pulse"
                          : isRestarting
                            ? "bg-amber-400 animate-pulse"
                            : "bg-rose-400"
                    }`}
                  />
                  <span>
                    {isBusy
                      ? "İŞLƏYİR"
                      : isOnline
                        ? "ONLAYN"
                        : isRestarting
                          ? "BƏRPA OLUNUR"
                          : "OFLAYN"}
                  </span>
                </span>
                {typeof meta.pid === "number" && (
                  <span className="rounded-md border border-slate-800 bg-obsidian-950 px-2 py-0.5 font-mono text-[11px] text-slate-400">
                    PID {meta.pid}
                  </span>
                )}
              </div>

              <p className="mt-1 text-xs text-slate-400">
                {primary?.last_seen_at
                  ? `Son siqnal: ${formatBakuDateTime(primary.last_seen_at)} (${formatRelativeAz(primary.last_seen_at)})`
                  : "Hələ heç bir siqnal qeydə alınmayıb"}
              </p>
            </div>
          </div>

          <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-obsidian-950/70 px-3 py-1.5 text-xs text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Canlı Yeniləmə: 5 san</span>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              İşləmə Müddəti
            </p>
            <p className="mt-1.5 text-lg font-bold text-slate-100">
              {uptimeText}
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Növbəti Avto-Yığım
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 text-lg font-bold text-gold-300">
              <CalendarClock className="h-4 w-4 text-gold-400" />
              <span>{meta.next_schedule_baku || "12:30 / 19:30"}</span>
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Hazırda Növbədə
            </p>
            <p className="mt-1.5 text-lg font-bold text-slate-100">
              {queuedCount} gözləyir • {meta.jobs_processed_session ?? 0} bitib
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Son Tapşırıqlar
            </p>
            <p className="mt-1.5 text-lg font-bold">
              <span className="text-emerald-400">
                {succeededRecentCount} uğurlu
              </span>
              {failedRecentCount > 0 && (
                <span className="text-rose-400 text-sm ml-2">
                  • {failedRecentCount} xəta
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Live Phase OR Offline Guide */}
        {!isOnline ? (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-amber-200">
                  Kompüterdəki worker hazırda oflayndır
                </p>
                <p className="text-xs text-amber-100/80 leading-relaxed">
                  Video montajı (ElevenLabs + FFmpeg) və bina.az yığımı sizin
                  Windows kompüterinizdə icra olunur. Əl ilə işə salmaq üçün bu
                  əmri PowerShell-də çalışdırın:
                </p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-obsidian-950/90 px-3 py-2">
              <code className="font-mono text-xs text-amber-200 overflow-x-auto">
                {STARTUP_COMMAND}
              </code>
              <button
                type="button"
                onClick={handleCopyStartupCommand}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-500/30 shrink-0 transition"
              >
                {copiedCmd ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Kopyalandı!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Kopyala</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : isBusy ? (
          <div className="rounded-xl border border-violet-500/40 bg-violet-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-violet-400 animate-ping" />
                <span className="text-sm font-bold text-violet-200">
                  {meta.current_phase || "Aktiv tapşırıq icra olunur"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                {(activeJob?.job_type || primary?.current_job_type) && (
                  <span>
                    {JOB_TYPE_LABELS[
                      (activeJob?.job_type || primary?.current_job_type)!
                    ] ??
                      activeJob?.job_type ??
                      primary?.current_job_type}
                  </span>
                )}
                {activeBinaId && (
                  <Link
                    href={`/listings/${activeBinaId}`}
                    className="inline-flex items-center gap-1 rounded bg-gold-500/20 px-2 py-0.5 font-mono font-semibold text-gold-300 hover:underline"
                  >
                    <span>#{activeBinaId}</span>
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
                {activeTitle && (
                  <span className="text-slate-400">{activeTitle}</span>
                )}
              </div>
            </div>

            {activeStartedAt && (
              <div className="flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-obsidian-950/70 px-3 py-1.5 text-xs font-mono font-semibold text-violet-200 shrink-0">
                <Clock className="h-3.5 w-3.5" />
                <span>
                  {formatDurationAz(
                    activeStartedAt,
                    new Date(nowMs).toISOString()
                  )}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-emerald-200">
                {meta.current_phase || "Hazır — tapşırıq gözlənilir"}
              </p>
              <p className="text-xs text-emerald-100/75">
                Kompüter aktivdir və hər 2 saniyədən bir yeni video render və ya
                yığım əmrini yoxlayır.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Live Terminal Console Stream */}
      <div className="exec-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3 bg-obsidian-900/90">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-gold-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Canlı Konsol Logları
            </h3>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Son {logs.length} sətir
          </span>
        </div>

        <div className="bg-obsidian-950/95 p-4 max-h-80 overflow-y-auto font-mono text-xs space-y-1.5">
          {logs.length === 0 ? (
            <p className="text-slate-500 py-4 text-center">
              Hələ canlı konsol logu ötürülməyib. Worker işə düşdükdə son
              əməliyyat sətirləri burada canlı görünəcək.
            </p>
          ) : (
            logs.map((entry, idx) => {
              const lvl = (entry.level || "INFO").toUpperCase();
              const lvlCls =
                lvl === "ERROR" || lvl === "CRITICAL"
                  ? "text-rose-400"
                  : lvl === "WARNING"
                    ? "text-amber-300"
                    : "text-emerald-400";

              return (
                <div
                  key={`${entry.ts}-${idx}`}
                  className="flex items-start gap-2.5 border-b border-slate-900/70 pb-1 last:border-b-0"
                >
                  <span className="text-slate-500 shrink-0">
                    {formatBakuTime(entry.ts)}
                  </span>
                  <span className={`font-semibold shrink-0 w-16 ${lvlCls}`}>
                    [{lvl}]
                  </span>
                  <span className="text-slate-200 break-words leading-relaxed">
                    {entry.msg}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkerMonitorClient({
  initialWorkers,
  initialJobs,
}: {
  initialWorkers: WorkerStatusRow[];
  initialJobs: PipelineJob[];
}) {
  return <WorkerLivePanel workers={initialWorkers} jobs={initialJobs} />;
}
