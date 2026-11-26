import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import { resolvePlayableRenderUrl } from "@/lib/r2-media";

export const dynamic = "force-dynamic";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireOperator(request);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  const { id } = await context.params;
  const renderId = decodeURIComponent(id || "").trim();
  if (!UUID_REGEX.test(renderId)) {
    return NextResponse.json(
      { error: "Etibarsız render versiyası ID-si." },
      { status: 400 }
    );
  }

  const supabaseAdmin = createAdminClient();
  const { data: render, error: renderErr } = await supabaseAdmin
    .from("render_versions")
    .select(
      "id, listing_id, storage_provider, storage_object_path, video_cdn_url, storage_pruned_at"
    )
    .eq("id", renderId)
    .maybeSingle();

  if (renderErr || !render) {
    return NextResponse.json(
      { error: "Video render versiyası tapılmadı." },
      { status: 404 }
    );
  }

  const { data: listing, error: listingErr } = await supabaseAdmin
    .from("listings")
    .select("id, agency_id")
    .eq("id", render.listing_id)
    .maybeSingle();

  if (
    listingErr ||
    !listing ||
    (listing.agency_id && listing.agency_id !== operator.agencyId)
  ) {
    return NextResponse.json(
      { error: "Video render versiyası tapılmadı." },
      { status: 404 }
    );
  }

  if (render.storage_pruned_at) {
    return NextResponse.json(
      { error: "Video faylı saxlancdan təmizlənib." },
      { status: 410 }
    );
  }

  const playableUrl = await resolvePlayableRenderUrl(render, {
    expiresInSeconds: 3600,
  });

  if (!playableUrl) {
    return NextResponse.json(
      { error: "Video linki hazır deyil." },
      { status: 404 }
    );
  }

  return NextResponse.redirect(playableUrl, {
    status: 307,
    headers: {
      "Cache-Control": "private, no-store",
    },
  });
}
