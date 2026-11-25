import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/auth/resolve-operator";
import type {
  TelegramDispatchPayload,
  TelegramDispatchResponse,
} from "@/lib/ai-client";

const MAX_TELEGRAM_URL_BYTES = 20 * 1024 * 1024;
const HEAD_REQUEST_TIMEOUT_MS = 2000;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildCrmCaption(
  listing: Record<string, unknown>,
  displayRef: string,
  targetAccount: string,
  ownerPhone: string
): string {
  const price = listing?.price_azn_normalized || listing?.price;
  const numPrice = Number(price);
  const formattedPrice =
    !isNaN(numPrice) && numPrice > 0
      ? `${numPrice.toLocaleString("az-AZ")} AZN`
      : "Münasib Qiymət";

  const location =
    (listing?.location as string) ||
    (listing?.address as string) ||
    (listing?.district_normalized as string) ||
    "Bakı";

  const contactName = (listing?.contact_name as string) || "Mülkiyyətçi";
  const cleanHandle = targetAccount.replace(/^@/, "");
  const waDigits = ownerPhone.replace(/\D/g, "");
  const waUrl = waDigits
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent(
        `Salam, #${displayRef} nömrəli elanınızla bağlı yazıram.`
      )}`
    : listing?.bina_id
    ? `https://bina.az/items/${listing.bina_id}`
    : "";

  const lines = [
    `🎯 <b>HESAB: @${cleanHandle}</b>`,
    `💼 <b>DAXİLİ CRM — MÜLKİYYƏTÇİ İLƏ ƏLAQƏ</b>`,
    `👤 <b>Elan Sahibi:</b> ${contactName}`,
    `📞 <b>Telefon:</b> <code>${ownerPhone || "Qeyd olunmayıb"}</code>`,
    ...(waUrl ? [`💬 <a href="${waUrl}">Mülkiyyətçiyə WhatsApp-da Yaz</a>`] : []),
    ...(listing?.bina_id
      ? [`🔗 <b>bina.az:</b> https://bina.az/items/${listing.bina_id}`]
      : []),
    `💰 <b>Qiymət:</b> ${formattedPrice} | 📍 <b>Ərazi:</b> ${location}`,
  ];

  const caption = lines.join("\n");
  return caption.length > 1024 ? caption.slice(0, 1021) + "..." : caption;
}

function buildPublicCaption(
  listing: Record<string, unknown>,
  customCaption?: string
): string {
  if (customCaption && customCaption.trim()) {
    return customCaption.trim();
  }

  const price = listing?.price_azn_normalized || listing?.price;
  const numPrice = Number(price);
  const formattedPrice =
    !isNaN(numPrice) && numPrice > 0
      ? `${numPrice.toLocaleString("az-AZ")} AZN`
      : "Münasib Qiymət";

  const location =
    (listing?.location as string) ||
    (listing?.address as string) ||
    (listing?.district_normalized as string) ||
    "Bakı";
  const rooms = listing?.rooms ? `${listing.rooms} otaqlı` : "";
  const area = listing?.area ? `${listing.area} m²` : "";
  const kupca = listing?.has_bill_of_sale
    ? "✅ Çıxarış (Kupça) var"
    : "📄 Müqavilə / Sənəd dəqiqləşdirilir";
  const kupcaTag = listing?.has_bill_of_sale ? " #kupcali" : "";

  return `✨ Yeni Təklif: ${rooms} ${area} mənzil\n📍 Ərazi: ${location}\n💰 Qiymət: ${formattedPrice}\n📋 Sənəd: ${kupca}\n\n📲 Ətraflı məlumat və baxış üçün Direct və ya WhatsApp keçidinə yazın!\n\n#baku #azerbaijan #emlak #menzil #binaaz${kupcaTag} #baki #dasinmazemlak #reelsazerbaijan`;
}

