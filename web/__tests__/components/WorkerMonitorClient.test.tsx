import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkerMonitorClient } from "@/components/WorkerMonitorClient";
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

const onlineProcessingWorker: WorkerStatusRow = {
  worker_id: "DESKTOP-6UBPFU0",
  last_seen_at: new Date().toISOString(),
  current_job_id: "job-running-1",
  current_job_type: "RENDER_INITIAL",
  current_job_status: "RUNNING",
  current_job_started_at: new Date(Date.now() - 45_000).toISOString(),
  current_listing_bina_id: "6588858",
  current_listing_title: "İnşaatçılar m., 3 otaqlı, 95 m²",
  metadata_json: {
    state: "PROCESSING",
    pid: 14820,
    started_at: new Date(Date.now() - 3_720_000).toISOString(),
    jobs_processed_session: 4,
    current_phase: "Video montaj və TTS səs sintezi aparılır",
    current_bina_id: "6588858",
    next_schedule_baku: "19:30",
    recent_logs: [
      {
        ts: "2026-11-24T15:39:05Z",
        level: "INFO",
        msg: "ElevenLabs synthesized 556KB speech -> video_6588858.mp4",
      },
      {
        ts: "2026-11-24T15:39:25Z",
        level: "WARNING",
        msg: "Rate limit backoff test message",
      },
    ],
  },
  is_online: true,
  seconds_since_heartbeat: 4,
};

const offlineWorker: WorkerStatusRow = {
  worker_id: "DESKTOP-6UBPFU0",
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
    locked_by: "DESKTOP-6UBPFU0",
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

describe("WorkerMonitorClient Live Tracking Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("displays live active job phase, PID, next Baku schedule, and console logs when online", () => {
    render(
      <WorkerMonitorClient
        initialWorkers={[onlineProcessingWorker]}
        initialJobs={sampleRecentJobs}
      />
    );

    expect(screen.getByText("DESKTOP-6UBPFU0")).not.toBeNull();
    expect(screen.getByText(/İŞLƏYİR/i)).not.toBeNull();
    expect(screen.getByText(/Video montaj və TTS səs sintezi aparılır/)).not.toBeNull();
    expect(screen.getByText(/PID 14820/)).not.toBeNull();
    expect(screen.getByText("19:30")).not.toBeNull();
    expect(screen.getByText(/ElevenLabs synthesized 556KB speech/)).not.toBeNull();
    expect(screen.getAllByText(/#6588858/).length).toBeGreaterThan(0);
  });

  it("displays offline diagnostic guidance and startup script command when worker is offline", () => {
    render(<WorkerMonitorClient initialWorkers={[offlineWorker]} initialJobs={[]} />);

    expect(screen.getByText("OFLAYN")).not.toBeNull();
    expect(screen.getByText(/setup_worker_service\.ps1 -Start/)).not.toBeNull();
  });
});
