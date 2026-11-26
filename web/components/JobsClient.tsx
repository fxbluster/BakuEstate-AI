"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertCircle,
  Ban,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  ExternalLink,
  ListChecks,
  Mic,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  formatBakuDateTime,
  formatDurationAz,
  formatRelativeAz,
  JOB_STATUS_META,
  JOB_TRIGGER_LABELS,
  JOB_TYPE_LABELS,
} from "@/lib/format";
import { extractErrorMessage } from "@/lib/errors";
import type { JobStatus, PipelineJob, WorkerStatusRow } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { WorkerStatusBadge } from "./WorkerStatusBadge";
import { WorkerLivePanel } from "./WorkerMonitorClient";

export type JobsCenterTab = "jobs" | "worker";

interface JobsClientProps {
  initialJobs: PipelineJob[];
  initialWorkers: WorkerStatusRow[];
  initialTab?: JobsCenterTab;
  agencyId?: string | null;
  totalCount?: number;
  page?: number;
  pageSize?: number;
  initialStatusCounts?: Record<string, number>;
}

type ExtendedJobStatus = JobStatus | "CANCELLED";

const STATUS_TABS: Array<ExtendedJobStatus | "ALL"> = [
  "ALL",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
];

function getJobStatusMeta(status: string) {
  const map = JOB_STATUS_META as Record<string, { label: string; tone: "amber" | "violet" | "emerald" | "rose" | "neutral" }>;
  return map[status] ?? { label: status === "CANCELLED" ? "Ləğv edilib" : status, tone: "neutral" as const };
}

function extractReadableParams(
  job: PipelineJob
): Array<{ label: string; value: string; accent?: boolean }> {
  const p = job.params_json ?? {};
  const chips: Array<{ label: string; value: string; accent?: boolean }> = [];

  if (typeof p.voice_preset === "string" && p.voice_preset) {
    chips.push({ label: "Səs", value: p.voice_preset });
  }
  if (typeof p.voice_choice === "string" && p.voice_choice) {
    chips.push({ label: "Səs", value: p.voice_choice });
  }
  if (typeof p.target_account === "string" && p.target_account) {
    chips.push({ label: "Hesab", value: p.target_account, accent: true });
  }
  if (typeof p.channel === "string" && p.channel) {
    chips.push({ label: "Kanal", value: p.channel });
  }
  if (typeof p.script_angle === "string" && p.script_angle) {
    chips.push({ label: "Bucaq", value: p.script_angle });
  }
  if (typeof p.pages === "number" || typeof p.limit === "number") {
    const parts: string[] = [];
    if (typeof p.pages === "number") parts.push(`${p.pages} səh.`);
    if (typeof p.limit === "number") parts.push(`limit ${p.limit}`);
    chips.push({ label: "Həcm", value: parts.join(" • ") });
  }
  if (typeof p.scheduled_slot_baku === "string" && p.scheduled_slot_baku) {
    chips.push({ label: "Cədvəl", value: p.scheduled_slot_baku });
  }

  return chips;
}