function buildInlineKeyboard(
  displayRef: string,
  binaId: string | null,
  rawPhone?: string
) {
  const waDigits = rawPhone ? rawPhone.replace(/\D/g, "") : "";
  const waUrl = waDigits
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent(
        `Salam, #${displayRef} nömrəli elanınızla bağlı yazıram.`
      )}`
    : binaId
    ? `https://bina.az/items/${binaId}`
    : undefined;
  const binaUrl = binaId ? `https://bina.az/items/${binaId}` : undefined;

  const linkRow: Array<Record<string, string>> = [];
  if (waUrl) linkRow.push({ text: "💬 WhatsApp Sahibinə", url: waUrl });
  if (binaUrl) linkRow.push({ text: "🌐 Bina.az Elanı", url: binaUrl });

  return {
    inline_keyboard: [
      [
        { text: "🔄 Yenidən Render Et", callback_data: `rerender_${displayRef}` },
        { text: "✍️ Ssenarini Dəyiş", callback_data: `scriptmenu_${displayRef}` },
      ],
      [
        { text: "🎙️ Səsi Dəyiş", callback_data: `voicemenu_${displayRef}` },
        { text: "📊 Keenable Hesabatı", callback_data: `keenable_${displayRef}` },
      ],
      ...(linkRow.length > 0 ? [linkRow] : []),
      [
        { text: "🚀 Təsdiqlə və Paylaş", callback_data: `publish_${displayRef}` },
        { text: "❌ Arxivlə", callback_data: `archive_${displayRef}` },
      ],
    ],
  };
}

