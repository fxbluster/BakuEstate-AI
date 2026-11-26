import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkerMonitorClient } from "@/components/WorkerMonitorClient";
import { WorkerStatusBadge } from "@/components/WorkerStatusBadge";
import type { PipelineJob, WorkerStatusRow } from "@/lib/types";

vi.mock("@/lib/supabase/env", () => ({
  isSupabaseConfigured: () => true,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        order: () => ({
          limit: async () => ({ data: [], error: null }),
        }),
      }),
    }),
    channel: () => ({
      on: function () {
        return this;
      },
      subscribe: () => ({}),
    }),
    removeChannel: vi.fn(),
  }),
}));

const railwayReplica1: WorkerStatusRow = {
  worker_id: "railway-worker-1",
  last_seen_at: new Date().toISOString(),
  current_job_id: "job-running-1",
  current_job_type: "RENDER_INITIAL",
  current_job_status: "RUNNING",
  current_job_started_at: new Date(Date.now() - 45_000).toISOString(),
  current_listing_bina_id: "6588858",
  current_listing_title: "İnşaatçılar m., 3 otaqlı, 95 m²",
  metadata_json: {
    state: "PROCESSING",
    pid: 101,
    started_at: new Date(Date.now() - 3_720_000).toISOString(),
    jobs_processed_session: 4,
    current_phase: "Video montaj və TTS səs sintezi aparılır",
    current_bina_id: "6588858",
    next_schedule_baku: "19:30",
    recent_logs: [
      {
        ts: "2026-11-25T15:39:05Z",
        level: "INFO",
        msg: "R2 upload completed -> videos/ag1/list1/v1.mp4",
      },
      {
        ts: "2026-11-25T15:39:25Z",
        level: "WARNING",
        msg: "Rate limit backoff test message",
      },
    ],
  },
  is_online: true,
  seconds_since_heartbeat: 4,
};

const railwayReplica2: WorkerStatusRow = {
  worker_id: "railway-worker-2",
  last_seen_at: new Date().toISOString(),
  current_job_id: null,
  current_job_type: null,
  current_job_status: null,
  metadata_json: {
    state: "IDLE",
    pid: 202,
    started_at: new Date(Date.now() - 1_800_000).toISOString(),
    jobs_processed_session: 7,
    current_phase: "Hazır — bulud növbəsi dinlənilir",
    recent_logs: [
      {
        ts: "2026-11-25T15:40:00Z",
        level: "INFO",
        msg: "Replica 2 heartbeat OK",
      },
    ],
  },
  is_online: true,
  seconds_since_heartbeat: 2,
};

const offlineReplica: WorkerStatusRow = {
  worker_id: "railway-worker-offline",
  last_seen_at: "2026-11-24T18:06:36Z",
  current_job_id: null,
  current_job_type: null,
  current_job_status: null,
  metadata_json: {
    state: "STOPPED",
    recent_logs: [],
  },
  is_online: false,
  seconds_since_heartbeat: 9112,
};

const sampleRecentJobs: PipelineJob[] = [
  {
    id: "job-running-1",
    idempotency_key: "initial_render:6588858:1",
    job_type: "RENDER_INITIAL",
    listing_id: "list-uuid-1",
    trigger_source: "WEB_UI",
    params_json: {
      bina_id: "6588858",
      voice_preset: "Arif",
      target_account: "@bakuestate.premium",
    },
    status: "RUNNING",
    attempts: 1,
    max_attempts: 2,
    locked_by: "railway-worker-1",
    lease_expires_at: null,
    expires_at: null,
    error_message: null,
    created_at: new Date(Date.now() - 50_000).toISOString(),
    started_at: new Date(Date.now() - 45_000).toISOString(),
    finished_at: null,
    listings: {
      id: "list-uuid-1",
      bina_id: "6588858",
      title: "İnşaatçılar m., 3 otaqlı, 95 m²",
    },
  },
];

describe("WorkerMonitorClient Multi-Replica Railway Cloud Monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all active Railway container replicas simultaneously with live job phase, PID, and per-replica console logs", () => {
    render(
      <WorkerMonitorClient
        initialWorkers={[railwayReplica1, railwayReplica2]}
        initialJobs={sampleRecentJobs}
      />
    );

    expect(screen.getAllByText("railway-worker-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("railway-worker-2").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 \/ 2 Replika Onlayn/i)).not.toBeNull();
    expect(screen.getByText("İŞLƏYİR")).not.toBeNull();
    expect(screen.getByText("ONLAYN")).not.toBeNull();
    expect(
      screen.getByText(/Video montaj və TTS səs sintezi aparılır/)
    ).not.toBeNull();
    expect(screen.getByText(/PID 101/)).not.toBeNull();
    expect(screen.getByText(/PID 202/)).not.toBeNull();
    expect(screen.getByText(/R2 upload completed/)).not.toBeNull();
    expect(screen.getAllByText(/#6588858/).length).toBeGreaterThan(0);

    // Switch console view to replica 2
    fireEvent.click(screen.getByRole("button", { name: /railway-worker-2/i }));
    expect(screen.getByText(/Replica 2 heartbeat OK/)).not.toBeNull();
  });

  it("displays Railway cloud diagnostic guidance when all replicas are offline and never renders Windows PowerShell startup script", () => {
    render(
      <WorkerMonitorClient
        initialWorkers={[offlineReplica]}
        initialJobs={[]}
      />
    );

    expect(screen.getAllByText(/OFLAYN/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Railway bulud worker replikaları hazırda oflayndır/i)
    ).not.toBeNull();
    expect(screen.queryByText(/setup_worker_service\.ps1/i)).toBeNull();
    expect(screen.queryByText(/powershell/i)).toBeNull();
  });

  it("hides retired OFFLINE deploy containers when an online replica exists and displays global statusCounts", () => {
    const staleOffline2: WorkerStatusRow = {
      ...offlineReplica,
      worker_id: "rep-old-dead-deploy-2",
    };

    render(
      <WorkerMonitorClient
        initialWorkers={[offlineReplica, staleOffline2, railwayReplica2]}
        initialJobs={[]}
        statusCounts={{ ALL: 90, QUEUED: 3, SUCCEEDED: 82, FAILED: 5 }}
      />
    );

    expect(screen.getAllByText("railway-worker-2").length).toBeGreaterThan(0);
    expect(screen.queryByText("railway-worker-offline")).toBeNull();
    expect(screen.queryByText("rep-old-dead-deploy-2")).toBeNull();
    expect(screen.getByText(/1 \/ 1 Replika Onlayn/i)).not.toBeNull();
    expect(screen.getByText(/3 gözləyir/i)).not.toBeNull();
    expect(screen.getByText(/82 uğurlu/i)).not.toBeNull();
  });

  it("WorkerStatusBadge selects online idle worker instead of stale offline first entry", () => {
    const staleBusyOffline: WorkerStatusRow = {
      ...offlineReplica,
      current_job_id: "old-job",
      metadata_json: { state: "PROCESSING" },
      is_online: false,
    };

    render(
      <WorkerStatusBadge
        initialWorkers={[staleBusyOffline, railwayReplica2]}
        compact
      />
    );

    expect(screen.getByText("Worker Onlayn")).not.toBeNull();
    expect(screen.queryByText("Worker İşləyir")).toBeNull();
  });
});
