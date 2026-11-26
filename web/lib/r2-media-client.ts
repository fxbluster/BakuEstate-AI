export interface ClientRenderMediaLike {
  id?: string | null;
  storage_provider?: string | null;
  video_cdn_url?: string | null;
  storage_pruned_at?: string | null;
}

/**
 * Resolves a browser-playable `<video src>` from client-side state.
 * Signed R2 URLs and public Supabase Storage URLs pass through unchanged;
 * raw `.r2.dev` or unsigned `/v/videos/...` paths route through `/api/media/render/[id]`.
 */
export function resolveClientVideoSrc(
  render: ClientRenderMediaLike | null | undefined
): string | null {
  if (!render || render.storage_pruned_at) {
    return null;
  }

  const rawUrl = render.video_cdn_url?.trim() || "";
  if (!rawUrl) {
    if (render.id && render.storage_provider === "r2") {
      return `/api/media/render/${render.id}`;
    }
    return null;
  }

  if (
    rawUrl.includes("X-Amz-Signature=") ||
    rawUrl.includes("supabase.co/storage/v1/object/public/")
  ) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl);
    if (
      render.id &&
      (parsed.hostname.endsWith(".r2.dev") ||
        parsed.pathname.startsWith("/v/videos/") ||
        render.storage_provider === "r2")
    ) {
      return `/api/media/render/${render.id}`;
    }
  } catch {
    if (render.id && render.storage_provider === "r2") {
      return `/api/media/render/${render.id}`;
    }
  }

  return rawUrl;
}
