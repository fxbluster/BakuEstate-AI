import { NextResponse } from "next/server";
import { ProxyAgent } from "undici";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import { resolvePlayableRenderUrl } from "@/lib/r2-media";
import { getBinaProxyUrl } from "@/lib/supabase/env";

export const runtime = "nodejs";

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NUMERIC_ID_REGEX = /^\d+$/;

const PROXY_CIRCUIT_FAILURE_THRESHOLD = 5;
const PROXY_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

let consecutiveProxyFailures = 0;
let proxyCircuitOpenedAt: number | null = null;

function isProxyCircuitOpen(): boolean {
  if (proxyCircuitOpenedAt === null) {
    return false;
  }
  if (Date.now() - proxyCircuitOpenedAt >= PROXY_CIRCUIT_COOLDOWN_MS) {
    // Half-open: allow one probe attempt
    proxyCircuitOpenedAt = null;
    consecutiveProxyFailures = PROXY_CIRCUIT_FAILURE_THRESHOLD - 1;
    return false;
  }
  return true;
}

function recordProxyFailure(): boolean {
  consecutiveProxyFailures += 1;
  if (consecutiveProxyFailures >= PROXY_CIRCUIT_FAILURE_THRESHOLD) {
    proxyCircuitOpenedAt = Date.now();
    return true;
  }
  return false;
}

