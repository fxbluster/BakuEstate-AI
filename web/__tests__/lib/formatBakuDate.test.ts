import { describe, it, expect } from "vitest";
import {
  formatBakuDate,
  formatBakuDateTime,
  formatDurationAz,
  JOB_TYPE_LABELS,
} from "@/lib/format";

describe("Baku Date Formatting & Job Labels", () => {
  it("formats Baku date-time cleanly with Azerbaijani month names instead of M01/M11 ICU fallbacks", () => {
    const out = formatBakuDateTime("2026-11-24T15:39:00Z");
    expect(out).toBe("24 Noy, 19:39");
    expect(out).not.toMatch(/M\d{2}/);
  });

  it("handles UTC to Asia/Baku (+4h) midnight rollover accurately", () => {
    const out = formatBakuDateTime("2026-11-24T21:05:00Z");
    expect(out).toBe("25 Noy, 01:05");
  });

  it("formats all 12 months cleanly in Azerbaijani", () => {
    const expectedMonths = [
      "Yan",
      "Fev",
      "Mar",
      "Apr",
      "May",
      "İyn",
      "İyl",
      "Avq",
      "Sen",
      "Okt",
      "Noy",
      "Dek",
    ];

    expectedMonths.forEach((label, idx) => {
      const m = String(idx + 1).padStart(2, "0");
      const formatted = formatBakuDate(`2026-${m}-15T10:00:00Z`);
      expect(formatted).toBe(`15 ${label} 2026`);
    });
  });

  it("handles null or invalid dates gracefully", () => {
    expect(formatBakuDateTime(null)).toBe("—");
    expect(formatBakuDateTime("invalid-date")).toBe("—");
    expect(formatBakuDate(undefined)).toBe("—");
  });

  it("formats duration between start and end timestamps", () => {
    expect(formatDurationAz("2026-11-24T15:39:00Z", "2026-11-24T15:45:12Z")).toBe("6 dəq 12 san");
    expect(formatDurationAz("2026-11-24T15:39:00Z", "2026-11-24T15:39:42Z")).toBe("42 san");
    expect(formatDurationAz("2026-11-24T15:39:00Z", "2026-11-24T16:40:00Z")).toBe("1 saat 1 dəq");
    expect(formatDurationAz(null, "2026-11-24T15:45:12Z")).toBe("—");
  });

  it("provides labels for all pipeline job types including PREFLIGHT_CHECK and TELEGRAM_DISPATCH", () => {
    expect(JOB_TYPE_LABELS.PREFLIGHT_CHECK).toBeTruthy();
    expect(JOB_TYPE_LABELS.TELEGRAM_DISPATCH).toBeTruthy();
    expect(JOB_TYPE_LABELS.RENDER_INITIAL).toBe("İlkin Video Render");
  });
});
