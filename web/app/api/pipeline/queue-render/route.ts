import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import type { QueueRenderPayload, QueueRenderResponse } from "@/lib/ai-client";
import { extractErrorMessage } from "@/lib/errors";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const supabaseAdmin = createAdminClient();
  const isUuid = UUID_REGEX.test(listing_id);

  let resolvedListingUuid: string | null = null;
  let binaId = body.bina_id;

  try {
    let query = supabaseAdmin
      .from("listings")
      .select("id, bina_id")
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
  } catch (lookupErr) {
    return NextResponse.json(
      {
        success: false,
        error: extractErrorMessage(lookupErr),
      } as QueueRenderResponse,
      { status: 500 }
    );
  }

  try {
    const paramsJson: Record<string, unknown> = {
      bina_id: binaId ?? null,
      target_account,
      voice_preset: voice_preset || "Arif",
      requested_by: operator.operatorId,
    };
    if (Array.isArray(selected_photo_urls)) {
      paramsJson.selected_photo_urls = selected_photo_urls;
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
