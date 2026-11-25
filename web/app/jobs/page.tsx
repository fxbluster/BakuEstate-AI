import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { JobsClient, type JobsCenterTab } from "@/components/JobsClient";
import type { PipelineJob, WorkerStatusRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function JobsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  const resolvedParams = searchParams ? await searchParams : {};
  const initialTab: JobsCenterTab =
    resolvedParams?.tab === "worker" ? "worker" : "jobs";

  if (!isSupabaseConfigured()) {
    return (
      <JobsClient initialJobs={[]} initialWorkers={[]} initialTab={initialTab} />
    );
  }

  const supabase = await createClient();

  const [jobsRes, workersRes] = await Promise.all([
    supabase
      .from("pipeline_jobs")
      .select("*, listings(id, bina_id, title)")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("worker_status")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(5),
  ]);

  return (
    <JobsClient
      initialJobs={(jobsRes.data as PipelineJob[] | null) ?? []}
      initialWorkers={(workersRes.data as WorkerStatusRow[] | null) ?? []}
      initialTab={initialTab}
    />
  );
}
