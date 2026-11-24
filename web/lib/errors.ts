export function extractErrorMessage(err: unknown): string {
  if (!err) return "Bilinməyən xəta baş verdi.";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const msg = typeof obj.message === "string" ? obj.message : "";
    const details = typeof obj.details === "string" ? obj.details : "";
    const hint = typeof obj.hint === "string" ? obj.hint : "";
    const combined = [msg, details && `(${details})`, hint && `[İpucu: ${hint}]`].filter(Boolean).join(" ");
    if (combined) return combined;
    if (typeof obj.error === "string") return obj.error;
    try {
      return JSON.stringify(err);
    } catch {
      return "Bilinməyən xəta.";
    }
  }
  return String(err);
}
