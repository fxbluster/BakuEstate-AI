export const DEFAULT_R2_MEDIA_BASE_URL = "https://media.bakuestate.az";

export function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabaseEnv();
  return Boolean(url && anonKey && !url.includes("your-project-ref"));
}

/**
 * Returns the sanitized Cloudflare R2 custom media CDN base URL (no trailing slash).
 * Falls back safely to https://media.bakuestate.az if unset or non-HTTPS.
 */
export function getR2MediaBaseUrl(): string {
  const raw = (
    process.env.NEXT_PUBLIC_R2_MEDIA_BASE_URL ??
    process.env.R2_MEDIA_BASE_URL ??
    ""
  ).trim();
  if (!raw) {
    return DEFAULT_R2_MEDIA_BASE_URL;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      return DEFAULT_R2_MEDIA_BASE_URL;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_R2_MEDIA_BASE_URL;
  }
}

/**
 * Server-only validated HTTP/HTTPS proxy URL for bina.az (Webshare ISP / Static Residential).
 * Returns null if unset or invalid. (Non-NEXT_PUBLIC env vars are never exposed to browsers.)
 */
export function getBinaProxyUrl(): string | null {
  const raw = (process.env.BINA_PROXY_URL ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Server-only R2 S3 client configuration for generating pre-signed PUT URLs.
 */
export function getR2ServerConfig() {
  const accountId = (process.env.R2_ACCOUNT_ID ?? "").trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY ?? "").trim();
  const bucket = (
    process.env.R2_BUCKET ??
    process.env.R2_BUCKET_NAME ??
    "baku-estate-media"
  ).trim();
  const mediaBaseUrl = getR2MediaBaseUrl();
  const endpoint = accountId
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : "";

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint,
    mediaBaseUrl,
    configured: Boolean(accountId && accessKeyId && secretAccessKey && bucket),
  };
}