export async function POST(request: Request) {
  const auth = await requireOperator(request);
  if (!auth.ok) {
    return auth.response;
  }
  const { operator } = auth;

  let body: TelegramDispatchPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        dispatch_mode: "DIRECT_URL",
        target_chat_id: "",
        error: "Sorğu gövdəsi etibarlı JSON deyil.",
      } as TelegramDispatchResponse,
      { status: 400 }
    );
  }

  const { listing_id, render_version_id, custom_caption, force_queue } = body;
  const target_account = body.target_account || "@bakuestate.premium";

  if (!listing_id) {
    return NextResponse.json(
      {
        success: false,
        dispatch_mode: "DIRECT_URL",
        target_chat_id: "",
        error: "listing_id parametri tələb olunur.",
      } as TelegramDispatchResponse,
      { status: 400 }
    );
  }

  const supabaseAdmin = createAdminClient();

  // 1. Resolve listing UUID first (prevents UUID cast crash when bina_id is passed)
  const isUuid = UUID_REGEX.test(listing_id);
  let listingQuery = supabaseAdmin
    .from("listings")
    .select("*")
    .eq("agency_id", operator.agencyId);

  if (isUuid) {
    listingQuery = listingQuery.eq("id", listing_id);
  } else {
    listingQuery = listingQuery.eq("bina_id", String(listing_id));
  }

  const { data: listing, error: listingErr } = await listingQuery.maybeSingle();
  if (listingErr || !listing) {
    return NextResponse.json(
      {
        success: false,
        dispatch_mode: "DIRECT_URL",
        target_chat_id: "",
        error: "Elan verilənlər bazasında tapılmadı.",
      } as TelegramDispatchResponse,
      { status: 404 }
    );
  }

  // 2. Resolve render_versions row using listing.id UUID
  let renderVersionQuery = supabaseAdmin
    .from("render_versions")
    .select("*");
  if (render_version_id) {
    renderVersionQuery = renderVersionQuery.eq("id", render_version_id);
  } else {
    renderVersionQuery = renderVersionQuery
      .eq("listing_id", listing.id)
      .order("created_at", { ascending: false })
      .limit(1);
  }

  const { data: renderVersionRows, error: renderErr } =
    await renderVersionQuery;
  const renderVersion = Array.isArray(renderVersionRows)
    ? renderVersionRows[0]
    : renderVersionRows;

  if (renderErr || !renderVersion) {
    return NextResponse.json(
      {
        success: false,
        dispatch_mode: "DIRECT_URL",
        target_chat_id: "",
        error: "Montaj edilmiş video tapılmadı.",
      } as TelegramDispatchResponse,
      { status: 404 }
    );
  }

  if (
    renderVersion.storage_pruned_at !== null &&
    renderVersion.storage_pruned_at !== undefined
  ) {
    return NextResponse.json(
      {
        success: false,
        dispatch_mode: "DIRECT_URL",
        target_chat_id: "",
        error: "Video faylı saxlancdan silinib (storage_pruned_at).",
      } as TelegramDispatchResponse,
      { status: 410 }
    );
  }

  if (!renderVersion.video_cdn_url) {
    return NextResponse.json(
      {
        success: false,
        dispatch_mode: "DIRECT_URL",
        target_chat_id: "",
        error: "Montaj edilmiş video (video_cdn_url) tapılmadı.",
      } as TelegramDispatchResponse,
      { status: 404 }
    );
  }

  const videoCdnUrl: string = renderVersion.video_cdn_url;
  const binaId = listing.bina_id ? String(listing.bina_id) : null;
  const displayRef = binaId || String(listing.id).slice(0, 8);

  // 3. Resolve agency Telegram configuration (fail-closed 503 if missing)
  const { data: agencySettings } = await supabaseAdmin
    .from("agency_settings")
    .select("telegram_chat_id")
    .eq("agency_id", operator.agencyId)
    .maybeSingle();

  const targetChatId =
    agencySettings?.telegram_chat_id ||
    process.env.TELEGRAM_CHAT_ID ||
    process.env.OPERATOR_TELEGRAM_CHAT_ID ||
    "";
  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";

  if (
    !botToken ||
    botToken.startsWith("mock") ||
    botToken === "test" ||
    !targetChatId
  ) {
    return NextResponse.json(
      {
        success: false,
        dispatch_mode: "DIRECT_URL",
        target_chat_id: targetChatId,
        error:
          "Telegram bot konfiqurasiyası (TELEGRAM_BOT_TOKEN / telegram_chat_id) təyin edilməyib.",
      } as TelegramDispatchResponse,
      { status: 503 }
    );
  }

  // Fetch owner phone separately (blocked for SMM)
  let rawPhone = "";
  if (operator.role !== "SMM") {
    const { data: ownerContact } = await supabaseAdmin
      .from("listing_owner_contacts")
      .select("owner_phone_raw, owner_phone_normalized")
      .eq("listing_id", listing.id)
      .eq("agency_id", operator.agencyId)
      .maybeSingle();
    rawPhone =
      ownerContact?.owner_phone_raw ||
      ownerContact?.owner_phone_normalized ||
      (listing.owner_phone_raw as string) ||
      (listing.owner_phone_normalized as string) ||
      "";
  }

  // 4. Inspect file size via HTTP HEAD (2000ms timeout)
  let contentLength: number | null = null;
  let headTimedOut = false;

  if (!force_queue) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        HEAD_REQUEST_TIMEOUT_MS
      );

      const headResponse = await fetch(videoCdnUrl, {
        method: "HEAD",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const lengthHeader = headResponse.headers.get("content-length");
      if (lengthHeader) {
        contentLength = parseInt(lengthHeader, 10);
      }
    } catch {
      headTimedOut = true;
    }
  }

  const isEligibleForDirectUrl =
    !force_queue &&
    !headTimedOut &&
    typeof contentLength === "number" &&
    contentLength > 0 &&
    contentLength <= MAX_TELEGRAM_URL_BYTES;

  // 5A. Direct URL dispatch (<= 20MB)
  if (isEligibleForDirectUrl) {
    const crmCaption = buildCrmCaption(
      listing,
      displayRef,
      target_account,
      rawPhone
    );
    const replyMarkup = buildInlineKeyboard(displayRef, binaId, rawPhone);
    const publicCaption = buildPublicCaption(listing, custom_caption);

    let telegramMsgId: number | undefined;

    try {
      const sendVideoRes = await fetch(
        `https://api.telegram.org/bot${botToken}/sendVideo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: targetChatId,
            video: videoCdnUrl,
            caption: crmCaption,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          }),
        }
      );

      const videoData = await sendVideoRes.json();
      if (!sendVideoRes.ok || !videoData.ok) {
        throw new Error(videoData.description || "Telegram sendVideo xətası");
      }

      telegramMsgId = videoData.result?.message_id;

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: targetChatId,
          text: publicCaption,
        }),
      });
    } catch (tgErr: unknown) {
      console.warn(
        "[TELEGRAM DISPATCH] Direct URL delivery failed, falling back to queue:",
        tgErr
      );
      return await enqueueTelegramWorker(
        supabaseAdmin,
        operator.agencyId,
        operator.operatorId,
        listing,
        displayRef,
        binaId,
        renderVersion.id,
        videoCdnUrl,
        targetChatId,
        target_account,
        custom_caption
      );
    }

    try {
      await supabaseAdmin.from("listing_events").insert({
        agency_id: operator.agencyId,
        listing_id: listing.id,
        event_type: "STATUS_CHANGED",
        actor: "web_user",
        actor_user_id: operator.operatorId,
        notes: `Telegram-a video göndərildi (@${target_account.replace(
          /^@/,
          ""
        )}, msg_id: ${telegramMsgId})`,
      });
    } catch {
      // Non-fatal audit log
    }

    return NextResponse.json({
      success: true,
      dispatch_mode: "DIRECT_URL",
      telegram_message_id: telegramMsgId,
      target_chat_id: targetChatId,
    } as TelegramDispatchResponse);
  }

  // 5B. Video > 20MB or HEAD timed out -> Enqueue into pipeline_jobs
  return await enqueueTelegramWorker(
    supabaseAdmin,
    operator.agencyId,
    operator.operatorId,
    listing,
    displayRef,
    binaId,
    renderVersion.id,
    videoCdnUrl,
    targetChatId,
    target_account,
    custom_caption
  );
}

async function enqueueTelegramWorker(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  agencyId: string,
  operatorId: string,
  listing: Record<string, unknown>,
  displayRef: string,
  binaId: string | null,
  renderVersionId: string,
  videoCdnUrl: string,
  targetChatId: string,
  targetAccount: string,
  customCaption?: string
): Promise<NextResponse<TelegramDispatchResponse>> {
  try {
    const listingUuid = String(listing.id);
    const { data: job, error: jobErr } = await supabaseAdmin
      .from("pipeline_jobs")
      .insert({
        agency_id: agencyId,
        created_by: operatorId,
        idempotency_key: `telegram_dispatch:${displayRef}:${Date.now()}`,
        job_type: "TELEGRAM_DISPATCH",
        listing_id: listingUuid,
        trigger_source: "WEB_UI",
        params_json: {
          listing_id: listingUuid,
          bina_id: binaId,
          render_version_id: renderVersionId,
          video_cdn_url: videoCdnUrl,
          target_chat_id: targetChatId,
          target_account: targetAccount,
          custom_caption: customCaption,
        },
        status: "QUEUED",
      })
      .select("id")
      .single();

    if (jobErr) {
      throw jobErr;
    }

    try {
      await supabaseAdmin.from("listing_events").insert({
        agency_id: agencyId,
        listing_id: listingUuid,
        event_type: "STATUS_CHANGED",
        actor: "web_user",
        actor_user_id: operatorId,
        notes: `Telegram multipart video göndərişi növbəyə əlavə edildi (job_id: ${job?.id})`,
      });
    } catch {
      // Non-fatal audit log
    }

    return NextResponse.json({
      success: true,
      dispatch_mode: "QUEUED_WORKER",
      job_id: job?.id,
      target_chat_id: targetChatId,
    } as TelegramDispatchResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        success: false,
        dispatch_mode: "QUEUED_WORKER",
        target_chat_id: targetChatId,
        error: message || "Telegram göndəriş işi növbəyə yazıla bilmədi.",
      } as TelegramDispatchResponse,
      { status: 500 }
    );
  }
}
