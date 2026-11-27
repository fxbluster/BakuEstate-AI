"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Cloud,
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
  statusCounts?: Record<string, number>;
}

function getReplicaState(worker: WorkerStatusRow, jobs: PipelineJob[]) {
  const meta = worker.metadata_json ?? {};
  const metaState = String(meta.state || "").toUpperCase();
  const isStopped = metaState === "STOPPED";
  const isRestarting = metaState === "RESTARTING";
  const isOnline = Boolean(worker.is_online) && !isStopped;

  const activeJob =
    jobs.find(
      (j) =>
        j.status === "RUNNING" &&
        (j.locked_by === worker.worker_id || j.id === worker.current_job_id)
    ) ??
    (worker.current_job_id
      ? jobs.find((j) => j.id === worker.current_job_id) ?? null
      : null);

  const isBusy =
    isOnline &&
    (Boolean(activeJob) ||
      Boolean(worker.current_job_id) ||
      metaState === "PROCESSING");

  const activeBinaId =
    activeJob?.listings?.bina_id ||
    worker.current_listing_bina_id ||
    (typeof meta.current_bina_id === "string" ? meta.current_bina_id : null);

  const activeListingLinkId =
    activeBinaId || activeJob?.listing_id || null;

  const activeTitle =
    activeJob?.listings?.title || worker.current_listing_title || null;

  const activeStartedAt =
    activeJob?.started_at || worker.current_job_started_at || null;

  const activeJobType = activeJob?.job_type || worker.current_job_type || null;

  return {
    meta,
    metaState,
    isStopped,
    isRestarting,
    isOnline,
    isBusy,
    activeJob,
    activeBinaId,
    activeListingLinkId,
    activeTitle,
    activeStartedAt,
    activeJobType,
  };
}

