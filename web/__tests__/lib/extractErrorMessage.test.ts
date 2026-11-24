import { describe, it, expect } from "vitest";
import { extractErrorMessage } from "@/lib/errors";

describe("extractErrorMessage", () => {
  it("extracts Error message", () => {
    expect(extractErrorMessage(new Error("Database connection timeout"))).toBe("Database connection timeout");
  });

  it("handles plain strings", () => {
    expect(extractErrorMessage("Scrape rate limit exceeded")).toBe("Scrape rate limit exceeded");
  });

  it("formats PostgREST error object with details and hint", () => {
    const postgrestErr = {
      message: "violates check constraint",
      details: "Failing row contains (null, 'INVALID')",
      hint: "Value must be in ALLOWED_STATUSES",
    };
    expect(extractErrorMessage(postgrestErr)).toBe(
      "violates check constraint (Failing row contains (null, 'INVALID')) [İpucu: Value must be in ALLOWED_STATUSES]"
    );
  });

  it("never returns '[object Object]'", () => {
    expect(extractErrorMessage({})).not.toBe("[object Object]");
    expect(extractErrorMessage({ foo: "bar" })).toBe('{"foo":"bar"}');
    expect(extractErrorMessage(null)).toBe("Bilinməyən xəta baş verdi.");
  });
});
