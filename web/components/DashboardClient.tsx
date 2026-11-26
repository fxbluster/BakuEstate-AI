"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  CopyCheck,
  ExternalLink,
  RefreshCw,
  TrendingDown,
  XCircle,
  Sparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  formatAzn,
  formatBakuDateTime,
  formatRelativeAz,
  getPlusHoursIso,
  getTomorrowMorningBakuIso,
  isOverdue,
  TASK_ENTITY_LABELS,
  TASK_PRIORITY_META,
} from "@/lib/format";
import type {
  FollowUpTask,
  Listing,
  ListingEvent,
  WorkerStatusRow,
} from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { WorkerStatusBadge } from "./WorkerStatusBadge";

export interface DuplicatePair {
  candidate: Listing;
  original: Pick<
    Listing,
    | "id"
    | "bina_id"
    | "title"
    | "price_azn_normalized"
    | "location"
    | "rooms"
    | "area"
    | "floor"
    | "owner_phone_raw"
  > | null;
}

interface DashboardClientProps {
  initialTasks: FollowUpTask[];
  initialPriceAlerts: ListingEvent[];
  initialDuplicates: DuplicatePair[];
  initialWorkers: WorkerStatusRow[];
  kpi: {
    activeListings: number;
    queuedJobs: number;
    openLeads: number;
  };
}