function recordProxySuccess(): void {
  consecutiveProxyFailures = 0;
  proxyCircuitOpenedAt = null;
}

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
  bypass_live_check?: boolean;
  manual_override?: boolean;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ bina_id: string }> }
) {
  const startTime = Date.now();
  let responseTimeMs = 0;

  // 1. Require authenticated & active agency member
  const auth = await requireOperator(request);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  // 2. Resolve route params (UUID for OFF_MARKET/any listing or numeric bina_id)
  const { bina_id: binaIdParam } = await context.params;
  if (!binaIdParam) {
    return NextResponse.json(
      { ok: false, reason: "ERROR", message: "bina_id parametri tələb olunur." },
      { status: 400 }
    );
  }

  const paramIsUuid = UUID_REGEX.test(binaIdParam);
  const paramIsNumeric = NUMERIC_ID_REGEX.test(binaIdParam);
  const numericBinaId = paramIsNumeric ? parseInt(binaIdParam, 10) : null;
  if (!paramIsUuid && numericBinaId === null) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ERROR",
        message: `Yanlış bina_id formatı: ${binaIdParam}`,
      },
      { status: 400 }
    );
  }

  // 3. Parse request body
  let body: PreflightRequestBody = {};
  try {
    body = await request.json();
  } catch {
    // Body optional
  }

  const {
    listing_id,
    render_version_id,
    dispatch_to_telegram = false,
    bypass_live_check = false,
    manual_override = false,
  } = body;
  const effectiveBypassLiveCheck = Boolean(bypass_live_check || manual_override);

  const supabase = createAdminClient();
  const isListingUuid = Boolean(listing_id && UUID_REGEX.test(listing_id));

  let listingQuery = supabase
    .from("listings")
    .select("*")
    .eq("agency_id", operator.agencyId);

  if (isListingUuid) {
    listingQuery = listingQuery.eq("id", listing_id!);
  } else if (paramIsUuid) {
    listingQuery = listingQuery.eq("id", binaIdParam);
  } else {
    listingQuery = listingQuery.eq("bina_id", String(numericBinaId));
  }

  const { data: listing, error: listingErr } = await listingQuery.maybeSingle();

  if (listingErr || !listing) {
    return NextResponse.json(
      {
        ok: false,
        reason: "ERROR",
        message: `Elan verilənlər bazasında tapılmadı (${binaIdParam}).`,
      },
      { status: 404 }
    );
  }

  const effectiveBinaId = listing.bina_id ? String(listing.bina_id) : null;
  const parsedBinaInt =
    effectiveBinaId && !Number.isNaN(parseInt(effectiveBinaId, 10))
      ? parseInt(effectiveBinaId, 10)
      : null;

  // Fetch agency settings (contact phone + telegram chat)
  const { data: agencySettings } = await supabase
    .from("agency_settings")
    .select("public_phone, telegram_chat_id")
    .eq("agency_id", operator.agencyId)
    .maybeSingle();

  // Fetch owner contact separately (blocked for SMM)
  let ownerPhoneRaw = "";
  if (operator.role !== "SMM") {
    const { data: ownerContact } = await supabase
      .from("listing_owner_contacts")
      .select("owner_phone_raw, owner_phone_normalized")
      .eq("listing_id", listing.id)
      .eq("agency_id", operator.agencyId)
      .maybeSingle();
    ownerPhoneRaw =
      ownerContact?.owner_phone_raw ||
      ownerContact?.owner_phone_normalized ||
      listing.owner_phone_raw ||
      listing.owner_phone_normalized ||
      "";
  }

  // Fetch render version (specific or latest)
  let rvQuery = supabase
    .from("render_versions")
    .select("*")
    .eq("agency_id", operator.agencyId);
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
  const { data: existingPublication } = await supabase
    .from("publications")
    .select("*")
    .eq("listing_id", listing.id)
    .eq("agency_id", operator.agencyId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const expectedPrice = Number(
    renderVersion?.rendered_price ??
      listing.price_azn_normalized ??
      listing.price ??
      0
  );

  let portalPrice: number | null = null;
  const isOffMarket = listing.source_type === "OFF_MARKET";

  if (isOffMarket || effectiveBypassLiveCheck || !effectiveBinaId) {
    if (!expectedPrice || expectedPrice <= 0) {
      return NextResponse.json(
        {
          ok: false,
          reason: "ERROR",
          message: "Bazadakı elan üçün etibarlı qiymət tapılmadı.",
        },
        { status: 400 }
      );
    }
    portalPrice = expectedPrice;
    responseTimeMs = Date.now() - startTime;
  } else {
    if (isProxyCircuitOpen()) {
      responseTimeMs = Date.now() - startTime;
      await supabase.from("preflight_checks").insert({
        listing_id: listing.id,
        agency_id: operator.agencyId,
        bina_id: parsedBinaInt,
        result: "SCRAPE_ERROR",
        response_time_ms: responseTimeMs,
      });

      return NextResponse.json(
        {
          ok: false,
          reason: "PROXY_CIRCUIT_OPEN",
          manual_override_allowed: true,
          can_fallback_to_db: true,
          db_price: expectedPrice,
          response_time_ms: responseTimeMs,
          message:
            "bina.az proxy dövrə açarı (circuit breaker) 5 ardıcıl xətadan sonra müvəqqəti açılıb. Manual təsdiq (MANUAL_OVERRIDE) ilə davam edə bilərsiniz.",
        },
        { status: 503 }
      );
    }

    const targetUrl = `https://bina.az/items/${effectiveBinaId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const proxyUrl = getBinaProxyUrl();
    const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

    let fetchRes: Response;
    let html = "";

    try {
      const fetchInit: RequestInit & { dispatcher?: unknown } = {
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
      };
      if (proxyAgent) {
        fetchInit.dispatcher = proxyAgent;
      }

      fetchRes = await fetch(targetUrl, fetchInit);
      responseTimeMs = Date.now() - startTime;
      clearTimeout(timeoutId);
    } catch (fetchErr: unknown) {
      clearTimeout(timeoutId);
      responseTimeMs = Date.now() - startTime;
      const circuitTripped = recordProxyFailure();
      const isTimeout =
        fetchErr instanceof Error && fetchErr.name === "AbortError";
      const errorMessage = isTimeout
        ? "bina.az sorğusu 8 saniyəlik vaxt limitini aşdı (Timeout)."
        : `bina.az ilə əlaqə qurularkən şəbəkə xətası: ${
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
          }`;

      await supabase.from("preflight_checks").insert({
        listing_id: listing.id,
        agency_id: operator.agencyId,
        bina_id: parsedBinaInt,
        result: "SCRAPE_ERROR",
        response_time_ms: responseTimeMs,
      });

      if (circuitTripped) {
        return NextResponse.json(
          {
            ok: false,
            reason: "PROXY_CIRCUIT_OPEN",
            manual_override_allowed: true,
            can_fallback_to_db: true,
            db_price: expectedPrice,
            response_time_ms: responseTimeMs,
            message:
              "bina.az proxy dövrə açarı (circuit breaker) 5 ardıcıl xətadan sonra açıldı. Manual təsdiq (MANUAL_OVERRIDE) ilə davam edə bilərsiniz.",
          },
          { status: 503 }
        );
      }

      return NextResponse.json(
        {
          ok: false,
          reason: "SCRAPE_ERROR",
          message: errorMessage,
          can_fallback_to_db: true,
          db_price: expectedPrice,
          response_time_ms: responseTimeMs,
        },
        { status: 502 }
      );
    } finally {
      if (proxyAgent && typeof proxyAgent.close === "function") {
        void proxyAgent.close().catch(() => undefined);
      }
    }

    const isHttpDelisted = fetchRes.status === 404 || fetchRes.status === 410;
    if (!isHttpDelisted) {
      try {
        html = await fetchRes.text();
      } catch {
        html = "";
      }
    }

    const isCloudflareBlocked =
      fetchRes.status === 403 ||
      fetchRes.status === 429 ||
      html.includes("<title>Just a moment...</title>") ||
      html.includes("cf-browser-verification") ||
      html.includes("Attention Required! | Cloudflare");

    if (isCloudflareBlocked) {
      const circuitTripped = recordProxyFailure();
      if (circuitTripped) {
        await supabase.from("preflight_checks").insert({
          listing_id: listing.id,
          agency_id: operator.agencyId,
          bina_id: parsedBinaInt,
          result: "SCRAPE_ERROR",
          response_time_ms: responseTimeMs,
        });

        return NextResponse.json(
          {
            ok: false,
            reason: "PROXY_CIRCUIT_OPEN",
            manual_override_allowed: true,
            can_fallback_to_db: true,
            db_price: expectedPrice,
            response_time_ms: responseTimeMs,
            message:
              "bina.az Cloudflare bloklaması ardıcıl 5 dəfə təkrarlandı. Proxy dövrə açarı açıldı; manual təsdiq (MANUAL_OVERRIDE) mümkündür.",
          },
          { status: 503 }
        );
      }
    } else {
      recordProxySuccess();
    }

    if (isCloudflareBlocked) {
      const idempotencyKey = `preflight_${effectiveBinaId}_${Date.now()}`;
      const { data: job, error: jobErr } = await supabase
        .from("pipeline_jobs")
        .insert({
          agency_id: operator.agencyId,
          created_by: operator.operatorId,
          idempotency_key: idempotencyKey,
          job_type: "PREFLIGHT_CHECK",
          listing_id: listing.id,
          trigger_source: "WEB_UI",
          params_json: {
            bina_id: parsedBinaInt ?? effectiveBinaId,
            listing_id: listing.id,
            expected_price: expectedPrice,
          },
          status: "QUEUED",
        })
        .select("id")
        .single();

      if (!jobErr && job?.id) {
        const pollStart = Date.now();
        let workerResult: Record<string, unknown> | null = null;

        while (Date.now() - pollStart < 6500) {
          await new Promise((r) => setTimeout(r, 400));

          const { data: jobStatus } = await supabase
            .from("pipeline_jobs")
            .select("status")
            .eq("id", job.id)
            .single();

          if (jobStatus?.status === "SUCCEEDED") {
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

          if (
            workerResult.portal_price !== undefined &&
            workerResult.portal_price !== null
          ) {
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

    let isNextDataDeleted = false;
    try {
      const nextMatch = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
      );
      if (nextMatch?.[1]) {
        const nextJson = JSON.parse(nextMatch[1]);
        const currentItem = nextJson?.props?.pageProps?.currentItemData;
        const statusCode = nextJson?.props?.pageProps?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          isNextDataDeleted = true;
        }
        if (currentItem) {
          const itemStatus = String(currentItem.status || "").toLowerCase();
          if (
            [
              "deleted",
              "removed",
              "expired",
              "archived",
              "sold",
              "inactive",
            ].includes(itemStatus) ||
            currentItem.isDeleted ||
            currentItem.isExpired
          ) {
            isNextDataDeleted = true;
          }
        }
      }
    } catch {
      // Ignore parse errors
    }

    if (
      isHttpDelisted ||
      hasDeletedClass ||
      hasDeletedText ||
      isNextDataDeleted
    ) {
      await supabase
        .from("listings")
        .update({
          source_availability: "REMOVED_ON_BINA",
          editorial_status: "ARCHIVED",
        })
        .eq("id", listing.id)
        .eq("agency_id", operator.agencyId);

      if (existingPublication) {
        await supabase
          .from("publications")
          .update({
            preflight_status: "REMOVED_ON_BINA",
            last_preflight_error: "Elan bina.az-dan silinib və ya satılıb.",
          })
          .eq("id", existingPublication.id);
      }

      await supabase.from("preflight_checks").insert({
        listing_id: listing.id,
        agency_id: operator.agencyId,
        bina_id: parsedBinaInt,
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

    if (portalPrice === null) {
      try {
        const nextMatch = html.match(
          /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
        );
        if (nextMatch?.[1]) {
          const nextJson = JSON.parse(nextMatch[1]);
          const pageProps = nextJson?.props?.pageProps;
          const currentItem = pageProps?.currentItemData;
          if (currentItem?.price !== undefined && currentItem?.price !== null) {
            const rawTotal =
              typeof currentItem.price === "object"
                ? currentItem.price.total ?? currentItem.price.value
                : currentItem.price;
            const p = parseFloat(String(rawTotal));
            if (!Number.isNaN(p) && p > 0) portalPrice = p;
          }

          if (portalPrice === null && pageProps?.apolloState && effectiveBinaId) {
            const itemObj = pageProps.apolloState[`Item:${effectiveBinaId}`];
            if (itemObj?.price !== undefined && itemObj?.price !== null) {
              const rawTotal =
                typeof itemObj.price === "object"
                  ? itemObj.price.total ?? itemObj.price.value
                  : itemObj.price;
              const p = parseFloat(String(rawTotal));
              if (!Number.isNaN(p) && p > 0) portalPrice = p;
            }
          }
        }
      } catch {
        // Ignore parse errors
      }

      if (portalPrice === null) {
        const apolloMatch = html.match(
          /"price":\s*\{\s*"__typename":\s*"Price"[^}]*"total":\s*(\d+)/
        );
        if (apolloMatch?.[1]) {
          const p = parseFloat(apolloMatch[1]);
          if (!Number.isNaN(p) && p > 0) portalPrice = p;
        }
      }

      if (portalPrice === null) {
        const ldMatch = html.match(/"@type":\s*"Offer"[^}]*"price":\s*"(\d+)"/);
        if (ldMatch?.[1]) {
          const p = parseFloat(ldMatch[1]);
          if (!Number.isNaN(p) && p > 0) portalPrice = p;
        }
      }

      if (portalPrice === null) {
        const scMatch =
          html.match(/>([\d\s]{3,15})<\/[a-z0-9]+>[^<]{0,20}(?:AZN|₼)/i) ||
          html.match(/>([\d\s]{3,15})\s*(?:<!--.*?-->\s*)*(?:AZN|₼)/i);
        if (scMatch?.[1]) {
          const rawDigits = scMatch[1].replace(/\D/g, "");
          if (rawDigits) {
            const parsed = parseFloat(rawDigits);
            if (!Number.isNaN(parsed) && parsed > 0) portalPrice = parsed;
          }
        }
      }

      if (portalPrice === null) {
        const priceValMatch = html.match(
          /class=["'][^"']*price-val[^"']*["'][^>]*>([\s\S]*?)<\//i
        );
        if (priceValMatch?.[1]) {
          const rawVal = priceValMatch[1]
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, "");
          const parsed = parseFloat(rawVal);
          if (!Number.isNaN(parsed) && parsed > 0) portalPrice = parsed;
        }
      }
    }

    if (portalPrice === null || Number.isNaN(portalPrice) || portalPrice <= 0) {
      await supabase.from("preflight_checks").insert({
        listing_id: listing.id,
        agency_id: operator.agencyId,
        bina_id: parsedBinaInt,
        result: "SCRAPE_ERROR",
        response_time_ms: responseTimeMs,
      });

      return NextResponse.json(
        {
          ok: false,
          reason: "SCRAPE_ERROR",
          message:
            "bina.az portalından canlı qiymət oxuna bilmədi. Bazadakı təsdiqlənmiş qiymətlə göndərə və ya worker-i işə sala bilərsiniz.",
          can_fallback_to_db: true,
          db_price: expectedPrice,
          response_time_ms: responseTimeMs,
          debug_fetch_status: fetchRes.status,
          debug_html_len: html.length,
        },
        { status: 502 }
      );
    }
  }

  // Price comparison
  const priceDelta = Math.abs(portalPrice - expectedPrice);
  const deltaPct =
    expectedPrice > 0
      ? Number((((portalPrice - expectedPrice) / expectedPrice) * 100).toFixed(2))
      : 0;

  if (priceDelta >= 1.0) {
    await supabase
      .from("listings")
      .update({
        price: portalPrice,
        price_azn_normalized: portalPrice,
      })
      .eq("id", listing.id)
      .eq("agency_id", operator.agencyId);

    if (existingPublication) {
      await supabase
        .from("publications")
        .update({
          preflight_status: "PRICE_MISMATCH",
          last_preflight_error: `Qiymət dəyişib: ${expectedPrice} -> ${portalPrice} AZN (${
            deltaPct > 0 ? "+" : ""
          }${deltaPct}%)`,
        })
        .eq("id", existingPublication.id);
    }

    await supabase.from("preflight_checks").insert({
      listing_id: listing.id,
      agency_id: operator.agencyId,
      bina_id: parsedBinaInt,
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
      message: `Qiymət fərqi aşkarlandı: Əvvəlki: ${formatNumberSpacing(
        expectedPrice
      )} AZN -> Cari: ${formatNumberSpacing(portalPrice)} AZN (${
        deltaPct > 0 ? "+" : ""
      }${deltaPct}%).`,
    });
  }

  // 7. Verification PASS
  await supabase.from("preflight_checks").insert({
    listing_id: listing.id,
    agency_id: operator.agencyId,
    bina_id: parsedBinaInt,
    result:
      isOffMarket || effectiveBypassLiveCheck
        ? "PASSED_WITH_DB_FALLBACK"
        : "PASSED",
    portal_price: portalPrice,
    video_price: expectedPrice,
    price_delta_pct: 0,
    response_time_ms: responseTimeMs,
  });

  // 8. Two-phase leased Telegram dispatch
  if (dispatch_to_telegram) {
    if (
      renderVersion?.storage_pruned_at !== null &&
      renderVersion?.storage_pruned_at !== undefined
    ) {
      return NextResponse.json(
        {
          ok: false,
          reason: "ERROR",
          telegram_dispatched: false,
          message: "Video faylı saxlancdan silinib (storage_pruned_at).",
        },
        { status: 410 }
      );
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = agencySettings?.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
    if (
      !botToken ||
      botToken.startsWith("mock") ||
      botToken === "test" ||
      !chatId
    ) {
      return NextResponse.json(
        {
          ok: false,
          reason: "ERROR",
          telegram_dispatched: false,
          message:
            "Telegram bot konfiqurasiyası (TELEGRAM_BOT_TOKEN / telegram_chat_id) təyin edilməyib.",
        },
        { status: 503 }
      );
    }

    const rawVideoUrl = renderVersion?.video_cdn_url as string | undefined;
    if (!rawVideoUrl) {
      return NextResponse.json(
        {
          ok: false,
          reason: "ERROR",
          telegram_dispatched: false,
          message: "Paylaşım üçün hazır video URL (video_cdn_url) tapılmadı.",
        },
        { status: 404 }
      );
    }

    const videoUrl =
      (await resolvePlayableRenderUrl(renderVersion, { expiresInSeconds: 3600 })) ||
      rawVideoUrl;

    // Ensure publication row exists for atomic slot leasing
    let pubId = existingPublication?.id as string | undefined;
    if (!pubId) {
      const { data: createdPub, error: pubInsertErr } = await supabase
        .from("publications")
        .insert({
          agency_id: operator.agencyId,
          listing_id: listing.id,
          render_version_id: renderVersion?.id || null,
          channel: "INSTAGRAM_REELS",
          status: "DRAFT_READY",
          preflight_status: "PASSED",
          assigned_agent_id: operator.operatorId,
          created_by: operator.operatorId,
        })
        .select("id")
        .single();

      if (pubInsertErr || !createdPub?.id) {
        return NextResponse.json(
          {
            ok: false,
            reason: "ERROR",
            telegram_dispatched: false,
            message: "Nəşr qeydi yaradıla bilmədi.",
          },
          { status: 500 }
        );
      }
      pubId = createdPub.id;
    }

    // Phase 1: Acquire 60s atomic Telegram dispatch lease
    const { data: claimRaw, error: claimErr } = await supabase.rpc(
      "claim_telegram_dispatch_slot",
      {
        p_publication_id: pubId,
        p_cooldown_seconds: 300,
      }
    );
    const slot = Array.isArray(claimRaw) ? claimRaw[0] : claimRaw;

    if (claimErr || !slot?.acquired || !slot?.lock_token) {
      return NextResponse.json(
        {
          ok: false,
          reason: "ERROR",
          already_dispatched: true,
          telegram_dispatched: false,
          portal_price: portalPrice,
          video_price: expectedPrice,
          message:
            "Elan artıq Telegram-a göndərilir və ya cooldown qoruyucusu aktivdir.",
        },
        { status: 409 }
      );
    }

    const lockToken = String(slot.lock_token);
    const displayRef = effectiveBinaId || listing.id.slice(0, 8);
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
      : "Sənəd dəqiqləşdirilir / Müqavilə";

    const title =
      listing.title ||
      `${listing.has_bill_of_sale ? "Kupçalı " : ""}${
        roomsStr ? roomsStr + " " : ""
      }Mənzil Satılır!`;

    const highlights = listing.description
      ? listing.description.slice(0, 240).trim() +
        (listing.description.length > 240 ? "..." : "")
      : "Mənzil əla təmirlidir, geniş otaqları var. Bütün infrastruktur piyada məsafəsindədir.";

    const agencyPhone = agencySettings?.public_phone || "";
    const hashtags =
      "#baku #azerbaijan #emlak #binaaz #dasinmazemlak #menzil #evler #bakuapartments";

    const copyableCaptionText = [
      `📍 ${title}`,
      ``,
      `💰 Qiymət: ${formattedPrice} AZN`,
      `📐 Sahə: ${areaStr || "—"}`,
      `🏢 Mərtəbə: ${floorStr || "—"}`,
      `📄 Sənəd: ${kupchaBadge}`,
      ``,
      highlights,
      ...(agencyPhone ? [``, `📞 Əlaqə & Ətraflı Məlumat: ${agencyPhone}`] : []),
      ``,
      hashtags,
    ].join("\n");

    const copyableCodeMessage = `<code>${escapeHtml(copyableCaptionText)}</code>`;

    const digits = cleanDigits(ownerPhoneRaw);
    const waDigits = digits.startsWith("994")
      ? digits
      : digits
      ? `994${digits}`
      : "";
    const waText = encodeURIComponent(
      `Salam, #${displayRef} nömrəli mənzil elanınızla bağlı yazıram.`
    );
    const binaUrl = effectiveBinaId
      ? `https://bina.az/items/${effectiveBinaId}`
      : undefined;
    const waUrl = waDigits ? `https://wa.me/${waDigits}?text=${waText}` : binaUrl;

    const actionRow: Array<Record<string, string>> = [];
    if (waUrl) {
      actionRow.push({ text: "💬 WhatsApp Sahibinə", url: waUrl });
    }
    if (binaUrl) {
      actionRow.push({ text: "🌐 Bina.az Elanı", url: binaUrl });
    }

    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "🔄 Yenidən Render Et",
            callback_data: `rerender_${displayRef}`,
          },
          {
            text: "✍️ Ssenarini Dəyiş",
            callback_data: `scriptmenu_${displayRef}`,
          },
        ],
        [
          {
            text: "🎙️ Səsi Dəyiş",
            callback_data: `voicemenu_${displayRef}`,
          },
          {
            text: "📊 Keenable Hesabatı",
            callback_data: `keenable_${displayRef}`,
          },
        ],
        ...(actionRow.length > 0 ? [actionRow] : []),
        [
          {
            text: "🚀 Təsdiqlə və Paylaş",
            callback_data: `publish_${displayRef}`,
          },
          { text: "❌ Arxivlə", callback_data: `archive_${displayRef}` },
        ],
      ],
    };

    const crmVideoCaption = [
      `🎬 <b>BakuEstate-AI | Yoxlanılmış Elan #${displayRef}</b>`,
      `📍 <b>Ünvan:</b> ${escapeHtml(String(loc))}`,
      `💰 <b>Qiymət:</b> ${formattedPrice} AZN`,
      `📐 <b>Parametrlər:</b> ${[roomsStr, areaStr, floorStr]
        .filter(Boolean)
        .join(" | ")}`,
      `📜 <b>Sənəd:</b> ${kupchaBadge}`,
      isOffMarket
        ? `✅ <i>Eksklüziv oflayn elan (broker təsdiqli).</i>`
        : `✅ <i>bina.az statusu və qiyməti canlı təsdiqləndi!</i>`,
    ].join("\n");

    let telegramMsgId: number | null = null;

    try {
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

      const videoJson = (await videoRes.json()) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
      };

      if (!videoRes.ok || !videoJson.ok || !videoJson.result?.message_id) {
        throw new Error(videoJson.description || "Telegram sendVideo uğursuz oldu");
      }

      telegramMsgId = videoJson.result.message_id;

      // Phase 2: Confirm Telegram dispatch only after sendVideo succeeded
      await supabase.rpc("confirm_telegram_dispatch", {
        p_publication_id: pubId,
        p_lock_token: lockToken,
        p_message_id: telegramMsgId,
      });

      const nowIso = new Date().toISOString();
      await supabase
        .from("publications")
        .update({
          status: "READY_TO_PUBLISH",
          verified_at: nowIso,
          preflight_status: "PASSED",
          last_preflight_error: null,
        })
        .eq("id", pubId);

      // Send copyable caption block as follow-up message
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: copyableCodeMessage,
          parse_mode: "HTML",
        }),
      }).catch(() => undefined);

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
    } catch (telegramErr: unknown) {
      // Release atomic lease slot without setting telegram_dispatched_at
      await supabase.rpc("release_telegram_dispatch_slot", {
        p_publication_id: pubId,
        p_lock_token: lockToken,
      });

      return NextResponse.json(
        {
          ok: false,
          reason: "ERROR",
          telegram_dispatched: false,
          message:
            telegramErr instanceof Error
              ? telegramErr.message
              : "Telegram sendVideo göndərişi uğursuz oldu.",
        },
        { status: 502 }
      );
    }
  }

  // PASS without Telegram dispatch
  const nowIso = new Date().toISOString();
  if (existingPublication) {
    await supabase
      .from("publications")
      .update({
        verified_at: nowIso,
        preflight_status: "PASSED",
        last_preflight_error: null,
      })
      .eq("id", existingPublication.id);
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
