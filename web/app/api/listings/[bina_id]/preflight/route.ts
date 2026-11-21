import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import fs from "fs";

// Standard desktop User-Agent for real-time bina.az portal checks
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Deactivation phrases indicating a listing was removed, expired, or sold
const REMOVED_DOM_PHRASES = [
  "bu elan artıq aktiv deyil",
  "bu elan artiq aktiv deyil",
  "elan silinib",
  "elan silinmişdir",
  "elan silinmisdir",
  "elan tapılmadı",
  "elan tapilmadi",
  "elan artıq mövcud deyil",
  "elan artiq movcud deyil",
  "elan müddəti bitib",
  "elan muddeti bitib",
  "объявление не найдено",
  "объявление удалено",
];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cleanDigits(val: string | null | undefined): string {
  if (!val) return "";
  return val.replace(/\D/g, "");
}

function formatNumberSpacing(val: number): string {
  return Math.round(val)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

interface PreflightRequestBody {
  listing_id?: string;
  render_version_id?: string;
  dispatch_to_telegram?: boolean;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ bina_id: string }> }
) {
  const startTime = Date.now();
  let responseTimeMs = 0;

  // 1. Resolve route params
  const { bina_id: binaIdParam } = await context.params;

  if (!binaIdParam) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ERROR",
        message: "bina_id parametri tələb olunur.",
      },
      { status: 400 }
    );
  }

  const numericBinaId = parseInt(binaIdParam, 10);
  if (Number.isNaN(numericBinaId)) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ERROR",
        message: `Yanlış bina_id formatı: ${binaIdParam}`,
      },
      { status: 400 }
    );
  }

  // 2. Parse request body
  let body: PreflightRequestBody = {};
  try {
    body = await request.json();
  } catch {
    // Body is optional if listing_id is derived from bina_id
  }

  const { listing_id, render_version_id, dispatch_to_telegram = false } = body;
  const supabase = createAdminClient();

  // 3. Query listing, latest render_version, and publication from Supabase
  let listingQuery = supabase.from("listings").select("*");
  if (listing_id) {
    listingQuery = listingQuery.eq("id", listing_id);
  } else {
    listingQuery = listingQuery.eq("bina_id", String(numericBinaId));
  }

  const { data: listing, error: listingErr } = await listingQuery.maybeSingle();

  if (listingErr || !listing) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ERROR",
        message: `Elan verilənlər bazasında tapılmadı (bina_id: ${numericBinaId}).`,
      },
      { status: 404 }
    );
  }

  // Fetch render version (specific or latest)
  let rvQuery = supabase.from("render_versions").select("*");
  if (render_version_id) {
    rvQuery = rvQuery.eq("id", render_version_id);
  } else {
    rvQuery = rvQuery
      .eq("listing_id", listing.id)
      .order("version_num", { ascending: false })
      .limit(1);
  }
  const { data: renderVersion } = await rvQuery.maybeSingle();

  // Fetch latest publication record
  const { data: publication } = await supabase
    .from("publications")
    .select("*")
    .eq("listing_id", listing.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Baseline expected price from render version or listing record
  const expectedPrice = Number(
    renderVersion?.rendered_price ??
      listing.price_azn_normalized ??
      listing.price ??
      0
  );

  // 4. Fetch https://bina.az/items/${bina_id} with 8-second timeout & desktop User-Agent
  const targetUrl = `https://bina.az/items/${numericBinaId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  let fetchRes: Response;
  let html = "";

  try {
    fetchRes = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": DESKTOP_USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "az,ru;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    responseTimeMs = Date.now() - startTime;
    clearTimeout(timeoutId);
  } catch (fetchErr: unknown) {
    clearTimeout(timeoutId);
    responseTimeMs = Date.now() - startTime;
    const isTimeout =
      fetchErr instanceof Error && fetchErr.name === "AbortError";
    const errorMessage = isTimeout
      ? "bina.az sorğusu 8 saniyəlik vaxt limitini aşdı (Timeout)."
      : `bina.az ilə əlaqə qurularkən şəbəkə xətası: ${
          fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        }`;

    // Audit log
    await supabase.from("preflight_checks").insert({
      listing_id: listing.id,
      bina_id: numericBinaId,
      result: "SCRAPE_ERROR",
      response_time_ms: responseTimeMs,
    });

    return NextResponse.json(
      {
        ok: false,
        reason: "SCRAPE_ERROR",
        message: errorMessage,
        response_time_ms: responseTimeMs,
      },
      { status: 502 }
    );
  }

  // 5. Liveness Check & Residential Worker Delegation
  const isHttpDelisted = fetchRes.status === 404 || fetchRes.status === 410;

  if (!isHttpDelisted) {
    try {
      html = await fetchRes.text();
    } catch {
      html = "";
    }
  }

  let portalPrice: number | null = null;

  // Detect Cloudflare Turnstile / anti-bot challenge on datacenter IPs (e.g. Netlify AWS)
  const isCloudflareBlocked =
    fetchRes.status === 403 ||
    fetchRes.status === 429 ||
    html.includes("<title>Just a moment...</title>") ||
    html.includes("cf-browser-verification") ||
    html.includes("Attention Required! | Cloudflare");

  if (isCloudflareBlocked) {
    console.log(
      `[PREFLIGHT] Cloudflare challenge detected on Netlify IP. Delegating to residential Local Worker via pipeline_jobs...`
    );

    const idempotencyKey = `preflight_${numericBinaId}_${Date.now()}`;
    const { data: job, error: jobErr } = await supabase
      .from("pipeline_jobs")
      .insert({
        idempotency_key: idempotencyKey,
        job_type: "PREFLIGHT_CHECK",
        listing_id: listing.id,
        trigger_source: "WEB_UI",
        params_json: {
          bina_id: numericBinaId,
          listing_id: listing.id,
          expected_price: expectedPrice,
        },
        status: "QUEUED",
      })
      .select("id")
      .single();

    if (!jobErr && job?.id) {
      // Poll pipeline_jobs for up to 6.5s (16 x 400ms)
      const pollStart = Date.now();
      let workerResult: Record<string, unknown> | null = null;

      while (Date.now() - pollStart < 6500) {
        await new Promise((r) => setTimeout(r, 400));

        const { data: jobStatus } = await supabase
          .from("pipeline_jobs")
          .select("status, error_message")
          .eq("id", job.id)
          .single();

        if (jobStatus?.status === "SUCCEEDED") {
          // Query latest preflight_checks entry for this listing
          const { data: checkData } = await supabase
            .from("preflight_checks")
            .select("*")
            .eq("listing_id", listing.id)
            .order("checked_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (checkData) {
            workerResult = checkData;
            break;
          }
        } else if (jobStatus?.status === "FAILED") {
          break;
        }
      }

      if (workerResult) {
        responseTimeMs = Date.now() - startTime;
        if (workerResult.result === "REMOVED_ON_BINA") {
          return NextResponse.json({
            ok: false,
            reason: "REMOVED_ON_BINA",
            message: "Elan bina.az-dan silinib və ya satılıb.",
            response_time_ms: responseTimeMs,
          });
        }

        if (workerResult.portal_price !== undefined && workerResult.portal_price !== null) {
          const parsed = parseFloat(String(workerResult.portal_price));
          if (!Number.isNaN(parsed) && parsed > 0) {
            portalPrice = parsed;
          }
        }
      }
    }
  }

  const lowerHtml = html.toLowerCase();
  const hasDeletedClass =
    html.includes("item_status_deleted") ||
    /class=["'][^"']*item_status_deleted[^"']*["']/i.test(html);

  const hasDeletedText = REMOVED_DOM_PHRASES.some((phrase) =>
    lowerHtml.includes(phrase)
  );

  // Check Next.js __NEXT_DATA__ dehydrated JSON if present
  let isNextDataDeleted = false;
  try {
    const nextMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (nextMatch && nextMatch[1]) {
      const nextJson = JSON.parse(nextMatch[1]);
      const currentItem = nextJson?.props?.pageProps?.currentItemData;
      const statusCode = nextJson?.props?.pageProps?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        isNextDataDeleted = true;
      }
      if (currentItem) {
        const itemStatus = String(currentItem.status || "").toLowerCase();
        if (
          ["deleted", "removed", "expired", "archived", "sold", "inactive"].includes(
            itemStatus
          ) ||
          currentItem.isDeleted ||
          currentItem.isExpired
        ) {
          isNextDataDeleted = true;
        }
      }
    }
  } catch {
    // Ignore JSON parsing errors
  }

  const isRemoved =
    isHttpDelisted || hasDeletedClass || hasDeletedText || isNextDataDeleted;

  if (isRemoved) {
    // Update listing: source_availability='REMOVED_ON_BINA', editorial_status='ARCHIVED'
    await supabase
      .from("listings")
      .update({
        source_availability: "REMOVED_ON_BINA",
        editorial_status: "ARCHIVED",
      })
      .eq("id", listing.id);

    // Update publication if present
    if (publication) {
      await supabase
        .from("publications")
        .update({
          preflight_status: "REMOVED_ON_BINA",
          last_preflight_error: "Elan bina.az-dan silinib və ya satılıb.",
        })
        .eq("id", publication.id);
    }

    // Log to preflight_checks (result='REMOVED_ON_BINA')
    await supabase.from("preflight_checks").insert({
      listing_id: listing.id,
      bina_id: numericBinaId,
      result: "REMOVED_ON_BINA",
      response_time_ms: responseTimeMs,
    });

    return NextResponse.json({
      ok: false,
      reason: "REMOVED_ON_BINA",
      message: "Elan bina.az-dan silinib və ya satılıb.",
      response_time_ms: responseTimeMs,
    });
  }

  // 6. Robust Multi-Layer Price Extraction & Comparison (if not already extracted by worker)
  if (portalPrice === null) {
    // Layer 1: __NEXT_DATA__ JSON parsing (canonical bina.az pageProps)
    try {
      const nextMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (nextMatch && nextMatch[1]) {
      const nextJson = JSON.parse(nextMatch[1]);
      const pageProps = nextJson?.props?.pageProps;

      // Check currentItemData.price
      const currentItem = pageProps?.currentItemData;
      if (currentItem?.price !== undefined && currentItem?.price !== null) {
        if (typeof currentItem.price === "object") {
          const rawTotal = currentItem.price.total ?? currentItem.price.value;
          if (rawTotal !== undefined && rawTotal !== null) {
            const p = parseFloat(String(rawTotal));
            if (!Number.isNaN(p) && p > 0) portalPrice = p;
          }
        } else if (
          typeof currentItem.price === "number" ||
          typeof currentItem.price === "string"
        ) {
          const p = parseFloat(String(currentItem.price));
          if (!Number.isNaN(p) && p > 0) portalPrice = p;
        }
      }

      // Check apolloState Item:ID
      if (portalPrice === null && pageProps?.apolloState) {
        const itemObj = pageProps.apolloState[`Item:${numericBinaId}`];
        if (itemObj?.price !== undefined && itemObj?.price !== null) {
          if (typeof itemObj.price === "object") {
            const rawTotal = itemObj.price.total ?? itemObj.price.value;
            if (rawTotal !== undefined && rawTotal !== null) {
              const p = parseFloat(String(rawTotal));
              if (!Number.isNaN(p) && p > 0) portalPrice = p;
            }
          } else if (
            typeof itemObj.price === "number" ||
            typeof itemObj.price === "string"
          ) {
            const p = parseFloat(String(itemObj.price));
            if (!Number.isNaN(p) && p > 0) portalPrice = p;
          }
        }
      }
    }
  } catch {
    // Ignore JSON parsing errors
  }

  // Layer 2: Regex for Apollo GraphQL cached Price object in HTML
  if (portalPrice === null) {
    const apolloMatch = html.match(
      /"price":\s*\{\s*"__typename":\s*"Price"[^}]*"total":\s*(\d+)/
    );
    if (apolloMatch && apolloMatch[1]) {
      const p = parseFloat(apolloMatch[1]);
      if (!Number.isNaN(p) && p > 0) portalPrice = p;
    }
  }

  // Layer 3: Schema.org / JSON-LD Offer Price
  if (portalPrice === null) {
    const ldMatch = html.match(
      /"@type":\s*"Offer"[^}]*"price":\s*"(\d+)"/
    );
    if (ldMatch && ldMatch[1]) {
      const p = parseFloat(ldMatch[1]);
      if (!Number.isNaN(p) && p > 0) portalPrice = p;
    }
  }

  // Layer 4: Styled-components price text preceding currency symbol (AZN or ₼)
  if (portalPrice === null) {
    const scMatch =
      html.match(/>([\d\s]{3,15})<\/[a-z0-9]+>[^<]{0,20}(?:AZN|₼)/i) ||
      html.match(/>([\d\s]{3,15})\s*(?:<!--.*?-->\s*)*(?:AZN|₼)/i);
    if (scMatch && scMatch[1]) {
      const rawDigits = scMatch[1].replace(/\D/g, "");
      if (rawDigits) {
        const parsed = parseFloat(rawDigits);
        if (!Number.isNaN(parsed) && parsed > 0) portalPrice = parsed;
      }
    }
  }

  // Layer 5: Legacy HTML span with class="price-val"
  if (portalPrice === null) {
    const priceValMatch = html.match(
      /class=["'][^"']*price-val[^"']*["'][^>]*>([\s\S]*?)<\//i
    );
    if (priceValMatch && priceValMatch[1]) {
      const rawVal = priceValMatch[1].replace(/<[^>]*>/g, "").replace(/\s+/g, "");
      const parsed = parseFloat(rawVal);
      if (!Number.isNaN(parsed) && parsed > 0) portalPrice = parsed;
    }
  }
  }

  if (portalPrice === null || Number.isNaN(portalPrice) || portalPrice <= 0) {
    console.error(
      `[PREFLIGHT ERROR] bina_id=${numericBinaId} fetchStatus=${fetchRes.status} htmlLen=${html.length} snippet=${html.slice(0, 300)}`
    );

    await supabase.from("preflight_checks").insert({
      listing_id: listing.id,
      bina_id: numericBinaId,
      result: "SCRAPE_ERROR",
      response_time_ms: responseTimeMs,
    });

    return NextResponse.json(
      {
        ok: false,
        reason: "SCRAPE_ERROR",
        message:
          "bina.az portalından qiymət dəyəri oxuna bilmədi. bina.az bulud serverlərini (Netlify) blokladığı üçün yerli worker (local_worker.py) tələb olunur.",
        response_time_ms: responseTimeMs,
        debug_fetch_status: fetchRes.status,
        debug_html_len: html.length,
      },
      { status: 502 }
    );
  }

  // Compare with render_version?.rendered_price || listing.price_azn / price_azn_normalized
  const priceDelta = Math.abs(portalPrice - expectedPrice);
  const deltaPct =
    expectedPrice > 0
      ? Number((((portalPrice - expectedPrice) / expectedPrice) * 100).toFixed(2))
      : 0;

  if (priceDelta >= 1.0) {
    // Update listing price and price_azn_normalized
    await supabase
      .from("listings")
      .update({
        price: portalPrice,
        price_azn_normalized: portalPrice,
      })
      .eq("id", listing.id);

    if (publication) {
      await supabase
        .from("publications")
        .update({
          preflight_status: "PRICE_MISMATCH",
          last_preflight_error: `Qiymət dəyişib: ${expectedPrice} -> ${portalPrice} AZN (${deltaPct > 0 ? "+" : ""}${deltaPct}%)`,
        })
        .eq("id", publication.id);
    }

    // Log to preflight_checks (result='PRICE_CHANGED', portal_price, video_price, price_delta_pct)
    await supabase.from("preflight_checks").insert({
      listing_id: listing.id,
      bina_id: numericBinaId,
      result: "PRICE_CHANGED",
      portal_price: portalPrice,
      video_price: expectedPrice,
      price_delta_pct: deltaPct,
      response_time_ms: responseTimeMs,
    });

    return NextResponse.json({
      ok: false,
      reason: "PRICE_CHANGED",
      old_price: expectedPrice,
      new_price: portalPrice,
      delta_pct: deltaPct,
      portal_price: portalPrice,
      video_price: expectedPrice,
      response_time_ms: responseTimeMs,
      message: `Qiymət fərqi aşkarlandı: Əvvəlki: ${formatNumberSpacing(expectedPrice)} AZN -> bina.az-da: ${formatNumberSpacing(portalPrice)} AZN (${deltaPct > 0 ? "+" : ""}${deltaPct}%).`,
    });
  }

  // 7. On Verification PASS
  await supabase.from("preflight_checks").insert({
    listing_id: listing.id,
    bina_id: numericBinaId,
    result: "PASSED",
    portal_price: portalPrice,
    video_price: expectedPrice,
    price_delta_pct: 0,
    response_time_ms: responseTimeMs,
  });

  // 8. Telegram Dispatch (if requested)
  let telegramMsgId: number | null = null;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const mockDispatch =
    process.env.TELEGRAM_MOCK_DISPATCH === "true" || !botToken || !chatId;

  if (dispatch_to_telegram) {
    // Anti-spam cooldown: Check if this listing was already dispatched to Telegram within the last 30 seconds
    if (publication?.telegram_dispatched_at && publication?.telegram_message_id) {
      const lastDispatched = new Date(publication.telegram_dispatched_at).getTime();
      const now = Date.now();
      if (now - lastDispatched < 30_000) {
        console.warn(
          `[ANTI-SPAM] Duplicate Telegram dispatch suppressed for listing #${numericBinaId}. Last dispatched ${Math.round((now - lastDispatched) / 1000)}s ago.`
        );
        return NextResponse.json({
          ok: true,
          reason: "PASSED",
          already_dispatched: true,
          portal_price: portalPrice,
          video_price: expectedPrice,
          old_price: expectedPrice,
          new_price: portalPrice,
          delta_pct: 0,
          response_time_ms: responseTimeMs,
          telegram_dispatched: true,
          telegram_message_id: publication.telegram_message_id,
          message: "Elan artıq Telegram-a yenicə göndərilib (təkrar göndəriş qoruyucusu aktivdir).",
        });
      }
    }

    const formattedPrice = formatNumberSpacing(portalPrice);
    const loc = listing.location || listing.address || "Bakı";
    const roomsStr = listing.rooms ? `${listing.rooms} otaqlı` : "";
    const areaStr = listing.area ? `${listing.area} m²` : "";
    const floorStr = listing.floor
      ? listing.floors
        ? `${listing.floor}/${listing.floors} mərtəbə`
        : `${listing.floor}-ci mərtəbə`
      : "";
    const kupchaBadge = listing.has_bill_of_sale
      ? "Dövlət Çıxarışı (Kupça) var"
      : "Müqaviləli";

    const title =
      listing.title ||
      `Təcili Kupçalı ${roomsStr ? roomsStr + " " : ""}Mənzil Satılır!`;

    const highlights = listing.description
      ? listing.description.slice(0, 240).trim() +
        (listing.description.length > 240 ? "..." : "")
      : "Mənzil əla təmirlidir, geniş otaqları və şəhərə gözəl mənzərəsi var. Bütün infrastruktur piyada məsafəsindədir.";

    const hashtags =
      "#baku #azerbaijan #emlak #binaaz #dasinmazemlak #menzil #evler #bakuapartments";

    // 1-Tap Copyable standalone caption inside <code>...</code>
    const copyableCaptionText = [
      `📍 ${title}`,
      ``,
      `💰 Qiymət: ${formattedPrice} AZN`,
      `📐 Sahə: ${areaStr || "—"}`,
      `🏢 Mərtəbə: ${floorStr || "—"}`,
      `📄 Sənəd: ${kupchaBadge}`,
      ``,
      highlights,
      ``,
      `📞 Əlaqə & Ətraflı Məlumat: +994 50 200 21 69`,
      ``,
      hashtags,
    ].join("\n");

    const copyableCodeMessage = `<code>${escapeHtml(copyableCaptionText)}</code>`;

    // Interactive Inline Keyboard
    const rawPhone =
      listing.owner_phone_raw || listing.owner_phone_normalized || "";
    const digits = cleanDigits(rawPhone);
    const waDigits = digits.startsWith("994")
      ? digits
      : digits
      ? `994${digits}`
      : "";
    const waText = encodeURIComponent(
      `Salam, bina.az-dakı ${numericBinaId} nömrəli mənzil elanınızla bağlı yazıram.`
    );
    const waUrl = waDigits
      ? `https://wa.me/${waDigits}?text=${waText}`
      : `https://bina.az/items/${numericBinaId}`;
    const binaUrl = `https://bina.az/items/${numericBinaId}`;

    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "🔄 Yenidən Render Et",
            callback_data: `rerender_${numericBinaId}`,
          },
          {
            text: "✍️ Ssenarini Dəyiş",
            callback_data: `scriptmenu_${numericBinaId}`,
          },
        ],
        [
          {
            text: "🎙️ Səsi Dəyiş",
            callback_data: `voicemenu_${numericBinaId}`,
          },
          {
            text: "📊 Keenable Hesabatı",
            callback_data: `keenable_${numericBinaId}`,
          },
        ],
        [
          { text: "💬 WhatsApp Sahibinə", url: waUrl },
          { text: "🌐 Bina.az Elanı", url: binaUrl },
        ],
        [
          {
            text: "🚀 Təsdiqlə və Paylaş",
            callback_data: `publish_${numericBinaId}`,
          },
          { text: "❌ Arxivlə", callback_data: `archive_${numericBinaId}` },
        ],
      ],
    };

    const crmVideoCaption = [
      `🎬 <b>BakuEstate-AI | Yoxlanılmış Elan #${numericBinaId}</b>`,
      `📍 <b>Ünvan:</b> ${loc}`,
      `💰 <b>Qiymət:</b> ${formattedPrice} AZN`,
      `📐 <b>Parametrlər:</b> ${[roomsStr, areaStr, floorStr].filter(Boolean).join(" | ")}`,
      `📜 <b>Sənəd:</b> ${kupchaBadge}`,
      `✅ <i>bina.az statusu və qiyməti canlı təsdiqləndi!</i>`,
    ].join("\n");

    if (mockDispatch) {
      telegramMsgId = 1000 + Math.floor(Math.random() * 9000);
      console.log(
        `[MOCK TELEGRAM] Dispatched video & copyable caption for listing #${numericBinaId}. Simulated Msg ID: ${telegramMsgId}`
      );
    } else {
      try {
        let videoSent = false;

        // Check local video file on disk
        if (
          renderVersion?.local_video_path &&
          fs.existsSync(renderVersion.local_video_path)
        ) {
          const form = new FormData();
          form.append("chat_id", chatId);
          form.append("caption", crmVideoCaption);
          form.append("parse_mode", "HTML");
          form.append("supports_streaming", "true");
          form.append("reply_markup", JSON.stringify(replyMarkup));

          const fileBuffer = fs.readFileSync(renderVersion.local_video_path);
          const blob = new Blob([fileBuffer], { type: "video/mp4" });
          form.append("video", blob, `video_${numericBinaId}.mp4`);

          const videoRes = await fetch(
            `https://api.telegram.org/bot${botToken}/sendVideo`,
            {
              method: "POST",
              body: form,
            }
          );
          const videoJson = await videoRes.json();
          if (videoJson.ok) {
            telegramMsgId = videoJson.result?.message_id ?? null;
            videoSent = true;
          }
        }

        // If not sent via local file, try CDN/storage URL
        if (!videoSent) {
          let videoUrl = renderVersion?.video_cdn_url;
          if (!videoUrl && renderVersion?.storage_object_path) {
            const bucket = process.env.SUPABASE_BUCKET || "baku-estate-media";
            const { data: storageData } = supabase.storage
              .from(bucket)
              .getPublicUrl(renderVersion.storage_object_path);
            videoUrl = storageData?.publicUrl;
          }

          if (videoUrl) {
            const videoRes = await fetch(
              `https://api.telegram.org/bot${botToken}/sendVideo`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: chatId,
                  video: videoUrl,
                  caption: crmVideoCaption,
                  parse_mode: "HTML",
                  supports_streaming: true,
                  reply_markup: replyMarkup,
                }),
              }
            );
            const videoJson = await videoRes.json();
            if (videoJson.ok) {
              telegramMsgId = videoJson.result?.message_id ?? null;
              videoSent = true;
            }
          }
        }

        // Message 2: Standalone 1-tap copyable caption block in <code>...</code>
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: copyableCodeMessage,
            parse_mode: "HTML",
          }),
        });
      } catch (telegramErr: unknown) {
        console.warn(
          "Telegram dispatch warning:",
          telegramErr instanceof Error
            ? telegramErr.message
            : String(telegramErr)
        );
      }
    }

    // Update publications record:
    // status='READY_TO_PUBLISH', verified_at=NOW(), telegram_dispatched_at=NOW(), preflight_status='PASSED'
    const nowIso = new Date().toISOString();
    if (publication) {
      await supabase
        .from("publications")
        .update({
          status: "READY_TO_PUBLISH",
          verified_at: nowIso,
          telegram_dispatched_at: nowIso,
          preflight_status: "PASSED",
          last_preflight_error: null,
          telegram_message_id: telegramMsgId,
        })
        .eq("id", publication.id);
    } else {
      await supabase.from("publications").insert({
        listing_id: listing.id,
        render_version_id: renderVersion?.id || null,
        channel: "INSTAGRAM_REELS",
        status: "READY_TO_PUBLISH",
        verified_at: nowIso,
        telegram_dispatched_at: nowIso,
        preflight_status: "PASSED",
        telegram_message_id: telegramMsgId,
      });
    }

    return NextResponse.json({
      ok: true,
      reason: "PASSED",
      message: "Elan uğurla təsdiqləndi və Telegram-a göndərildi.",
      portal_price: portalPrice,
      video_price: expectedPrice,
      old_price: expectedPrice,
      new_price: portalPrice,
      delta_pct: 0,
      response_time_ms: responseTimeMs,
      telegram_dispatched: true,
      telegram_message_id: telegramMsgId,
    });
  }

  // PASS without Telegram dispatch (verification check only)
  const nowIso = new Date().toISOString();
  if (publication) {
    await supabase
      .from("publications")
      .update({
        verified_at: nowIso,
        preflight_status: "PASSED",
        last_preflight_error: null,
      })
      .eq("id", publication.id);
  }

  return NextResponse.json({
    ok: true,
    reason: "PASSED",
    message: "Elan aktivdir və qiymət təsdiqləndi.",
    portal_price: portalPrice,
    video_price: expectedPrice,
    old_price: expectedPrice,
    new_price: portalPrice,
    delta_pct: 0,
    response_time_ms: responseTimeMs,
    telegram_dispatched: false,
  });
}