export function DashboardClient({
  initialTasks,
  initialPriceAlerts,
  initialDuplicates,
  initialWorkers,
  kpi,
}: DashboardClientProps) {
  const [tasks, setTasks] = useState<FollowUpTask[]>(initialTasks);
  const [duplicates, setDuplicates] =
    useState<DuplicatePair[]>(initialDuplicates);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const duplicateListingIds = useMemo(
    () => new Set(duplicates.map((d) => d.candidate.id)),
    [duplicates]
  );

  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (t) =>
          !(
            t.entity_type === "DUPLICATE_REVIEW" &&
            t.listing_id &&
            duplicateListingIds.has(t.listing_id)
          )
      ),
    [tasks, duplicateListingIds]
  );

  const overdueTasks = visibleTasks.filter((t) => isOverdue(t.due_at));
  const upcomingTasks = visibleTasks.filter((t) => !isOverdue(t.due_at));

  async function handleTaskAction(
    task: FollowUpTask,
    action: "done" | "snooze_3h" | "tomorrow"
  ) {
    setBusyId(task.id);
    setFeedback(null);
    const supabase = createClient();

    try {
      if (action === "done") {
        const { data, error } = await supabase.rpc(
          "update_follow_up_task_atomic",
          {
            p_task_id: task.id,
            p_status: "DONE",
            p_due_at: null,
          }
        );

        if (error) throw error;
        if (data && typeof data === "object" && "ok" in data && data.ok === false) {
          throw new Error((data as { error?: string }).error || "Tapşırıq yenilənə bilmədi.");
        }
        setTasks((prev) => prev.filter((item) => item.id !== task.id));
        setFeedback({ type: "ok", text: "Tapşırıq tamamlandı kimi qeyd edildi." });
      } else {
        const nextDue =
          action === "snooze_3h"
            ? getPlusHoursIso(3)
            : getTomorrowMorningBakuIso();

        const { data, error } = await supabase.rpc(
          "update_follow_up_task_atomic",
          {
            p_task_id: task.id,
            p_status: "SNOOZED",
            p_due_at: nextDue,
          }
        );

        if (error) throw error;
        if (data && typeof data === "object" && "ok" in data && data.ok === false) {
          throw new Error((data as { error?: string }).error || "Tapşırıq təxirə salına bilmədi.");
        }

        setTasks((prev) =>
          prev
            .map((item) =>
              item.id === task.id
                ? {
                    ...item,
                    status: "SNOOZED" as const,
                    due_at: nextDue,
                    snooze_count: (item.snooze_count ?? 0) + 1,
                  }
                : item
            )
            .sort(
              (a, b) =>
                new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
            )
        );
        setFeedback({
          type: "ok",
          text:
            action === "snooze_3h"
              ? "Xatırlatma +3 saat təxirə salındı."
              : "Xatırlatma sabah 10:00 (Bakı) üçün təyin edildi.",
        });
      }
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Əməliyyat xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDuplicateDecision(
    pair: DuplicatePair,
    decision: "confirm" | "separate"
  ) {
    setBusyId(pair.candidate.id);
    setFeedback(null);
    const supabase = createClient();

    try {
      const { data, error } = await supabase.rpc(
        "resolve_duplicate_listing_atomic",
        {
          p_listing_id: pair.candidate.id,
          p_decision: decision === "confirm" ? "CONFIRM" : "SEPARATE",
        }
      );
      if (error) throw error;
      if (data && typeof data === "object" && "ok" in data && data.ok === false) {
        throw new Error(
          (data as { error?: string }).error || "Təkrar qərar xətası"
        );
      }

      setDuplicates((prev) =>
        prev.filter((d) => d.candidate.id !== pair.candidate.id)
      );
      setTasks((prev) =>
        prev.filter(
          (t) =>
            !(
              t.listing_id === pair.candidate.id &&
              t.entity_type === "DUPLICATE_REVIEW"
            )
        )
      );
      setFeedback({
        type: "ok",
        text:
          decision === "confirm"
            ? `#${pair.candidate.bina_id} təkrar elan kimi təsdiqləndi və arxivləndi.`
            : `#${pair.candidate.bina_id} ayrı mənzil kimi saxlanıldı və video render növbəsinə əlavə edildi.`,
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Təkrar qərar xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-400">
            Gündəlik Əməliyyat Mərkəzi
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            İcmal &amp; Bugünkü Follow-Up-lar
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/leads?new=1" className="exec-btn-primary">
            <Sparkles className="h-4 w-4" />
            <span>Yeni Müştəri</span>
          </Link>
          <Link href="/listings" className="exec-btn-secondary">
            <span>Bütün Elanlar</span>
          </Link>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${
            feedback.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
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

      {/* Worker Status + KPI Grid */}
      <WorkerStatusBadge initialWorkers={initialWorkers} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Açıq / Gecikmiş Tapşırıq</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-50">
              {visibleTasks.length}
            </span>
            {overdueTasks.length > 0 && (
              <span className="text-xs font-medium text-rose-400">
                ({overdueTasks.length} gecikmiş)
              </span>
            )}
          </div>
        </div>
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Şübhəli Təkrar Gözləyən</p>
          <p className="mt-2 text-2xl font-bold text-amber-300">
            {duplicates.length}
          </p>
        </div>
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Aktiv Elanlar (bina.az)</p>
          <p className="mt-2 text-2xl font-bold text-emerald-300">
            {kpi.activeListings}
          </p>
        </div>
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Açıq Müştəri / Növbə</p>
          <p className="mt-2 text-2xl font-bold text-gold-300">
            {kpi.openLeads}{" "}
            <span className="text-sm font-normal text-slate-400">
              / {kpi.queuedJobs} iş
            </span>
          </p>
        </div>
      </div>

      {/* Main 2-column Layout */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left 2 Columns: Follow-Up Queue */}
        <section className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
              <CalendarClock className="h-5 w-5 text-gold-400" />
              <span>Gecikmiş və Bugünkü Follow-Up-lar</span>
            </h2>
            <span className="text-xs text-slate-400">Bakı vaxtı (UTC+4)</span>
          </div>

          {visibleTasks.length === 0 ? (
            <div className="exec-card flex flex-col items-center justify-center py-12 text-center px-6">
              <CheckCircle2 className="h-10 w-10 text-emerald-400/80" />
              <p className="mt-3 text-sm font-medium text-slate-200">
                Gecikmiş və ya bugünkü açıq tapşırıq yoxdur
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Yeni müştəri sorğusu əlavə etdikdə və ya mülkiyyətçi yoxlaması
                təyin etdikdə burada görünəcək.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {[...overdueTasks, ...upcomingTasks].map((task) => {
                const overdue = isOverdue(task.due_at);
                const priorityMeta = TASK_PRIORITY_META[task.priority];
                const isBusy = busyId === task.id;
                return (
                  <div
                    key={task.id}
                    className={`exec-card p-4 transition ${
                      overdue
                        ? "border-rose-500/40 bg-rose-950/15"
                        : "hover:border-slate-700"
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge
                            label={priorityMeta.label}
                            tone={priorityMeta.tone}
                          />
                          <StatusBadge
                            label={TASK_ENTITY_LABELS[task.entity_type]}
                            tone="neutral"
                          />
                          {overdue && (
                            <StatusBadge label="Gecikmiş" tone="rose" />
                          )}
                          {task.snooze_count > 0 && (
                            <span className="text-[11px] text-slate-500">
                              • {task.snooze_count}x təxirə salınıb
                            </span>
                          )}
                        </div>

                        <p className="text-sm font-semibold text-slate-100">
                          {task.title}
                        </p>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                          <span
                            className={
                              overdue ? "font-medium text-rose-300" : ""
                            }
                          >
                            Vaxt: {formatBakuDateTime(task.due_at)} (
                            {formatRelativeAz(task.due_at)})
                          </span>
                          {task.buyer_leads && (
                            <Link
                              href="/leads"
                              className="text-gold-300 hover:underline"
                            >
                              Müştəri: {task.buyer_leads.client_name}
                            </Link>
                          )}
                          {task.listings && (
                            <Link
                              href={`/listings/${task.listings.bina_id}`}
                              className="text-sky-300 hover:underline"
                            >
                              Elan #{task.listings.bina_id} (
                              {formatAzn(task.listings.price_azn_normalized)})
                            </Link>
                          )}
                        </div>
                      </div>

                      {/* 1-Click Actions */}
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleTaskAction(task, "done")}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Tamamlandı</span>
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleTaskAction(task, "snooze_3h")}
                          className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-obsidian-850 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-amber-500/40 hover:text-amber-200 disabled:opacity-50"
                        >
                          <Clock className="h-3.5 w-3.5" />
                          <span>+3 saat</span>
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleTaskAction(task, "tomorrow")}
                          className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-obsidian-850 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-gold-500/40 hover:text-gold-300 disabled:opacity-50"
                        >
                          <span>Sabaha</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Duplicate Review Cards */}
          <div className="pt-4 space-y-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
              <CopyCheck className="h-5 w-5 text-amber-400" />
              <span>Şübhəli Təkrar Elan Təsdiqi ({duplicates.length})</span>
            </h2>

            {duplicates.length === 0 ? (
              <div className="exec-card p-5 text-xs text-slate-400">
                Hazırda insan təsdiqi gözləyən şübhəli təkrar elan yoxdur.
              </div>
            ) : (
              <div className="space-y-3">
                {duplicates.map((pair) => {
                  const isBusy = busyId === pair.candidate.id;
                  const pct =
                    pair.candidate.duplicate_confidence !== null
                      ? Math.round(pair.candidate.duplicate_confidence * 100)
                      : null;

                  return (
                    <div
                      key={pair.candidate.id}
                      className="exec-card border-amber-500/35 p-4 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-400" />
                          <span className="text-sm font-semibold text-amber-200">
                            Yeni Elan #{pair.candidate.bina_id}
                          </span>
                          {pct !== null && (
                            <StatusBadge
                              label={`${pct}% uyğunluq`}
                              tone="amber"
                            />
                          )}
                        </div>
                        <Link
                          href={`/listings/${pair.candidate.bina_id}`}
                          className="inline-flex items-center gap-1 text-xs text-gold-300 hover:underline"
                        >
                          <span>Detala bax</span>
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2 text-xs">
                        <div className="rounded-xl border border-slate-800 bg-obsidian-950/70 p-3 space-y-1">
                          <p className="font-semibold text-slate-300">
                            Namizəd (#{pair.candidate.bina_id})
                          </p>
                          <p className="text-slate-100 line-clamp-1">
                            {pair.candidate.title || "Başlıq yoxdur"}
                          </p>
                          <p className="text-gold-300 font-semibold">
                            {formatAzn(pair.candidate.price_azn_normalized)}
                          </p>
                          <p className="text-slate-400">
                            {pair.candidate.location || "—"} •{" "}
                            {pair.candidate.rooms ?? "?"} otaq •{" "}
                            {pair.candidate.area ?? "?"} m² • Mərtəbə{" "}
                            {pair.candidate.floor ?? "?"}
                          </p>
                          {pair.candidate.owner_phone_raw && (
                            <p className="font-mono text-slate-400">
                              Tel: {pair.candidate.owner_phone_raw}
                            </p>
                          )}
                        </div>

                        <div className="rounded-xl border border-slate-800 bg-obsidian-950/70 p-3 space-y-1">
                          <p className="font-semibold text-slate-300">
                            Mövcud Orijinal{" "}
                            {pair.original ? `(#${pair.original.bina_id})` : ""}
                          </p>
                          {pair.original ? (
                            <>
                              <Link
                                href={`/listings/${pair.original.bina_id}`}
                                className="text-sky-300 hover:underline line-clamp-1 block"
                              >
                                {pair.original.title || "Başlıq yoxdur"}
                              </Link>
                              <p className="text-gold-300 font-semibold">
                                {formatAzn(pair.original.price_azn_normalized)}
                              </p>
                              <p className="text-slate-400">
                                {pair.original.location || "—"} •{" "}
                                {pair.original.rooms ?? "?"} otaq •{" "}
                                {pair.original.area ?? "?"} m² • Mərtəbə{" "}
                                {pair.original.floor ?? "?"}
                              </p>
                              {pair.original.owner_phone_raw && (
                                <p className="font-mono text-slate-400">
                                  Tel: {pair.original.owner_phone_raw}
                                </p>
                              )}
                            </>
                          ) : (
                            <p className="text-slate-500">
                              Orijinal elan məlumatı tapılmadı.
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            handleDuplicateDecision(pair, "confirm")
                          }
                          className="exec-btn-danger text-xs py-2"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          <span>Təkrardır — Arxivlə</span>
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            handleDuplicateDecision(pair, "separate")
                          }
                          className="exec-btn-primary text-xs py-2"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          <span>Ayrı Mənzildir — Render Et</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Right Column: Recent Price Drops */}
        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            <TrendingDown className="h-5 w-5 text-emerald-400" />
            <span>Son Qiymət Dəyişiklikləri</span>
          </h2>

          {initialPriceAlerts.length === 0 ? (
            <div className="exec-card p-5 text-xs text-slate-400">
              Son dövrdə qeydə alınmış qiymət dəyişikliyi yoxdur.
            </div>
          ) : (
            <div className="space-y-3">
              {initialPriceAlerts.map((ev) => {
                const oldP = Number(
                  ev.old_value_json?.price_azn_normalized ??
                    ev.old_value_json?.price ??
                    0
                );
                const newP = Number(
                  ev.new_value_json?.price_azn_normalized ??
                    ev.new_value_json?.price ??
                    0
                );
                const delta = ev.price_delta_pct;
                const isDrop = delta !== null && Number(delta) < 0;

                return (
                  <div key={ev.id} className="exec-card p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      {ev.listings ? (
                        <Link
                          href={`/listings/${ev.listings.bina_id}`}
                          className="text-xs font-semibold text-gold-300 hover:underline"
                        >
                          Elan #{ev.listings.bina_id}
                        </Link>
                      ) : (
                        <span className="text-xs text-slate-400">Elan</span>
                      )}
                      {delta !== null && (
                        <StatusBadge
                          label={`${Number(delta) > 0 ? "+" : ""}${Number(delta).toFixed(1)}%`}
                          tone={isDrop ? "emerald" : "rose"}
                        />
                      )}
                    </div>

                    {ev.listings?.title && (
                      <p className="text-xs text-slate-200 line-clamp-1">
                        {ev.listings.title}
                      </p>
                    )}

                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <span className="text-slate-500 line-through text-xs">
                        {oldP > 0 ? formatAzn(oldP) : "—"}
                      </span>
                      <span className="text-slate-500">→</span>
                      <span className="text-slate-50">
                        {newP > 0 ? formatAzn(newP) : "—"}
                      </span>
                    </div>

                    <p className="text-[11px] text-slate-500">
                      {formatBakuDateTime(ev.created_at)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
