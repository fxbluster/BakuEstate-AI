import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient, getServerSessionMember } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { JobsClient, type JobsCenterTab } from "@/components/JobsClient";
import type { PipelineJob, WorkerStatusRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 24;

export default async function JobsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    tab?: string;
    page?: string;
    pageSize?: string;
    status?: string;
  }>;
}) {
  const resolvedParams = searchParams ? await searchParams : {};
  const initialTab: JobsCenterTab =
    resolvedParams?.tab === "worker" ? "worker" : "jobs";
  const page = Math.max(
    1,
    Number.parseInt(resolvedParams?.page ?? "1", 10) || 1
  );
  const pageSize = Math.min(
    100,
    Math.max(
      1,
      Number.parseInt(
        resolvedParams?.pageSize ?? String(DEFAULT_PAGE_SIZE),
        10
      ) || DEFAULT_PAGE_SIZE
    )
  );
  const statusFilter = (resolvedParams?.status ?? "ALL").toUpperCase();

  if (!isSupabaseConfigured()) {
    return (
      <JobsClient initialJobs={[]} initialWorkers={[]} initialTab={initialTab} />
    );
  }

  const [supabase, member] = await Promise.all([
    createClient(),
    getServerSessionMember(),
  ]);

  let jobsQuery = supabase
    .from("pipeline_jobs")
    .select("*, listings(id, bina_id, title)", { count: "exact" })
    .order("created_at", { ascending: false });

  if (member?.agency_id) {
    jobsQuery = jobsQuery.eq("agency_id", member.agency_id);
  }

  if (
    ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED"].includes(
      statusFilter
    )
  ) {
    jobsQuery = jobsQuery.eq("status", statusFilter);
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const [jobsRes, workersRes] = await Promise.all([
    jobsQuery.range(from, to),
    supabase
      .from("worker_status")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(50),
  ]);

  const initialJobs = (jobsRes.data as PipelineJob[] | null) ?? [];
  const totalCount = jobsRes.count ?? initialJobs.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasNextPage = from + initialJobs.length < totalCount;

  function buildPageHref(nextPage: number): string {
    const qs = new URLSearchParams();
    if (initialTab === "worker") qs.set("tab", "worker");
    if (statusFilter !== "ALL") qs.set("status", statusFilter);
    qs.set("page", String(nextPage));
    return `/jobs?${qs.toString()}`;
  }

  return (
    <div className="space-y-4">
      <JobsClient
        initialJobs={initialJobs}
        initialWorkers={(workersRes.data as WorkerStatusRow[] | null) ?? []}
        initialTab={initialTab}
        agencyId={member?.agency_id ?? null}
      />

      {totalCount > pageSize && (
        <div className="exec-card flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
          <span className="text-slate-400">
            İş Növbəsi — Səhifə{" "}
            <strong className="text-slate-100">{page}</strong> / {totalPages} •
            Cəmi <strong className="text-slate-100">{totalCount}</strong> iş
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Link
                href={buildPageHref(page - 1)}
                className="exec-btn-secondary py-1.5 px-3 text-xs"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>Əvvəlki</span>
              </Link>
            ) : (
              <span className="exec-btn-secondary py-1.5 px-3 text-xs opacity-40 pointer-events-none">
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>Əvvəlki</span>
              </span>
            )}
            {hasNextPage ? (
              <Link
                href={buildPageHref(page + 1)}
                className="exec-btn-secondary py-1.5 px-3 text-xs"
              >
                <span>Növbəti</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span className="exec-btn-secondary py-1.5 px-3 text-xs opacity-40 pointer-events-none">
                <span>Növbəti</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