export function JobsClient({
  initialJobs,
  initialWorkers,
  initialTab = "jobs",
  agencyId,
  totalCount,
  page,
  pageSize,
  initialStatusCounts,
}: JobsClientProps) {
  const [activeTab, setActiveTab] = useState<JobsCenterTab>(initialTab);
  const [jobs, setJobs] = useState<PipelineJob[]>(initialJobs);
  const [workers, setWorkers] = useState<WorkerStatusRow[]>(initialWorkers);
  const [totalJobsCount, setTotalJobsCount] = useState<number>(
    totalCount ?? initialJobs.length
  );
  const [serverStatusCounts, setServerStatusCounts] = useState<Record<
    string,
    number
  > | null>(initialStatusCounts ?? null);
  const [statusFilter, setStatusFilter] = useState<ExtendedJobStatus | "ALL">("ALL");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRealtimeSubscribed, setIsRealtimeSubscribed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedTechIds, setExpandedTechIds] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<{
    type: "ok" | "err" | "warn";
    text: string;
  } | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setJobs(initialJobs);
  }, [initialJobs]);

  useEffect(() => {
    if (typeof totalCount === "number") {
      setTotalJobsCount(totalCount);
    }
  }, [totalCount]);

  useEffect(() => {
    if (initialStatusCounts) {
      setServerStatusCounts(initialStatusCounts);
    }
  }, [initialStatusCounts]);

  const fetchAll = useCallback(async () => {
    if (!isSupabaseConfigured()) return;
    setRefreshing(true);
    try {
      const supabase = createClient();
      const orderedJobsQuery = supabase
        .from("pipeline_jobs")
        .select("*, listings(id, bina_id, title)", {
          count: page && pageSize ? "exact" : undefined,
        })
        .order("created_at", { ascending: false });

      const jobsRequest =
        page && pageSize
          ? orderedJobsQuery.range((page - 1) * pageSize, page * pageSize - 1)
          : orderedJobsQuery.limit(100);

      const [jRes, wRes] = await Promise.all([
        jobsRequest,
        supabase
          .from("worker_status")
          .select("*")
          .order("last_seen_at", { ascending: false })
          .limit(5),
      ]);
      if (jRes.data) {
        const nextJobs = jRes.data as PipelineJob[];
        setJobs(nextJobs);
        if (typeof jRes.count === "number") {
          setTotalJobsCount(jRes.count);
        } else if (!page || !pageSize) {
          setTotalJobsCount(nextJobs.length);
        }
      }
      if (wRes.data) setWorkers(wRes.data as WorkerStatusRow[]);
    } finally {
      setRefreshing(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    if (!autoRefresh || !isSupabaseConfigured() || isRealtimeSubscribed) return;
    const intervalMs = activeTab === "worker" ? 5_000 : 10_000;
    const timer = setInterval(fetchAll, intervalMs);
    return () => clearInterval(timer);
  }, [autoRefresh, activeTab, isRealtimeSubscribed, fetchAll]);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const scheduleDebouncedRefresh = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        fetchAll();
      }, 1500);
    };

    try {
      const supabase = createClient();
      const jobsFilter = agencyId
        ? {
            event: "*" as const,
            schema: "public",
            table: "pipeline_jobs",
            filter: `agency_id=eq.${agencyId}`,
          }
        : { event: "*" as const, schema: "public", table: "pipeline_jobs" };

      const hbFilter = agencyId
        ? {
            event: "*" as const,
            schema: "public",
            table: "worker_heartbeats",
            filter: `agency_id=eq.${agencyId}`,
          }
        : { event: "*" as const, schema: "public", table: "worker_heartbeats" };

      const channel = supabase
        .channel("jobs_and_worker_realtime")
        .on("postgres_changes", jobsFilter, scheduleDebouncedRefresh)
        .on("postgres_changes", hbFilter, scheduleDebouncedRefresh)
        .subscribe((status: string) => {
          setIsRealtimeSubscribed(status === "SUBSCRIBED");
        });

      return () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        setIsRealtimeSubscribed(false);
        supabase.removeChannel(channel);
      };
    } catch {
      // Polling remains active
    }
  }, [fetchAll, agencyId]);

  const counts = useMemo(() => {
    if (serverStatusCounts) {
      const map: Record<string, number> = {
        ALL: serverStatusCounts.ALL ?? totalJobsCount,
      };
      for (const s of STATUS_TABS) {
        if (s !== "ALL") map[s] = serverStatusCounts[s] ?? 0;
      }
      return map;
    }
    const map: Record<string, number> = { ALL: jobs.length };
    for (const s of STATUS_TABS) {
      if (s !== "ALL") map[s] = 0;
    }
    for (const j of jobs) {
      map[j.status] = (map[j.status] ?? 0) + 1;
    }
    return map;
  }, [jobs, serverStatusCounts, totalJobsCount]);

  const filtered = useMemo(() => {
    if (statusFilter === "ALL") return jobs;
    return jobs.filter((j) => (j.status as string) === statusFilter);
  }, [jobs, statusFilter]);

  async function handleRetry(job: PipelineJob) {
    if (job.status !== "FAILED" && job.status !== "EXPIRED") {
      setFeedback({
        type: "warn",
        text: "Yalnız xətalı (FAILED) və ya müddəti bitmiş (EXPIRED) işlər yenidən başladıla bilər.",
      });
      return;
    }

    setBusyId(job.id);
    setFeedback(null);
    const supabase = createClient();

    try {
      const { data, error } = await supabase.rpc("retry_or_cancel_pipeline_job", {
        p_job_id: job.id,
        p_action: "RETRY",
      });

      if (error) throw error;
      if (data && typeof data === "object" && "ok" in data && data.ok === false) {
        const errCode = (data as { error?: string }).error;
        throw new Error(
          errCode === "JOB_STILL_RUNNING"
            ? "İş hələ icradadır (409 Conflict)."
            : errCode || "Yenidən cəhd rədd edildi."
        );
      }

      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id
            ? {
                ...j,
                status: "QUEUED",
                attempts: 0,
                locked_by: null,
                lease_expires_at: null,
                error_message: null,
                started_at: null,
                finished_at: null,
                expires_at: null,
              }
            : j
        )
      );
      const label = JOB_TYPE_LABELS[job.job_type] ?? job.job_type;
      setFeedback({
        type: "ok",
        text: `${label} işi yenidən növbəyə salındı.`,
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Yenidən cəhd xətası: ${extractErrorMessage(err)}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(job: PipelineJob) {
    if (job.status !== "QUEUED" && job.status !== "RUNNING") return;

    setBusyId(job.id);
    setFeedback(null);
    const supabase = createClient();

    try {
      const { data, error } = await supabase.rpc("retry_or_cancel_pipeline_job", {
        p_job_id: job.id,
        p_action: "CANCEL",
      });

      if (error) throw error;
      if (data && typeof data === "object" && "ok" in data && data.ok === false) {
        throw new Error((data as { error?: string }).error || "İş ləğv edilə bilmədi.");
      }

      const wasQueued = job.status === "QUEUED" || (data as { status?: string } | null)?.status === "CANCELLED";
      setJobs((prev) =>
        prev.map((j) =>
          j.id === job.id
            ? wasQueued
              ? { ...j, status: "CANCELLED" as JobStatus, finished_at: new Date().toISOString() }
              : ({ ...j, cancel_requested_at: new Date().toISOString() } as PipelineJob)
            : j
        )
      );
      const label = JOB_TYPE_LABELS[job.job_type] ?? job.job_type;
      setFeedback({
        type: "ok",
        text: wasQueued
          ? `${label} işi ləğv edildi.`
          : `${label} işinin dayandırılması tələb edildi.`,
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Ləğv xətası: ${extractErrorMessage(err)}`,
      });
    } finally {
      setBusyId(null);
    }
  }

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

    setBusyId(jobType);
    setFeedback(null);
    const supabase = createClient();

    try {
      const paramsJson =
        jobType === "SCRAPE_NEW"
          ? { pages: 2, limit: 3, enqueue_render_jobs: false }
          : { limit: 30 };

      const { data, error } = await supabase.rpc("enqueue_utility_job_atomic", {
        p_job_type: jobType,
        p_params_json: paramsJson,
      });

      if (error) {
        if ((error as { code?: string }).code === "23505") {
          setFeedback({
            type: "warn",
            text: `${label} artıq aktiv növbədədir.`,
          });
          return;
        }
        throw error;
      }

      const rpcRes = data as { ok?: boolean; already_queued?: boolean; job_id?: string; error?: string } | null;
      if (rpcRes?.ok === false) {
        throw new Error(rpcRes.error || "İş yaradıla bilmədi.");
      }

      if (rpcRes?.already_queued) {
        setFeedback({
          type: "warn",
          text: `${label} artıq aktiv növbədədir.`,
        });
        return;
      }

      if (rpcRes?.job_id) {
        const newJob: PipelineJob = {
          id: rpcRes.job_id,
          idempotency_key: `web_manual:${jobType}:${rpcRes.job_id}`,
          job_type: jobType,
          listing_id: null,
          trigger_source: "WEB_UI",
          params_json: paramsJson,
          status: "QUEUED",
          attempts: 0,
          max_attempts: 3,
          locked_by: null,
          lease_expires_at: null,
          expires_at: null,
          error_message: null,
          created_at: new Date().toISOString(),
          started_at: null,
          finished_at: null,
          listings: null,
        };
        setJobs((prev) => [newJob, ...prev]);
      }
      setFeedback({
        type: "ok",
        text:
          jobType === "SCRAPE_NEW"
            ? "İş növbəyə salındı: əvvəlcə videosuz elanların videosu yığılır, yeni yığım yalnız özəl fürsətləri saxlayır."
            : "Elanların bina.az-da aktivlik yoxlaması növbəyə salındı.",
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `İş yaratma xətası: ${extractErrorMessage(err)}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Unified Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-400">
            Kompüter və Montaj Mərkəzi
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            İş Növbəsi və Worker
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyId !== null}
            onClick={() => enqueueUtilityJob("SCRAPE_NEW")}
            className="exec-btn-primary text-xs"
            title="Əvvəlcə videosuz elanların videosunu yığır, özəl fürsət varsa yeni elanı bazaya saxlayır"
          >
            <Play className="h-3.5 w-3.5" />
            <span>bina.az-dan Elan Yığ</span>
          </button>
          <button
            type="button"
            disabled={busyId !== null}
            onClick={() => enqueueUtilityJob("LIVENESS_CHECK")}
            className="exec-btn-secondary text-xs"
            title="Bazada olan elanların bina.az-da satılıb-silinmədiyini yoxlayır"
          >
            <Activity className="h-3.5 w-3.5 text-emerald-400" />
            <span>Aktualığı Yoxla</span>
          </button>
          <button
            type="button"
            onClick={fetchAll}
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

      {/* Compact Always-Visible Worker Strip */}
      <WorkerStatusBadge
        initialWorkers={workers}
        onOpenMonitor={
          activeTab === "jobs" ? () => setActiveTab("worker") : undefined
        }
      />

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

      {/* Clean 2-Tab Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="inline-flex rounded-xl border border-slate-800 bg-obsidian-950/90 p-1">
          <button
            type="button"
            onClick={() => setActiveTab("jobs")}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${
              activeTab === "jobs"
                ? "bg-gold-500/20 text-gold-300 border border-gold-500/40 shadow-sm"
                : "text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            <ListChecks className="h-3.5 w-3.5" />
            <span>İş Tarixçəsi ({totalJobsCount})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("worker")}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition ${
              activeTab === "worker"
                ? "bg-gold-500/20 text-gold-300 border border-gold-500/40 shadow-sm"
                : "text-slate-400 hover:text-slate-200 border border-transparent"
            }`}
          >
            <Server className="h-3.5 w-3.5" />
            <span>Worker Monitoru</span>
          </button>
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="rounded border-slate-700 bg-obsidian-950 text-gold-500 focus:ring-gold-500/30"
          />
          <span>
            Canlı yeniləmə ({activeTab === "worker" ? "5 san" : "10 san"})
          </span>
        </label>
      </div>

      {/* Tab Content */}
      {activeTab === "worker" ? (
        <WorkerLivePanel
          workers={workers}
          jobs={jobs}
          statusCounts={counts}
        />
      ) : (
        <div className="space-y-4">
          {/* Status Filters */}
          <div className="flex flex-wrap gap-1.5">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  statusFilter === tab
                    ? "border-gold-500/60 bg-gold-500/15 text-gold-300"
                    : "border-slate-800 bg-obsidian-950 text-slate-400 hover:text-slate-200"
                }`}
              >
                {tab === "ALL" ? "Hamısı" : getJobStatusMeta(tab).label} (
                {counts[tab] ?? 0})
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="exec-card flex flex-col items-center justify-center py-14 text-center px-6">
              <Cpu className="h-10 w-10 text-slate-600" />
              <p className="mt-3 text-sm font-medium text-slate-200">
                Bu status üzrə iş tapılmadı
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((job) => {
                const stMeta = getJobStatusMeta(job.status);
                const canRetry =
                  job.status === "FAILED" || job.status === "EXPIRED";
                const canCancel =
                  job.status === "QUEUED" || job.status === "RUNNING";
                const cancelRequested = Boolean(
                  (job as PipelineJob & { cancel_requested_at?: string | null })
                    .cancel_requested_at
                );
                const readableChips = extractReadableParams(job);
                const binaId =
                  job.listings?.bina_id ||
                  (typeof job.params_json?.bina_id === "string"
                    ? job.params_json.bina_id
                    : null);
                const durationStr = formatDurationAz(
                  job.started_at,
                  job.finished_at
                );
                const isTechOpen = Boolean(expandedTechIds[job.id]);

                return (
                  <div key={job.id} className="exec-card p-4 space-y-2.5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge
                            label={stMeta.label}
                            tone={stMeta.tone}
                          />
                          <span className="text-sm font-semibold text-slate-100">
                            {JOB_TYPE_LABELS[job.job_type] ?? job.job_type}
                          </span>
                          <StatusBadge
                            label={
                              JOB_TRIGGER_LABELS[job.trigger_source] ??
                              job.trigger_source
                            }
                            tone="neutral"
                          />
                          {binaId && (
                            <Link
                              href={`/listings/${binaId}`}
                              className="inline-flex items-center gap-1 rounded-md border border-gold-500/30 bg-gold-500/10 px-2 py-0.5 font-mono text-xs font-semibold text-gold-300 hover:bg-gold-500/20 transition"
                            >
                              <span>Elan #{binaId}</span>
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          )}
                        </div>

                        {job.listings?.title && (
                          <p className="text-xs font-medium text-slate-300 truncate">
                            {job.listings.title}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                          <span>
                            Başlama: {formatBakuDateTime(job.created_at)} (
                            {formatRelativeAz(job.created_at)})
                          </span>
                          {job.finished_at && durationStr !== "—" && (
                            <span className="inline-flex items-center gap-1 text-slate-300">
                              <Clock className="h-3 w-3 text-slate-500" />
                              <span>Müddət: {durationStr}</span>
                            </span>
                          )}
                          {job.attempts > 1 && (
                            <span>
                              Cəhd: {job.attempts}/{job.max_attempts}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {canRetry && (
                          <button
                            type="button"
                            disabled={busyId === job.id}
                            onClick={() => handleRetry(job)}
                            className="exec-btn-primary text-xs py-2 shrink-0"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            <span>
                              {busyId === job.id
                                ? "Göndərilir..."
                                : "Yenidən Cəhd"}
                            </span>
                          </button>
                        )}

                        {canCancel && (
                          <button
                            type="button"
                            disabled={busyId === job.id || cancelRequested}
                            onClick={() => handleCancel(job)}
                            className="exec-btn-danger text-xs py-2 shrink-0"
                          >
                            <Ban className="h-3.5 w-3.5" />
                            <span>
                              {cancelRequested
                                ? "Ləğv gözlənilir..."
                                : busyId === job.id
                                  ? "Ləğv edilir..."
                                  : "Ləğv Et"}
                            </span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() =>
                            setExpandedTechIds((prev) => ({
                              ...prev,
                              [job.id]: !prev[job.id],
                            }))
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-obsidian-950/70 px-2.5 py-1.5 text-[11px] font-medium text-slate-400 hover:text-slate-200 hover:border-slate-700 transition"
                          title="Texniki detalları göstər/gizlə"
                        >
                          <span>Texniki</span>
                          {isTechOpen ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>

                    {readableChips.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        {readableChips.map((chip, idx) => (
                          <span
                            key={`${chip.label}-${idx}`}
                            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${
                              chip.accent
                                ? "border-sky-500/30 bg-sky-500/10 text-sky-300 font-medium"
                                : "border-slate-800 bg-obsidian-950/70 text-slate-300"
                            }`}
                          >
                            {chip.label === "Səs" && (
                              <Mic className="h-3 w-3 text-gold-400" />
                            )}
                            {chip.label === "Hesab" ? (
                              <span>{chip.value}</span>
                            ) : (
                              <span>
                                {chip.label}: {chip.value}
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}

                    {isTechOpen && (
                      <div className="rounded-lg border border-slate-800 bg-obsidian-950/90 p-3 font-mono text-[11px] text-slate-400 space-y-1">
                        <div>Job ID: {job.id}</div>
                        <div>
                          Cəhd: {job.attempts}/{job.max_attempts} • Worker:{" "}
                          {job.locked_by || "—"}
                        </div>
                        <div className="overflow-x-auto">
                          Parametrlər: {JSON.stringify(job.params_json ?? {})}
                        </div>
                      </div>
                    )}

                    {job.error_message && (
                      <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
                        <pre className="whitespace-pre-wrap font-mono text-[11px] break-all">
                          {job.error_message}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
