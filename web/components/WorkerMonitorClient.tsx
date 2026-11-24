"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Terminal,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { extractErrorMessage } from "@/lib/errors";
import {
  formatBakuDateTime,
  formatBakuTime,
  formatDurationAz,
  formatRelativeAz,
  JOB_STATUS_META,
  JOB_TYPE_LABELS,
} from "@/lib/format";
import type { PipelineJob, WorkerStatusRow } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

interface WorkerMonitorClientProps {
  initialWorkers: WorkerStatusRow[];
  initialJobs: PipelineJob[];
}

const STARTUP_COMMAND =
  "powershell -ExecutionPolicy Bypass -File scripts\\setup_worker_service.ps1 -Start";

export function WorkerMonitorClient({
  initialWorkers,
  initialJobs,
}: WorkerMonitorClientProps) {
  const [workers, setWorkers] = useState<WorkerStatusRow[]>(initialWorkers);
  const [jobs, setJobs] = useState<PipelineJob[]>(initialJobs);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [feedback, setFeedback] = useState<{
    type: "ok" | "err" | "warn";
    text: string;
  } | null>(null);

  const fetchLive = useCallback(async () => {
    if (!isSupabaseConfigured()) return;
    setRefreshing(true);
    try {
      const supabase = createClient();
      const [wRes, jRes] = await Promise.all([
        supabase
          .from("worker_status")
          .select("*")
          .order("last_seen_at", { ascending: false })
          .limit(5),
        supabase
          .from("pipeline_jobs")
          .select("*, listings(id, bina_id, title)")
          .order("created_at", { ascending: false })
          .limit(30),
      ]);
      if (wRes.data) setWorkers(wRes.data as WorkerStatusRow[]);
      if (jRes.data) setJobs(jRes.data as PipelineJob[]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Poll every 5 seconds for live tracking + 1s ticker for active elapsed display
  useEffect(() => {
    const tickTimer = setInterval(() => setNowMs(Date.now()), 1000);
    if (!isSupabaseConfigured()) {
      return () => clearInterval(tickTimer);
    }
    const pollTimer = setInterval(fetchLive, 5_000);
    return () => {
      clearInterval(tickTimer);
      clearInterval(pollTimer);
    };
  }, [fetchLive]);

  // Subscribe to Supabase Realtime for instant updates on heartbeats and jobs
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    try {
      const supabase = createClient();
      const channel = supabase
        .channel("worker_monitor_live")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "worker_heartbeats" },
          () => {
            fetchLive();
          }
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "pipeline_jobs" },
          () => {
            fetchLive();
          }
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    } catch {
      // Fallback polling stays active
    }
  }, [fetchLive]);

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

  async function enqueueUtilityJob(jobType: "SCRAPE_NEW" | "LIVENESS_CHECK") {
    const label = JOB_TYPE_LABELS[jobType] ?? jobType;
    const alreadyActive = jobs.find(
      (j) =>
        j.job_type === jobType &&
        (j.status === "QUEUED" || j.status === "RUNNING")
    );
    if (alreadyActive) {
      setFeedback({
        type: "warn",
        text: `${label} artıq aktiv növbədədir.`,
      });
      return;
    }

    setBusyAction(jobType);
    setFeedback(null);
    const supabase = createClient();
    try {
      const { error } = await supabase.from("pipeline_jobs").insert({
        idempotency_key: `web_manual:${jobType}:${Date.now()}`,
        job_type: jobType,
        listing_id: null,
        trigger_source: "WEB_UI",
        params_json:
          jobType === "SCRAPE_NEW" ? { pages: 2, limit: 3 } : { limit: 30 },
        status: "QUEUED",
      });
      if (error) throw error;
      setFeedback({
        type: "ok",
        text: `${label} tapşırığı növbəyə göndərildi.${
          !isOnline ? " (Qeyd: Lokal Worker hazırda oflayndır)" : ""
        }`,
      });
      await fetchLive();
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Xəta: ${extractErrorMessage(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRetry(job: PipelineJob) {
    setBusyAction(job.id);
    setFeedback(null);
    const supabase = createClient();
    try {
      const { error } = await supabase
        .from("pipeline_jobs")
        .update({
          status: "QUEUED",
          attempts: 0,
          locked_by: null,
          lease_expires_at: null,
          error_message: null,
          started_at: null,
          finished_at: null,
          expires_at: null,
        })
        .eq("id", job.id);
      if (error) throw error;
      setFeedback({
        type: "ok",
        text: `${JOB_TYPE_LABELS[job.job_type] ?? job.job_type} yenidən növbəyə salındı.`,
      });
      await fetchLive();
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Yenidən cəhd xətası: ${extractErrorMessage(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }

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
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-400">
            Canlı Kompüter Telemetriyası
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Lokal Worker Monitoru
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => enqueueUtilityJob("SCRAPE_NEW")}
            className="exec-btn-primary text-xs"
          >
            <Play className="h-3.5 w-3.5" />
            <span>İndi Elan Yığ</span>
          </button>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => enqueueUtilityJob("LIVENESS_CHECK")}
            className="exec-btn-secondary text-xs"
          >
            <Activity className="h-3.5 w-3.5 text-emerald-400" />
            <span>Aktivlik Yoxla</span>
          </button>
          <Link href="/jobs" className="exec-btn-secondary text-xs">
            <span>İş Növbəsi</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            onClick={fetchLive}
            disabled={refreshing}
            className="exec-btn-secondary text-xs"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            <span>Yenilə</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${
            feedback.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : feedback.type === "warn"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                : "border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs opacity-75 hover:opacity-100"
          >
            Bağla
          </button>
        </div>
      )}

      {/* Hero Worker Status + Key Metrics */}
      <div className="exec-card p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-2xl border ${
                isBusy
                  ? "border-violet-500/50 bg-violet-500/15 text-violet-300"
                  : isOnline
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                    : isRestarting
                      ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                      : "border-rose-500/40 bg-rose-500/10 text-rose-300"
              }`}
            >
              <Server className="h-6 w-6" />
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-lg font-bold text-slate-100 font-mono">
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
                  ? `Son ürək siqnalı: ${formatBakuDateTime(primary.last_seen_at)} (${formatRelativeAz(primary.last_seen_at)})`
                  : "Hələ heç bir ürək siqnalı qeydə alınmayıb"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-obsidian-950/70 px-3 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>Canlı Yeniləmə: 5 san</span>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              İşləmə Müddəti (Uptime)
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
              Aktiv Növbə / Sessiya
            </p>
            <p className="mt-1.5 text-lg font-bold text-slate-100">
              {queuedCount} növbədə • {meta.jobs_processed_session ?? 0} icra
            </p>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-obsidian-950/70 p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Son 30 İş Nəticəsi
            </p>
            <p className="mt-1.5 text-lg font-bold">
              <span className="text-emerald-400">{succeededRecentCount} uğurlu</span>
              {failedRecentCount > 0 && (
                <span className="text-rose-400 text-sm ml-2">
                  • {failedRecentCount} xəta
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Current Live Activity OR Offline Instructions */}
        {!isOnline ? (
          <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-amber-200">
                  Lokal Windows Worker hazırda oflayndır
                </p>
                <p className="text-xs text-amber-100/80 leading-relaxed">
                  Video montaj (ElevenLabs + FFmpeg) və bina.az yığımı birbaşa
                  sizin Windows kompüterinizdə icra olunur. Kompüterinizdə worker-i
                  işə salmaq üçün aşağıdakı əmri PowerShell-də icra edin (avtomatik
                  Windows girişində işə düşmə artıq quraşdırılıb):
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
                {meta.current_phase || "Hazır — növbə izlənilir"}
              </p>
              <p className="text-xs text-emerald-100/75">
                Worker aktivdir və hər 2 saniyədən bir buluddan yeni video render
                və ya scrape əmri yoxlayır.
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
              Canlı Worker Konsol Logları
            </h3>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Son {logs.length} sətir
          </span>
        </div>

        <div className="bg-obsidian-950/95 p-4 max-h-72 overflow-y-auto font-mono text-xs space-y-1.5">
          {logs.length === 0 ? (
            <p className="text-slate-500 py-4 text-center">
              Hələ canlı konsol logu ötürülməyib. Worker işə düşdükdə burada son
              əməliyyat sətirləri canlı izlənəcək.
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

      {/* Recent Worker Jobs */}
      <div className="exec-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-gold-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Son İcra Olunan Tapşırıqlar
            </h3>
          </div>
          <Link
            href="/jobs"
            className="text-xs font-medium text-gold-300 hover:underline"
          >
            Hamısına bax →
          </Link>
        </div>

        {jobs.length === 0 ? (
          <p className="text-xs text-slate-500 py-4 text-center">
            Növbə tarixçəsi boşdur.
          </p>
        ) : (
          <div className="divide-y divide-slate-800/70">
            {jobs.slice(0, 10).map((job) => {
              const stMeta = JOB_STATUS_META[job.status];
              const canRetry =
                job.status === "FAILED" || job.status === "EXPIRED";
              const binaId =
                job.listings?.bina_id ||
                (typeof job.params_json?.bina_id === "string"
                  ? job.params_json.bina_id
                  : null);

              return (
                <div
                  key={job.id}
                  className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <StatusBadge label={stMeta.label} tone={stMeta.tone} />
                    <span className="text-xs font-semibold text-slate-200">
                      {JOB_TYPE_LABELS[job.job_type] ?? job.job_type}
                    </span>
                    {binaId && (
                      <Link
                        href={`/listings/${binaId}`}
                        className="font-mono text-xs text-gold-300 hover:underline"
                      >
                        #{binaId}
                      </Link>
                    )}
                    {job.listings?.title && (
                      <span className="text-xs text-slate-400 truncate max-w-xs">
                        {job.listings.title}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 text-xs text-slate-400 shrink-0">
                    <span>{formatBakuDateTime(job.created_at)}</span>
                    {job.finished_at && job.started_at && (
                      <span className="text-slate-300">
                        {formatDurationAz(job.started_at, job.finished_at)}
                      </span>
                    )}
                    {canRetry && (
                      <button
                        type="button"
                        disabled={busyAction === job.id}
                        onClick={() => handleRetry(job)}
                        className="inline-flex items-center gap-1 rounded border border-gold-500/40 bg-gold-500/15 px-2 py-0.5 text-[11px] font-semibold text-gold-300 hover:bg-gold-500/25"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>Cəhd et</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
