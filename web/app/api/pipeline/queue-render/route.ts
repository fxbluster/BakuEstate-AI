import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import { getR2MediaBaseUrl } from "@/lib/supabase/env";
import type { QueueRenderPayload, QueueRenderResponse } from "@/lib/ai-client";
import { extractErrorMessage } from "@/lib/errors";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_STUDIO_PHOTOS = 4;
const MAX_STUDIO_PHOTOS = 10;
const MAX_CUSTOM_SCRIPT_CHARS = 1000;

function isPrivateOrBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const secondOctet = Number(match172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  if (/^(fc|fd|fe80)/i.test(host)) return true;
  return false;
}

function isAllowlistedPhotoUrl(
  rawUrl: string,
  listingPhotoSet: Set<string>,
  agencyId: string,
  r2BaseUrl: string
): boolean {
  if (!rawUrl || typeof rawUrl !== "string" || rawUrl.includes("..")) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    return false;
  }
  if (parsed.pathname.includes("..")) {
    return false;
  }

  if (listingPhotoSet.has(rawUrl)) {
    return true;
  }

  try {
    const r2Origin = new URL(r2BaseUrl).origin;
    const expectedPrefix = `/staging/${agencyId}/`;
    if (
      parsed.origin === r2Origin &&
      parsed.pathname.startsWith(expectedPrefix) &&
      parsed.pathname.length > expectedPrefix.length
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export async function POST(request: Request) {
  const auth = await requireOperator(request);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  let body: QueueRenderPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Sorğu gövdəsi etibarlı JSON deyil.",
      } as QueueRenderResponse,
      { status: 400 }
    );
  }

  const { listing_id, voice_preset, selected_photo_urls, custom_script_text } =
    body;
  const target_account = body.target_account || "@bakuestate.premium";
  const jobType = body.job_type || "RENDER_INITIAL";

  if (!listing_id) {
    return NextResponse.json(
      {
        success: false,
        error: "listing_id parametri tələb olunur.",
      } as QueueRenderResponse,
      { status: 400 }
    );
  }

  if (jobType !== "RENDER_INITIAL" && jobType !== "RERENDER") {
    return NextResponse.json(
      {
        success: false,
        error: "job_type yalnız RENDER_INITIAL və ya RERENDER ola bilər.",
      } as QueueRenderResponse,
      { status: 400 }
    );
  }

  if (custom_script_text !== undefined && custom_script_text !== null) {
    if (typeof custom_script_text !== "string") {
      return NextResponse.json(
        {
          success: false,
          error: "custom_script_text mətn (string) formatında olmalıdır.",
        } as QueueRenderResponse,
        { status: 400 }
      );
    }
    if (custom_script_text.length > MAX_CUSTOM_SCRIPT_CHARS) {
      return NextResponse.json(
        {
          success: false,
          error: `Ssenari mətni maksimum ${MAX_CUSTOM_SCRIPT_CHARS} simvol ola bilər.`,
        } as QueueRenderResponse,
        { status: 400 }
      );
    }
  }

  if (selected_photo_urls !== undefined) {
    if (
      !Array.isArray(selected_photo_urls) ||
      selected_photo_urls.length < MIN_STUDIO_PHOTOS ||
      selected_photo_urls.length > MAX_STUDIO_PHOTOS
    ) {
      return NextResponse.json(
        {
          success: false,
          error: `selected_photo_urls ${MIN_STUDIO_PHOTOS} ilə ${MAX_STUDIO_PHOTOS} arasında foto daxil etməlidir.`,
        } as QueueRenderResponse,
        { status: 400 }
      );
    }
  }

  const supabaseAdmin = createAdminClient();
  const isUuid = UUID_REGEX.test(listing_id);

  let resolvedListingUuid: string | null = null;
  let binaId = body.bina_id;
  let listingPhotoUrls: string[] = [];

  try {
    let query = supabaseAdmin
      .from("listings")
      .select("id, bina_id, photo_urls")
      .eq("agency_id", operator.agencyId);

    if (isUuid) {
      query = query.eq("id", listing_id);
    } else {
      query = query.eq("bina_id", String(listing_id));
    }

    const { data: listing } = await query.maybeSingle();
    if (!listing?.id) {
      return NextResponse.json(
        {
          success: false,
          error: "Elan tapılmadı və ya bu agentliyə aid deyil.",
        } as QueueRenderResponse,
        { status: 404 }
      );
    }

    resolvedListingUuid = listing.id;
    binaId = binaId || listing.bina_id || undefined;
    listingPhotoUrls = Array.isArray(listing.photo_urls)
      ? listing.photo_urls.filter((u: unknown): u is string => typeof u === "string")
      : [];
  } catch (lookupErr) {
    return NextResponse.json(
      {
        success: false,
        error: extractErrorMessage(lookupErr),
      } as QueueRenderResponse,
      { status: 500 }
    );
  }

  let validatedPhotos: string[] | undefined;
  if (selected_photo_urls !== undefined) {
    const r2BaseUrl = getR2MediaBaseUrl();
    const allowedSet = new Set(listingPhotoUrls);
    validatedPhotos = [];

    for (const raw of selected_photo_urls) {
      if (
        typeof raw !== "string" ||
        !isAllowlistedPhotoUrl(raw.trim(), allowedSet, operator.agencyId, r2BaseUrl)
      ) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Seçilmiş foto URL-i elanın və ya agentliyin icazəli siyahısında deyil (SSRF qoruması).",
          } as QueueRenderResponse,
          { status: 400 }
        );
      }
      validatedPhotos.push(raw.trim());
    }
  }

  try {
    const paramsJson: Record<string, unknown> = {
      bina_id: binaId ?? null,
      target_account,
      voice_preset: voice_preset || "Arif",
      requested_by: operator.operatorId,
    };
    if (validatedPhotos) {
      paramsJson.selected_photo_urls = validatedPhotos;
    }
    if (typeof custom_script_text === "string" && custom_script_text.trim()) {
      paramsJson.custom_script_text = custom_script_text.trim();
    }

    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
      "enqueue_listing_render_atomic",
      {
        p_listing_id: resolvedListingUuid,
        p_job_type: jobType,
        p_target_account: target_account,
        p_voice_preset: voice_preset || "Arif",
        p_params_json: paramsJson,
      }
    );

    if (rpcErr) {
      throw rpcErr;
    }

    const payload = (rpcResult || {}) as {
      ok?: boolean;
      already_queued?: boolean;
      job_id?: string;
      error?: string;
    };

    if (payload.ok === false) {
      return NextResponse.json(
        {
          success: false,
          error: payload.error || "Montaj işi növbəyə yazıla bilmədi.",
        } as QueueRenderResponse,
        { status: 400 }
      );
    }

    if (payload.already_queued) {
      return NextResponse.json({
        success: true,
        job_id: payload.job_id,
        already_queued: true,
        message: `Elan #${binaId || resolvedListingUuid} artıq montaj növbəsindədir.`,
      } as QueueRenderResponse);
    }

    return NextResponse.json({
      success: true,
      job_id: payload.job_id,
    } as QueueRenderResponse);
  } catch (err: unknown) {
    const message = extractErrorMessage(err);
    console.error("[QUEUE_RENDER ERROR]:", err);
    return NextResponse.json(
      {
        success: false,
        error: message,
      } as QueueRenderResponse,
      { status: 500 }
    );
  }
}
