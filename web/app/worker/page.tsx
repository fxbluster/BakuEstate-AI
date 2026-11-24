import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { WorkerMonitorClient } from "@/components/WorkerMonitorClient";
import type { PipelineJob, WorkerStatusRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function WorkerPage() {
  if (!isSupabaseConfigured()) {
    return <WorkerMonitorClient initialWorkers={[]} initialJobs={[]} />;
  }

  const supabase = await createClient();

  const [workersRes, jobsRes] = await Promise.all([
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

  return (
    <WorkerMonitorClient
      initialWorkers={(workersRes.data as WorkerStatusRow[] | null) ?? []}
      initialJobs={(jobsRes.data as PipelineJob[] | null) ?? []}
    />
  );
}
