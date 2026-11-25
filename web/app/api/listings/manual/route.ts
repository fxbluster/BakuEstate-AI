import { NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import { getR2MediaBaseUrl, getR2ServerConfig } from "@/lib/supabase/env";
import { normalizePhoneInput } from "@/lib/format";
import type { ChannelNiche } from "@/lib/types";

export const runtime = "nodejs";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB
const MIN_PHOTOS = 4;
const MAX_PHOTOS = 10;
const PRESIGN_TTL_SECONDS = 900; // 15 minutes

const ELITE_CENTRAL_DISTRICTS = [
  "səbail",
  "sebail",
  "nəsimi",
  "nasimi",
  "nərimanov",
  "nerimanov",
  "gənclik",
  "genclik",
  "ağ şəhər",
  "ag seher",
  "ag sheher",
  "white city",
  "badamdar",
  "bilgəh",
  "bilgeh",
  "mərdəkan",
  "merdekan",
];

const SUBURBAN_DISTRICTS = [
  "xırdalan",
  "xirdalan",
  "masazır",
  "masazir",
  "hövsan",
  "hovsan",
  "zabrat",
  "suraxanı",
  "suraxani",
  "binəqədi",
  "bineqedi",
  "sabunçu",
  "sabuncu",
];

function computeCanonicalNiche(
  priceAzn: number,
  district: string,
  rules?: { luxury_min_azn?: number; affordable_max_azn?: number } | null
): ChannelNiche {
  const luxuryMin =
    typeof rules?.luxury_min_azn === "number" && Number.isFinite(rules.luxury_min_azn)
      ? rules.luxury_min_azn
      : 250_000;
  const affordableMax =
    typeof rules?.affordable_max_azn === "number" && Number.isFinite(rules.affordable_max_azn)
      ? rules.affordable_max_azn
      : 120_000;

  const normalizedDistrict = district.trim().toLowerCase();
  const isElite = ELITE_CENTRAL_DISTRICTS.some((d) =>
    normalizedDistrict.includes(d)
  );
  const isSuburban = SUBURBAN_DISTRICTS.some((d) =>
    normalizedDistrict.includes(d)
  );

  if (priceAzn >= luxuryMin || isElite) {
    return "LUXURY";
  }
  if (isSuburban || (priceAzn > 0 && priceAzn <= affordableMax)) {
    return "AFFORDABLE";
  }
  return "GENERAL";
}

interface PhotoFileInput {
  name: string;
  contentType: string;
  sizeBytes: number;
}

interface ManualListingPostBody {
  title?: unknown;
  price_azn?: unknown;
  area_m2?: unknown;
  rooms?: unknown;
  district?: unknown;
  address?: unknown;
  has_bill_of_sale?: unknown;
  owner_name?: unknown;
  owner_phone?: unknown;
  description?: unknown;
  floor?: unknown;
  floors?: unknown;
  photo_files?: unknown;
}

interface ManualListingPatchBody {
  listing_id?: unknown;
  photo_urls?: unknown;
}

function isSafeAgencyStagingUrl(
  rawUrl: string,
  agencyId: string,
  mediaBaseUrl: string
): boolean {
  if (!rawUrl || typeof rawUrl !== "string" || rawUrl.includes("..")) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    const base = new URL(mediaBaseUrl);
    if (parsed.protocol !== "https:") return false;
    if (parsed.origin !== base.origin) return false;
    const expectedPrefix = `/staging/${agencyId}/`;
    if (!parsed.pathname.startsWith(expectedPrefix)) return false;
    if (parsed.pathname.length <= expectedPrefix.length) return false;
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const auth = await requireOperator(request, ["ADMIN", "BROKER"]);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  let body: ManualListingPostBody;
  try {
    body = (await request.json()) as ManualListingPostBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Sorğu gövdəsi etibarlı JSON deyil." },
      { status: 400 }
    );
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const district = typeof body.district === "string" ? body.district.trim() : "";
  const address = typeof body.address === "string" ? body.address.trim() : "";
  const priceAzn = Number(body.price_azn);
  const areaM2 = Number(body.area_m2);
  const rooms = Number(body.rooms);

  if (!title || title.length > 300) {
    return NextResponse.json(
      { ok: false, error: "Elan başlığı (title) tələb olunur (maksimum 300 simvol)." },
      { status: 400 }
    );
  }
  if (!Number.isFinite(priceAzn) || priceAzn <= 0) {
    return NextResponse.json(
      { ok: false, error: "price_azn müsbət ədəd olmalıdır." },
      { status: 400 }
    );
  }
  if (!Number.isFinite(areaM2) || areaM2 <= 0) {
    return NextResponse.json(
      { ok: false, error: "area_m2 müsbət ədəd olmalıdır." },
      { status: 400 }
    );
  }
  if (!Number.isInteger(rooms) || rooms < 1 || rooms > 50) {
    return NextResponse.json(
      { ok: false, error: "rooms 1 ilə 50 arasında tam ədəd olmalıdır." },
      { status: 400 }
    );
  }
  if (!district) {
    return NextResponse.json(
      { ok: false, error: "district (rayon) tələb olunur." },
      { status: 400 }
    );
  }
  if (!address) {
    return NextResponse.json(
      { ok: false, error: "address (ünvan) tələb olunur." },
      { status: 400 }
    );
  }

  const validatedFiles: PhotoFileInput[] = [];
  if (body.photo_files !== undefined) {
    if (!Array.isArray(body.photo_files)) {
      return NextResponse.json(
        { ok: false, error: "photo_files massiv olmalıdır." },
        { status: 400 }
      );
    }
    if (
      body.photo_files.length < MIN_PHOTOS ||
      body.photo_files.length > MAX_PHOTOS
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: `Foto sayı ${MIN_PHOTOS} ilə ${MAX_PHOTOS} arasında olmalıdır.`,
        },
        { status: 400 }
      );
    }

    for (const item of body.photo_files) {
      if (!item || typeof item !== "object") {
        return NextResponse.json(
          { ok: false, error: "photo_files elementi etibarsızdır." },
          { status: 400 }
        );
      }
      const f = item as Record<string, unknown>;
      const name = typeof f.name === "string" ? f.name.trim() : "";
      const contentType =
        typeof f.contentType === "string" ? f.contentType.trim().toLowerCase() : "";
      const sizeBytes = Number(f.sizeBytes);

      if (!name) {
        return NextResponse.json(
          { ok: false, error: "Hər foto faylının adı (name) olmalıdır." },
          { status: 400 }
        );
      }
      if (!ALLOWED_MIME_TO_EXT[contentType]) {
        return NextResponse.json(
          {
            ok: false,
            error: `Yalnız image/jpeg, image/png və image/webp formatları dəstəklənir (${contentType || "boş"}).`,
          },
          { status: 400 }
        );
      }
      if (
        !Number.isFinite(sizeBytes) ||
        sizeBytes <= 0 ||
        sizeBytes > MAX_PHOTO_BYTES
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: `Hər foto maksimum 10 MB ola bilər (${name}).`,
          },
          { status: 400 }
        );
      }

      validatedFiles.push({ name, contentType, sizeBytes });
    }
  }

  const r2Config = getR2ServerConfig();
  if (validatedFiles.length > 0 && !r2Config.configured) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Cloudflare R2 saxlanc konfiqurasiyası (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) təyin edilməyib.",
      },
      { status: 503 }
    );
  }

  const supabase = createAdminClient();

  const { data: settingsRow } = await supabase
    .from("agency_settings")
    .select("niche_rules_json")
    .eq("agency_id", operator.agencyId)
    .maybeSingle();

  const nicheRules = (settingsRow?.niche_rules_json ?? null) as {
    luxury_min_azn?: number;
    affordable_max_azn?: number;
  } | null;

  const canonicalNiche = computeCanonicalNiche(priceAzn, district, nicheRules);
  const hasBillOfSale = body.has_bill_of_sale === true;
  const ownerName =
    typeof body.owner_name === "string" && body.owner_name.trim()
      ? body.owner_name.trim()
      : null;
  const ownerPhone =
    typeof body.owner_phone === "string" && body.owner_phone.trim()
      ? body.owner_phone.trim()
      : null;
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : null;
  const floorVal =
    body.floor !== undefined && body.floor !== null && Number.isInteger(Number(body.floor))
      ? Number(body.floor)
      : null;
  const floorsVal =
    body.floors !== undefined && body.floors !== null && Number.isInteger(Number(body.floors))
      ? Number(body.floors)
      : null;

  const { data: createdListing, error: insertErr } = await supabase
    .from("listings")
    .insert({
      agency_id: operator.agencyId,
      assigned_agent_id: operator.operatorId,
      created_by: operator.operatorId,
      source_type: "OFF_MARKET",
      canonical_niche: canonicalNiche,
      bina_id: null,
      url: null,
      title,
      price: priceAzn,
      currency: "AZN",
      price_azn_normalized: priceAzn,
      location: district,
      district_normalized: district,
      address,
      rooms,
      area: areaM2,
      floor: floorVal,
      floors: floorsVal,
      has_bill_of_sale: hasBillOfSale,
      is_owner: true,
      contact_name: ownerName,
      description,
      photo_urls: [],
      source_availability: "ACTIVE",
      pipeline_status: "NEW",
      editorial_status: "PENDING_REVIEW",
    })
    .select("*")
    .single();

  if (insertErr || !createdListing?.id) {
    return NextResponse.json(
      {
        ok: false,
        error: insertErr?.message || "Eksklüziv elan bazaya yazıla bilmədi.",
      },
      { status: 500 }
    );
  }

  if (ownerName || ownerPhone) {
    const normalizedPhone = ownerPhone ? normalizePhoneInput(ownerPhone) : null;
    await supabase.from("listing_owner_contacts").insert({
      listing_id: createdListing.id,
      agency_id: operator.agencyId,
      owner_name: ownerName,
      owner_phone_raw: ownerPhone,
      owner_phone_normalized: normalizedPhone,
    });
  }

  const uploadUrls: Array<{
    object_key: string;
    put_url: string;
    public_path: string;
    content_type: string;
    expires_in: number;
  }> = [];

  if (validatedFiles.length > 0) {
    const s3 = new S3Client({
      region: "auto",
      endpoint: r2Config.endpoint,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });

    for (let i = 0; i < validatedFiles.length; i++) {
      const file = validatedFiles[i];
      const ext = ALLOWED_MIME_TO_EXT[file.contentType];
      const objectKey = `staging/${operator.agencyId}/${createdListing.id}/${i + 1}-${crypto.randomUUID()}.${ext}`;
      const command = new PutObjectCommand({
        Bucket: r2Config.bucket,
        Key: objectKey,
        ContentType: file.contentType,
        ContentLength: file.sizeBytes,
      });

      const putUrl = await getSignedUrl(s3, command, {
        expiresIn: PRESIGN_TTL_SECONDS,
      });

      uploadUrls.push({
        object_key: objectKey,
        put_url: putUrl,
        public_path: `${r2Config.mediaBaseUrl}/${objectKey}`,
        content_type: file.contentType,
        expires_in: PRESIGN_TTL_SECONDS,
      });
    }
  }

  return NextResponse.json(
    {
      ok: true,
      listing_id: createdListing.id,
      listing: createdListing,
      upload_urls: uploadUrls,
    },
    { status: 201 }
  );
}

