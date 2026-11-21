import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  DashboardClient,
  type DuplicatePair,
} from "@/components/DashboardClient";
import type {
  FollowUpTask,
  Listing,
  ListingEvent,
  WorkerStatusRow,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <DashboardClient
        initialTasks={[]}
        initialPriceAlerts={[]}
        initialDuplicates={[]}
        initialWorkers={[]}
        kpi={{ activeListings: 0, queuedJobs: 0, openLeads: 0 }}
      />
    );
  }

  const supabase = await createClient();

  // Compute end of today in Asia/Baku (+04:00) so overdue + today's tasks show cleanly
  const bakuOffsetMs = 4 * 60 * 60 * 1000;
  const nowBaku = new Date(Date.now() + bakuOffsetMs);
  const endOfTodayBakuUtc = Date.UTC(
    nowBaku.getUTCFullYear(),
    nowBaku.getUTCMonth(),
    nowBaku.getUTCDate(),
    23,
    59,
    59
  );
  const endOfTodayIso = new Date(endOfTodayBakuUtc - bakuOffsetMs).toISOString();

  const [
    tasksRes,
    priceEventsRes,
    dupListingsRes,
    workerRes,
    activeListingsCount,
    queuedJobsCount,
    openLeadsCount,
  ] = await Promise.all([
    supabase
      .from("follow_up_tasks")
      .select(
        "*, listings(id, bina_id, title, price_azn_normalized), buyer_leads(id, client_name, phone_normalized, stage)"
      )
      .in("status", ["OPEN", "SNOOZED"])
      .lte("due_at", endOfTodayIso)
      .order("due_at", { ascending: true })
      .limit(50),
    supabase
      .from("listing_events")
      .select(
        "*, listings(id, bina_id, title, price_azn_normalized, location)"
      )
      .eq("event_type", "PRICE_CHANGED")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("listings")
      .select("*")
      .eq("duplicate_resolution", "PENDING_REVIEW")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("worker_status")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(5),
    supabase
      .from("listings")
      .select("id", { count: "exact", head: true })
      .eq("source_availability", "ACTIVE"),
    supabase
      .from("pipeline_jobs")
      .select("id", { count: "exact", head: true })
      .in("status", ["QUEUED", "RUNNING"]),
    supabase
      .from("buyer_leads")
      .select("id", { count: "exact", head: true })
      .not("stage", "in", "(WON_CLOSED,LOST,COLD)"),
  ]);

  const dupCandidates = (dupListingsRes.data as Listing[] | null) ?? [];
  const origIds = Array.from(
    new Set(
      dupCandidates
        .map((l) => l.duplicate_of_listing_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  const origMap = new Map<
    string,
    DuplicatePair["original"]
  >();

  if (origIds.length > 0) {
    const { data: originals } = await supabase
      .from("listings")
      .select(
        "id, bina_id, title, price_azn_normalized, location, rooms, area, floor, owner_phone_raw"
      )
      .in("id", origIds);

    for (const o of originals ?? []) {
      origMap.set(o.id as string, o as DuplicatePair["original"]);
    }
  }

  const duplicates: DuplicatePair[] = dupCandidates.map((candidate) => ({
    candidate,
    original: candidate.duplicate_of_listing_id
      ? origMap.get(candidate.duplicate_of_listing_id) ?? null
      : null,
  }));

  return (
    <DashboardClient
      initialTasks={(tasksRes.data as FollowUpTask[] | null) ?? []}
      initialPriceAlerts={(priceEventsRes.data as ListingEvent[] | null) ?? []}
      initialDuplicates={duplicates}
      initialWorkers={(workerRes.data as WorkerStatusRow[] | null) ?? []}
      kpi={{
        activeListings: activeListingsCount.count ?? 0,
        queuedJobs: queuedJobsCount.count ?? 0,
        openLeads: openLeadsCount.count ?? 0,
      }}
    />
  );
}
