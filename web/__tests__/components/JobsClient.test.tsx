import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JobsClient } from "@/components/JobsClient";
import type { PipelineJob, WorkerStatusRow } from "@/lib/types";

const mockInsert = vi.fn();

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
      insert: (row: unknown) => {
        mockInsert(row);
        return {
          select: () => ({
            single: async () => ({ data: null, error: null }),
          }),
        };
      },
      update: () => ({
        eq: async () => ({ error: null }),
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

const sampleWorker: WorkerStatusRow = {
  worker_id: "DESKTOP-6UBPFU0",
  last_seen_at: "2026-11-24T18:06:36Z",
  current_job_id: null,
  current_job_type: null,
  current_job_status: null,
  metadata_json: {},
  is_online: true,
  seconds_since_heartbeat: 12,
};

const sampleJobs: PipelineJob[] = [
  {
    id: "job-1",
    idempotency_key: "initial_render:6588858:1",
    job_type: "RENDER_INITIAL",
    listing_id: "list-uuid-1",
    trigger_source: "WEB_UI",
    params_json: {
      bina_id: "6588858",
      voice_preset: "Arif",
      target_account: "@bakuestate.premium",
    },
    status: "SUCCEEDED",
    attempts: 1,
    max_attempts: 2,
    locked_by: "DESKTOP-6UBPFU0",
    lease_expires_at: null,
    expires_at: null,
    error_message: null,
    created_at: "2026-11-24T15:39:00Z",
    started_at: "2026-11-24T15:39:05Z",
    finished_at: "2026-11-24T15:45:12Z",
    listings: {
      id: "list-uuid-1",
      bina_id: "6588858",
      title: "İnşaatçılar m., 3 otaqlı, 95 m²",
    },
  },
  {
    id: "job-2",
    idempotency_key: "preflight:6588858:1",
    job_type: "PREFLIGHT_CHECK",
    listing_id: "list-uuid-1",
    trigger_source: "WEB_UI",
    params_json: {
      bina_id: "6588858",
    },
    status: "SUCCEEDED",
    attempts: 1,
    max_attempts: 2,
    locked_by: "DESKTOP-6UBPFU0",
    lease_expires_at: null,
    expires_at: null,
    error_message: null,
    created_at: "2026-11-24T15:46:00Z",
    started_at: "2026-11-24T15:46:01Z",
    finished_at: "2026-11-24T15:46:03Z",
    listings: {
      id: "list-uuid-1",
      bina_id: "6588858",
      title: "İnşaatçılar m., 3 otaqlı, 95 m²",
    },
  },
];

describe("JobsClient UI Cleanup & Formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Azerbaijani Baku formatted dates (never M11) and readable chips instead of raw JSON", () => {
    render(<JobsClient initialJobs={sampleJobs} initialWorkers={[sampleWorker]} />);

    // Must NOT render broken M11 date or raw JSON parameters by default
    expect(screen.queryByText(/M11/)).toBeNull();
    expect(screen.queryByText(/Parametrlər:\s*\{/)).toBeNull();

    // Must show clean formatted date, duration, title, voice & account chips
    expect(screen.getByText(/24 Noy, 19:39/)).not.toBeNull();
    expect(screen.getAllByText(/İnşaatçılar m\., 3 otaqlı, 95 m²/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Səs: Arif/)).not.toBeNull();
    expect(screen.getByText("@bakuestate.premium")).not.toBeNull();
    expect(screen.getByText("Yayınöncəsi Qiymət Yoxlaması")).not.toBeNull();
  });

  it("prevents enqueueing duplicate SCRAPE_NEW when an active SCRAPE_NEW job is already queued", () => {
    const activeScrapeJob: PipelineJob = {
      ...sampleJobs[0],
      id: "job-scrape-active",
      job_type: "SCRAPE_NEW",
      status: "QUEUED",
      params_json: { pages: 2, limit: 3 },
      listings: null,
    };

    render(<JobsClient initialJobs={[activeScrapeJob]} initialWorkers={[sampleWorker]} />);

    const btn = screen.getByRole("button", { name: /Yeni Scrape Başlat/i });
    fireEvent.click(btn);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(screen.getByText(/artıq aktiv növbədədir/i)).not.toBeNull();
  });
});
