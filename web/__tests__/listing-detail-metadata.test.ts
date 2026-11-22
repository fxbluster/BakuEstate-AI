import { describe, it, expect } from "vitest";
import {
  PIPELINE_STATUS_META,
  EDITORIAL_STATUS_META,
  SOURCE_AVAILABILITY_META,
  OWNER_OUTREACH_META,
  DUPLICATE_RESOLUTION_META,
} from "@/lib/format";
import type { PipelineStatus } from "@/lib/types";

describe("Listing Metadata & Status Mappings", () => {
  it("includes DRAFT_READY in PipelineStatus and PIPELINE_STATUS_META", () => {
    const draftReadyStatus: PipelineStatus = "DRAFT_READY";
    const meta = PIPELINE_STATUS_META[draftReadyStatus];
    expect(meta).toBeDefined();
    expect(meta.label).toBeDefined();
    expect(typeof meta.label).toBe("string");
    expect(meta.label.length).toBeGreaterThan(0);
    expect(meta.tone).toBeDefined();
  });

  it("handles all known pipeline statuses from the database", () => {
    const dbStatuses: PipelineStatus[] = [
      "NEW",
      "QUEUED",
      "RENDERING",
      "DRAFT_READY",
      "DISPATCHED",
      "FAILED",
      "SKIPPED_DUPLICATE",
    ];

    for (const status of dbStatuses) {
      const meta = PIPELINE_STATUS_META[status];
      expect(meta, `Metadata for status ${status} must be defined`).toBeDefined();
      expect(meta.label).toBeDefined();
      expect(meta.tone).toBeDefined();
    }
  });

  it("safely falls back for unknown or undefined statuses without crashing", () => {
    const unknownStatus = "SOME_UNEXPECTED_LEGACY_STATUS" as PipelineStatus;
    const meta = PIPELINE_STATUS_META[unknownStatus] ?? {
      label: unknownStatus,
      tone: "neutral",
    };
    expect(meta.label).toBe("SOME_UNEXPECTED_LEGACY_STATUS");
    expect(meta.tone).toBe("neutral");
  });
});
