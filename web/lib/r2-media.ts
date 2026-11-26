import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2ServerConfig } from "@/lib/supabase/env";

export interface RenderUrlCandidate {
  id?: string | null;
  storage_provider?: string | null;
  storage_object_path?: string | null;
  video_cdn_url?: string | null;
  storage_pruned_at?: string | null;
}

const DEFAULT_PLAYBACK_TTL_SECONDS = 3600;

function normalizeObjectKey(rawPath: string): string {
  return rawPath.replace(/^\/+/, "").trim();
}

function isSupabasePublicUrl(url: string): boolean {
  return url.includes("supabase.co/storage/v1/object/public/");
}

/**
 * Extracts the private R2 bucket key when a render points to R2 (raw `.r2.dev`,
 * `R2_MEDIA_BASE_URL`, or unsigned `r2.cloudflarestorage.com` URL).
 * Legacy Supabase Storage public URLs return `null` so they keep streaming directly.
 */
export function extractR2ObjectKey(
  render: RenderUrlCandidate,
  mediaBaseUrl?: string
): string | null {
  if (render.storage_pruned_at) {
    return null;
  }

  const rawUrl = render.video_cdn_url?.trim() || "";
  if (rawUrl && isSupabasePublicUrl(rawUrl)) {
    return null;
  }
  if (rawUrl && rawUrl.includes("X-Amz-Signature=")) {
    return null;
  }

  let isR2Hosted = false;
  let urlPathnameKey: string | null = null;

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      let configuredHost = "";
      if (mediaBaseUrl) {
        try {
          configuredHost = new URL(mediaBaseUrl).hostname;
        } catch {
          configuredHost = "";
        }
      }

      if (
        parsed.hostname.endsWith(".r2.dev") ||
        parsed.hostname.endsWith(".r2.cloudflarestorage.com") ||
        (configuredHost && parsed.hostname === configuredHost) ||
        parsed.pathname.startsWith("/v/videos/")
      ) {
        isR2Hosted = true;
        let cleanPath = parsed.pathname.replace(/^\/+/, "");
        if (cleanPath.startsWith("v/")) {
          cleanPath = cleanPath.slice(2);
        }
        try {
          cleanPath = decodeURIComponent(cleanPath);
        } catch {
          // Keep original pathname if percent-encoding is malformed
        }
        urlPathnameKey = normalizeObjectKey(cleanPath) || null;
      }
    } catch {
      // Non-URL string; ignore
    }
  } else if (render.storage_provider === "r2" && render.storage_object_path) {
    isR2Hosted = true;
  }

  if (!isR2Hosted) {
    return null;
  }

  const explicitKey = render.storage_object_path
    ? normalizeObjectKey(render.storage_object_path)
    : "";
  return explicitKey || urlPathnameKey || null;
}

/**
 * Resolves a working playback/fetch URL for a render version.
 * For private R2 assets, generates an S3 SigV4 presigned `GetObject` URL so both
 * browser `<video>` players (with byte-range seeking) and Telegram servers can read it.
 */
export async function resolvePlayableRenderUrl(
  render: RenderUrlCandidate | null | undefined,
  options?: { expiresInSeconds?: number }
): Promise<string | null> {
  if (!render || render.storage_pruned_at) {
    return null;
  }

  const rawUrl = render.video_cdn_url?.trim() || null;
  const r2Config = getR2ServerConfig();
  const objectKey = extractR2ObjectKey(render, r2Config.mediaBaseUrl);

  if (!objectKey || !r2Config.configured) {
    return rawUrl;
  }

  try {
    const s3 = new S3Client({
      region: "auto",
      endpoint: r2Config.endpoint,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });
    const command = new GetObjectCommand({
      Bucket: r2Config.bucket,
      Key: objectKey,
    });
    return await getSignedUrl(s3, command, {
      expiresIn: options?.expiresInSeconds ?? DEFAULT_PLAYBACK_TTL_SECONDS,
    });
  } catch (err) {
    console.warn("[r2-media] Failed to presign GetObject URL:", err);
    return rawUrl;
  }
}

export async function resolvePlayableRenders<T extends RenderUrlCandidate>(
  renders: T[],
  options?: { expiresInSeconds?: number }
): Promise<T[]> {
  return Promise.all(
    renders.map(async (render) => {
      const playableUrl = await resolvePlayableRenderUrl(render, options);
      if (!playableUrl || playableUrl === render.video_cdn_url) {
        return render;
      }
      return {
        ...render,
        video_cdn_url: playableUrl,
      };
    })
  );
}