export async function PATCH(request: Request) {
  const auth = await requireOperator(request, ["ADMIN", "BROKER"]);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  let body: ManualListingPatchBody;
  try {
    body = (await request.json()) as ManualListingPatchBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Sorğu gövdəsi etibarlı JSON deyil." },
      { status: 400 }
    );
  }

  const listingId =
    typeof body.listing_id === "string" ? body.listing_id.trim() : "";
  if (!UUID_REGEX.test(listingId)) {
    return NextResponse.json(
      { ok: false, error: "listing_id etibarlı UUID olmalıdır." },
      { status: 400 }
    );
  }

  if (
    !Array.isArray(body.photo_urls) ||
    body.photo_urls.length < MIN_PHOTOS ||
    body.photo_urls.length > MAX_PHOTOS
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: `photo_urls ${MIN_PHOTOS} ilə ${MAX_PHOTOS} arasında URL daxil etməlidir.`,
      },
      { status: 400 }
    );
  }

  const mediaBaseUrl = getR2MediaBaseUrl();
  const sanitizedUrls: string[] = [];
  for (const raw of body.photo_urls) {
    if (
      typeof raw !== "string" ||
      !isSafeAgencyStagingUrl(raw.trim(), operator.agencyId, mediaBaseUrl)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "photo_urls yalnız bu agentliyin icazəli R2 staging URL-lərini daxil edə bilər.",
        },
        { status: 400 }
      );
    }
    sanitizedUrls.push(raw.trim());
  }

  const supabase = createAdminClient();
  const { data: existing, error: lookupErr } = await supabase
    .from("listings")
    .select("id, agency_id, source_type, assigned_agent_id")
    .eq("id", listingId)
    .eq("agency_id", operator.agencyId)
    .maybeSingle();

  if (lookupErr || !existing) {
    return NextResponse.json(
      { ok: false, error: "Elan tapılmadı və ya bu agentliyə aid deyil." },
      { status: 404 }
    );
  }

  if (existing.source_type !== "OFF_MARKET") {
    return NextResponse.json(
      { ok: false, error: "Yalnız OFF_MARKET elanların fotoları bu ünvanla təsdiqlənə bilər." },
      { status: 400 }
    );
  }

  if (
    operator.role === "BROKER" &&
    existing.assigned_agent_id &&
    existing.assigned_agent_id !== operator.operatorId
  ) {
    return NextResponse.json(
      { ok: false, error: "Bu elanı redaktə etmək üçün icazəniz yoxdur." },
      { status: 403 }
    );
  }

  const { data: updated, error: updateErr } = await supabase
    .from("listings")
    .update({ photo_urls: sanitizedUrls })
    .eq("id", listingId)
    .eq("agency_id", operator.agencyId)
    .select("id, photo_urls")
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { ok: false, error: updateErr?.message || "Fotolar saxlanıla bilmədi." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    listing_id: updated.id,
    photo_urls: updated.photo_urls,
  });
}