export function WorkerLivePanel({
  workers,
  jobs,
  statusCounts,
}: WorkerLivePanelProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>(
    workers[0]?.worker_id ?? ""
  );

  useEffect(() => {
    const tickTimer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tickTimer);
  }, []);

  const replicaViews = useMemo(
    () =>
      workers.map((worker) => ({
        worker,
        ...getReplicaState(worker, jobs),
      })),
    [workers, jobs]
  );

  const onlineCount = useMemo(
    () => replicaViews.filter((r) => r.isOnline).length,
    [replicaViews]
  );

  const restartingCount = useMemo(
    () => replicaViews.filter((r) => r.isRestarting).length,
    [replicaViews]
  );

  const displayedReplicas = useMemo(() => {
    if (onlineCount > 0 || restartingCount > 0) {
      return replicaViews.filter((r) => r.isOnline || r.isRestarting);
    }
    return replicaViews.slice(0, 1);
  }, [replicaViews, onlineCount, restartingCount]);

  useEffect(() => {
    if (
      displayedReplicas.length > 0 &&
      !displayedReplicas.some((r) => r.worker.worker_id === selectedWorkerId)
    ) {
      setSelectedWorkerId(displayedReplicas[0].worker.worker_id);
    }
  }, [displayedReplicas, selectedWorkerId]);

  const busyCount = useMemo(
    () => displayedReplicas.filter((r) => r.isBusy).length,
    [displayedReplicas]
  );

  const totalSessionProcessed = useMemo(
    () =>
      displayedReplicas.reduce(
        (sum, r) => sum + Number(r.meta.jobs_processed_session ?? 0),
        0
      ),
    [displayedReplicas]
  );

  const nextScheduleBaku = useMemo(() => {
    for (const r of displayedReplicas) {
      if (r.meta.next_schedule_baku) return r.meta.next_schedule_baku;
    }
    return "pg_cron • 12:30 / 19:30";
  }, [displayedReplicas]);

  const queuedCount = useMemo(
    () => statusCounts?.QUEUED ?? jobs.filter((j) => j.status === "QUEUED").length,
    [jobs, statusCounts]
  );

  const succeededRecentCount = useMemo(
    () =>
      statusCounts?.SUCCEEDED ??
      jobs.filter((j) => j.status === "SUCCEEDED").length,
    [jobs, statusCounts]
  );

  const failedRecentCount = useMemo(
    () => statusCounts?.FAILED ?? jobs.filter((j) => j.status === "FAILED").length,
    [jobs, statusCounts]
  );

  const selectedReplica = useMemo(
    () =>
      displayedReplicas.find((r) => r.worker.worker_id === selectedWorkerId) ??
      displayedReplicas[0] ??
      null,
    [displayedReplicas, selectedWorkerId]
  );

  const logs = useMemo(() => {
    const raw = Array.isArray(selectedReplica?.meta.recent_logs)
      ? selectedReplica.meta.recent_logs
      : [];
    return [...raw].reverse();
  }, [selectedReplica]);

  return (
    <div className="space-y-4">
      {/* Fleet Summary Telemetry Card */}
      <div className="exec-card p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div
              className={`flex h-11 w-11 items-center justify-center rounded-2xl border ${
                busyCount > 0
                  ? "border-violet-500/50 bg-violet-500/15 text-violet-300"
                  : onlineCount > 0
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-300"
              }`}
            >
              <Cloud className="h-5 w-5" />
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-base font-bold text-slate-100">
                  Railway Bulud Worker Flotu
                </h2>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                    onlineCount > 0
                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                      : "border-rose-500/40 bg-rose-500/15 text-rose-300"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      busyCount > 0
                        ? "bg-violet-400 animate-ping"
                        : onlineCount > 0
                          ? "bg-emerald-400 animate-pulse"
                          : "bg-rose-400"
                    }`}
                  />
                  <span>
                    {onlineCount} / {displayedReplicas.length} Replika Onlayn
                  </span>
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Bulud Docker replikaları • Cloudflare R2 video saxlancı • Avtomatik paralel iş növbəsi
              </p>
            </div>
          </div>

          <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-obsidian-950/70 px-3 py-1.5 text-xs text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Canlı Realtime Telemetriya</span>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Aktiv Konteynerlər
            </p>
            <p className="mt-1.5 text-lg font-bold text-slate-100">
              {onlineCount} onlayn • {busyCount} işləyir
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Növbəti Avto-Yığım
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 text-lg font-bold text-gold-300">
              <CalendarClock className="h-4 w-4 text-gold-400" />
              <span>{nextScheduleBaku}</span>
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Hazırda Növbədə
            </p>
            <p className="mt-1.5 text-lg font-bold text-slate-100">
              {queuedCount} gözləyir • {totalSessionProcessed} bitib
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

        {/* All Offline Cloud Guidance Banner */}
        {onlineCount === 0 && (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-200">
                Railway bulud worker replikaları hazırda oflayndır
              </p>
              <p className="text-xs text-amber-100/80 leading-relaxed">
                Video montajı (FFmpeg &lt;= 18 MB + R2 yükləmə) və avtomatik
                yığım Railway Docker konteynerlərində icra olunur. Railway
                panelindən replika sağlamlığını və son deploy loglarını yoxlayın.
              </p>
            </div>
          </div>
        )}

        {/* Multi-Replica Container List */}
        {displayedReplicas.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-xs text-slate-400">
            Hələ heç bir Railway worker replikası siqnal (heartbeat) göndərməyib.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {displayedReplicas.map((rep) => {
              const isSelected =
                selectedReplica?.worker.worker_id === rep.worker.worker_id;
              const uptimeText =
                rep.isOnline && rep.meta.started_at
                  ? formatDurationAz(
                      rep.meta.started_at,
                      new Date(nowMs).toISOString()
                    )
                  : "—";

              return (
                <div
                  key={rep.worker.worker_id}
                  className={`rounded-xl border p-4 space-y-3 transition ${
                    isSelected
                      ? "border-gold-500/50 bg-obsidian-950/90"
                      : "border-slate-800/80 bg-obsidian-950/60 hover:border-slate-700"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Server className="h-4 w-4 text-gold-400 shrink-0" />
                      <span className="font-mono text-sm font-bold text-slate-100 truncate">
                        {rep.worker.worker_id}
                      </span>
                      {typeof rep.meta.pid === "number" && (
                        <span className="rounded border border-slate-800 bg-obsidian-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                          PID {rep.meta.pid}
                        </span>
                      )}
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${
                        rep.isBusy
                          ? "border-violet-500/50 bg-violet-500/15 text-violet-200"
                          : rep.isOnline
                            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                            : rep.isRestarting
                              ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                              : "border-rose-500/40 bg-rose-500/15 text-rose-300"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          rep.isBusy
                            ? "bg-violet-400 animate-ping"
                            : rep.isOnline
                              ? "bg-emerald-400 animate-pulse"
                              : rep.isRestarting
                                ? "bg-amber-400 animate-pulse"
                                : "bg-rose-400"
                        }`}
                      />
                      <span>
                        {rep.isBusy
                          ? "İŞLƏYİR"
                          : rep.isOnline
                            ? "ONLAYN"
                            : rep.isRestarting
                              ? "BƏRPA OLUNUR"
                              : "OFLAYN"}
                      </span>
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    <span>
                      Son siqnal:{" "}
                      {rep.worker.last_seen_at
                        ? `${formatBakuDateTime(rep.worker.last_seen_at)} (${formatRelativeAz(rep.worker.last_seen_at)})`
                        : "—"}
                    </span>
                    <span>• İşləmə: {uptimeText}</span>
                    <span>• Bitib: {rep.meta.jobs_processed_session ?? 0}</span>
                  </div>

                  {rep.isBusy ? (
                    <div className="rounded-lg border border-violet-500/35 bg-violet-500/10 p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-violet-200">
                          {rep.meta.current_phase || "Aktiv tapşırıq icra olunur"}
                        </span>
                        {rep.activeStartedAt && (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-violet-200 shrink-0">
                            <Clock className="h-3 w-3" />
                            {formatDurationAz(
                              rep.activeStartedAt,
                              new Date(nowMs).toISOString()
                            )}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
                        {rep.activeJobType && (
                          <span>
                            {JOB_TYPE_LABELS[rep.activeJobType] ??
                              rep.activeJobType}
                          </span>
                        )}
                        {rep.activeListingLinkId && (
                          <Link
                            href={`/listings/${rep.activeListingLinkId}`}
                            className="inline-flex items-center gap-1 rounded bg-gold-500/20 px-1.5 py-0.5 font-mono font-semibold text-gold-300 hover:underline"
                          >
                            <span>
                              {rep.activeBinaId
                                ? `#${rep.activeBinaId}`
                                : "OFF-MARKET"}
                            </span>
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        )}
                        {rep.activeTitle && (
                          <span className="text-slate-400 truncate">
                            {rep.activeTitle}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : rep.isOnline ? (
                    <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 flex items-center gap-2 text-xs text-emerald-200">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      <span>
                        {rep.meta.current_phase ||
                          "Hazır — növbəti bulud tapşırığı gözlənilir"}
                      </span>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-200/90">
                      Konteyner dayandırılıb və ya heartbeat vaxtı bitib.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Live Terminal Console Stream with Replica Tabs */}
      <div className="exec-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3 bg-obsidian-900/90">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-gold-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Canlı Konsol Logları
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {displayedReplicas.map((rep) => {
              const active =
                selectedReplica?.worker.worker_id === rep.worker.worker_id;
              return (
                <button
                  key={rep.worker.worker_id}
                  type="button"
                  onClick={() => setSelectedWorkerId(rep.worker.worker_id)}
                  className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] font-semibold transition ${
                    active
                      ? "border-gold-500/50 bg-gold-500/15 text-gold-300"
                      : "border-slate-800 bg-obsidian-950 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {rep.worker.worker_id}
                </button>
              );
            })}
            <span className="text-[11px] font-mono text-slate-400 ml-1">
              Son {logs.length} sətir
            </span>
          </div>
        </div>

        <div className="bg-obsidian-950/95 p-4 max-h-80 overflow-y-auto font-mono text-xs space-y-1.5">
          {logs.length === 0 ? (
            <p className="text-slate-500 py-4 text-center">
              Bu replika üçün hələ canlı konsol logu ötürülməyib. Railway
              konteyneri aktiv olduqda əməliyyat sətirləri burada canlı görünəcək.
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
  statusCounts,
}: {
  initialWorkers: WorkerStatusRow[];
  initialJobs: PipelineJob[];
  statusCounts?: Record<string, number>;
}) {
  return (
    <WorkerLivePanel
      workers={initialWorkers}
      jobs={initialJobs}
      statusCounts={statusCounts}
    />
  );
}
