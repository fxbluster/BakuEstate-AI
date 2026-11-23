// =============================================================================
// BakuEstate-AI: 24/7 Telegram Webhook Edge Function (Deno / Supabase)
// File: supabase/functions/telegram-webhook/index.ts
//
// Replaces Windows long-polling so mobile buttons, /lead, and /today work 24/7
// even when the local Windows render PC is powered off.
//
// Security (Fail-Closed):
//   1. Requires POST + exact X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET (403 on mismatch)
//   2. Requires incoming chat_id to match TELEGRAM_CHAT_ID (returns 200 ignored on unauthorized chat_id
//      to prevent Telegram 24h webhook retry storms)
//   3. All credentials read strictly from Deno.env (zero hardcoded keys)
// =============================================================================

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const BAKU_OFFSET_MS = 4 * 60 * 60 * 1000; // Asia/Baku is fixed UTC+4 (no DST)

const BAKU_DISTRICT_MEDIAN_M2: Record<string, number> = {
  "nərimanov": 3293,
  "nerimanov": 3293,
  "nəsimi": 3131,
  "nasimi": 3131,
  "səbail": 3037,
  "sebail": 3037,
  "yasamal": 2923,
  "xəzər": 2844,
  "xezer": 2844,
  "nizami": 2843,
  "xətai": 2647,
  "xetai": 2647,
  "binəqədi": 1950,
  "bineqedi": 1950,
  "sabunçu": 1750,
  "sabuncu": 1750,
  "suraxanı": 1550,
  "suraxani": 1550,
  "pirallahı": 1350,
  "abşeron": 1667,
  "absheron": 1667,
  "masazır": 1450,
  "xırdalan": 1550,
  "baku_median": 2650,
};

const BAKU_LANDMARK_DISTRICT_MAP: Record<string, string> = {
  "gənclik": "Nərimanov",
  "genclik": "Nərimanov",
  "nəriman nərimanov": "Nərimanov",
  "neriman nerimanov": "Nərimanov",
  "montin": "Nərimanov",
  "təbriz": "Nərimanov",
  "28 may": "Nəsimi",
  "cəfər cabbarlı": "Nəsimi",
  "nəsimi bazarı": "Nəsimi",
  "papanin": "Nəsimi",
  "elmlər": "Yasamal",
  "elmler": "Yasamal",
  "inşaatçılar": "Yasamal",
  "insaatcilar": "Yasamal",
  "20 yanvar": "Yasamal",
  "yeni yasamal": "Yasamal",
  "içərişəhər": "Səbail",
  "iceriseher": "Səbail",
  "sahil": "Səbail",
  "badamdar": "Səbail",
  "bayıl": "Səbail",
  "bayil": "Səbail",
  "şah ismayıl xətai": "Xətai",
  "əhmədli": "Xətai",
  "ehmedli": "Xətai",
  "həzi aslanov": "Xətai",
  "hezi aslanov": "Xətai",
  "ağ şəhər": "Xətai",
  "ag seher": "Xətai",
  "white city": "Xətai",
  "köhnə günəşli": "Xətai",
  "neftçilər": "Nizami",
  "neftciler": "Nizami",
  "qara qarayev": "Nizami",
  "xalqlar": "Nizami",
  "koroğlu": "Nizami",
  "koroglu": "Nizami",
  "memar əcəmi": "Binəqədi",
  "əcəmi": "Binəqədi",
  "azadlıq": "Binəqədi",
  "dərnəgül": "Binəqədi",
  "biləcəri": "Binəqədi",
  "bakıxanov": "Sabunçu",
  "zabrat": "Sabunçu",
  "maştağa": "Sabunçu",
  "mərdəkan": "Xəzər",
  "merdekan": "Xəzər",
  "şüvəlan": "Xəzər",
  "buzovna": "Xəzər",
  "bilgəh": "Xəzər",
  "qaraçuxur": "Suraxanı",
  "hövsan": "Suraxanı",
  "yeni günəşli": "Suraxanı",
  "xırdalan": "Abşeron",
  "xirdalan": "Abşeron",
  "masazır": "Abşeron",
  "masazir": "Abşeron",
};

interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export const INSTAGRAM_REEL_REGEX = /^https?:\/\/(www\.)?instagram\.com\/reel\/[A-Za-z0-9_-]+/i;
export const TIKTOK_VIDEO_REGEX = /^https?:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9_.-]+\/video\/[0-9]+/i;

export interface SocialCommentLeadAlertPayload {
  bina_id?: string | number | null;
  listing_id?: string | null;
  location?: string | null;
  price?: string | number | null;
  currency?: string | null;
  author_handle: string;
  comment_text: string;
  suggested_reply?: string | null;
  platform?: string | null;
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineButton[][];
}

interface ListingRow {
  id: string;
  bina_id: string;
  url: string;
  title: string | null;
  price: number | null;
  currency: string;
  price_azn_normalized: number;
  location: string | null;
  address: string | null;
  rooms: number | null;
  area: number | null;
  floor: number | null;
  floors: number | null;
  has_bill_of_sale: boolean;
  is_owner: boolean;
  contact_name: string | null;
  owner_phone_raw: string | null;
  owner_phone_normalized: string | null;
  description: string | null;
  editorial_status: string;
  pipeline_status: string;
  duplicate_resolution: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatNumberAz(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function normalizePhoneAz(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("994")) {
    return `+${digits}`;
  }
  if (digits.length === 10 && digits.startsWith("0")) {
    return `+994${digits.slice(1)}`;
  }
  if (digits.length === 9 && /^(50|51|55|70|77|99|10|12)/.test(digits)) {
    return `+994${digits}`;
  }
  return null;
}

function formatBakuDateTime(iso: string): string {
  const dt = new Date(new Date(iso).getTime() + BAKU_OFFSET_MS);
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(dt.getUTCHours()).padStart(2, "0");
  const mi = String(dt.getUTCMinutes()).padStart(2, "0");
  return `${dd}.${mm} ${hh}:${mi}`;
}

function getBakuDayBounds(nowUtc: Date = new Date()): { startIso: string; endIso: string; tomorrow0930Iso: string } {
  const bakuMs = nowUtc.getTime() + BAKU_OFFSET_MS;
  const bakuDate = new Date(bakuMs);
  const y = bakuDate.getUTCFullYear();
  const m = bakuDate.getUTCMonth();
  const d = bakuDate.getUTCDate();

  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0) - BAKU_OFFSET_MS;
  const endUtcMs = Date.UTC(y, m, d, 23, 59, 59, 999) - BAKU_OFFSET_MS;
  const tomorrow0930UtcMs = Date.UTC(y, m, d + 1, 9, 30, 0) - BAKU_OFFSET_MS;

  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString(),
    tomorrow0930Iso: new Date(tomorrow0930UtcMs).toISOString(),
  };
}

function getPropertyType(listing: Partial<ListingRow>): string {
  const title = (listing.title ?? "").toLowerCase();
  const desc = (listing.description ?? "").toLowerCase();
  const combined = `${title} ${desc}`;
  const isApt = title.includes("mənzil") || title.includes("menzil");

  if (
    ["həyət evi", "heyet evi", "bağ evi", "bag evi"].some((k) => title.includes(k)) ||
    (!isApt && ["həyət evi", "heyet evi", "bağ evi", "bag evi"].some((k) => combined.includes(k)))
  ) {
    return "HƏYƏT EVİ";
  }
  if (title.includes("villa") || (!isApt && combined.includes("villa"))) {
    return "VİLLA";
  }
  if (
    ["obyekt", "ofis", "kommersiya"].some((k) => title.includes(k)) ||
    (!isApt && ["obyekt satılır", "qeyri-yaşayış"].some((k) => combined.includes(k)))
  ) {
    return "OBYEKT";
  }
  return "MƏNZİL";
}

function generatePublicCaption(listing: ListingRow): string {
  const numPrice = Number(listing.price ?? listing.price_azn_normalized ?? 0);
  const formattedPrice = numPrice > 0 ? formatNumberAz(numPrice) : "Münasib Qiymət";
  const curr = listing.currency || "AZN";
  let loc = listing.location || listing.address || "Bakı";
  loc = loc
    .replace(/\bq\.(?=\s|$|[,\.!])/gi, "qəsəbəsi")
    .replace(/\bm\.(?=\s|$|[,\.!])/gi, "metrosu")
    .replace(/\bküç\.(?=\s|$|[,\.!])/gi, "küçəsi")
    .replace(/\bpr\.(?=\s|$|[,\.!])/gi, "prospekti")
    .trim();

  const propType = getPropertyType(listing);
  const hashtags =
    propType === "HƏYƏT EVİ"
      ? ["#emlak", "#evler", "#heyetevleri", "#kupcali", "#baku"]
      : propType === "VİLLA"
      ? ["#villa", "#luxuryrealestate", "#baku", "#emlak", "#kupcali"]
      : ["#emlak", "#menzil", "#baku", "#kupcali", "#ipoteka"];

  const areaNum = Number(listing.area ?? 0);
  const areaStr = areaNum > 0 ? `${Number.isInteger(areaNum) ? areaNum : areaNum.toFixed(1)} m²` : "";
  const floorStr = listing.floor ? ` | ${listing.floor}/${listing.floors ?? ""} mərtəbə` : "";
  const kupcaBadge = listing.has_bill_of_sale
    ? "✅ Dövlət Çıxarışı (Kupça) var - İpotekaya yararlıdır!"
    : "Müqaviləli";

  return [
    `🔥 <b>TƏCİLİ KUPÇALI ${propType} SATILIR!</b> 🔥`,
    "",
    `💰 <b>Qiymət:</b> ${formattedPrice} ${curr}`,
    `📍 <b>Ünvan:</b> ${escapeHtml(loc)}`,
    `📐 <b>Parametrlər:</b> ${listing.rooms ?? "-"} otaq | ${areaStr}${floorStr}`,
    `📜 <b>Sənəd:</b> ${kupcaBadge}`,
    "",
    "📩 <b>Ətraflı məlumat və baxış üçün Direktə (DM) yazın və ya bizimlə əlaqə saxlayın!</b>",
    "",
    hashtags.join(" "),
  ].join("\n");
}

function buildMainKeyboard(listing: Partial<ListingRow> & { bina_id: string }): InlineKeyboardMarkup {
  const binaId = listing.bina_id;
  const binaUrl = listing.url || `https://bina.az/items/${binaId}`;
  const digits = (listing.owner_phone_normalized || listing.owner_phone_raw || "").replace(/\D/g, "");
  const propType = getPropertyType(listing).toLowerCase();
  const waUrl = digits
    ? `https://wa.me/${digits}?text=${encodeURIComponent(`Salam, bina.az-dakı ${binaId} nömrəli ${propType} elanınızla bağlı yazıram.`)}`
    : binaUrl;

  return {
    inline_keyboard: [
      [
        { text: "🔄 Yenidən Render Et", callback_data: `rerender_${binaId}` },
        { text: "✍️ Ssenarini Dəyiş", callback_data: `scriptmenu_${binaId}` },
      ],
      [
        { text: "🎙️ Səsi Dəyiş", callback_data: `voicemenu_${binaId}` },
        { text: "📊 Keenable Hesabatı", callback_data: `keenable_${binaId}` },
      ],
      [
        { text: "💬 WhatsApp Sahibinə", url: waUrl },
        { text: "🌐 Bina.az Elanı", url: binaUrl },
      ],
      [
        { text: "🚀 Paylaş & Link Daxil Et", callback_data: `ask_puburl_${binaId}` },
        { text: "❌ Arxivlə", callback_data: `archive_${binaId}` },
      ],
    ],
  };
}

function buildScriptMenuKeyboard(binaId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "👨‍👩‍👧‍👦 Ailəvi Yaşayış", callback_data: `scriptset_${binaId}_family` },
        { text: "📈 İnvestisiya / ROI", callback_data: `scriptset_${binaId}_investor` },
      ],
      [
        { text: "⚡ Təcili Fürsət", callback_data: `scriptset_${binaId}_urgent` },
        { text: "👑 Lüks & Prestij", callback_data: `scriptset_${binaId}_luxury` },
      ],
      [{ text: "⬅️ Əsas Menyuya Qayıt", callback_data: `mainmenu_${binaId}` }],
    ],
  };
}

function buildVoiceMenuKeyboard(binaId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "💎 ElevenLabs — Arif", callback_data: `voiceset_${binaId}_eleven_male` },
        { text: "🌸 ElevenLabs — Xanım", callback_data: `voiceset_${binaId}_eleven_female` },
      ],
      [
        { text: "🎙️ OpenAI Nova HD", callback_data: `voiceset_${binaId}_nova` },
        { text: "📻 Edge-TTS Babek", callback_data: `voiceset_${binaId}_edge` },
      ],
      [{ text: "⬅️ Əsas Menyuya Qayıt", callback_data: `mainmenu_${binaId}` }],
    ],
  };
}

function buildTaskActionKeyboard(taskId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Tamamlandı", callback_data: `task_done_${taskId}` },
        { text: "⏰ +3 saat", callback_data: `task_snooze_3h_${taskId}` },
        { text: "📅 Sabaha", callback_data: `task_tomorrow_${taskId}` },
      ],
    ],
  };
}

function computeKeenableStats(location: string, priceAzn: number, area: number): string {
  if (!priceAzn || priceAzn <= 0 || !area || area <= 0) {
    return `📊 ${location || "Bakı"} üzrə bazar məlumatı: ${formatNumberAz(priceAzn)} AZN / ${area || "-"} m².`;
  }
  const m2Price = Math.floor(priceAzn / area);
  const locLower = (location || "").toLowerCase();

  let matchedDistrict = "";
  let districtMedian = BAKU_DISTRICT_MEDIAN_M2["baku_median"];

  for (const [dName, dMedian] of Object.entries(BAKU_DISTRICT_MEDIAN_M2)) {
    if (dName !== "baku_median" && locLower.includes(dName)) {
      matchedDistrict = dName.charAt(0).toUpperCase() + dName.slice(1);
      districtMedian = dMedian;
      break;
    }
  }
  if (!matchedDistrict) {
    for (const [landmark, distName] of Object.entries(BAKU_LANDMARK_DISTRICT_MAP)) {
      if (locLower.includes(landmark)) {
        matchedDistrict = distName;
        districtMedian = BAKU_DISTRICT_MEDIAN_M2[distName.toLowerCase()] ?? districtMedian;
        break;
      }
    }
  }
  if (!matchedDistrict) matchedDistrict = "Bakı";

  const diff = districtMedian - m2Price;
  const discountPct = Math.round((diff / districtMedian) * 1000) / 10;
  const totalDiff = Math.round(Math.abs(diff) * area);

  return [
    "📊 KEENABLE BAZAR ANALİTİKASI (2026)",
    "",
    `📍 Ərazi: ${matchedDistrict}`,
    `🏢 Median: ${formatNumberAz(districtMedian)} AZN/m²`,
    `💰 Bu Mənzil: ${formatNumberAz(m2Price)} AZN/m²`,
    `📉 Bazar Fərqi: ${discountPct}% ${discountPct > 0 ? "UCUZ!" : "BAHA"}`,
    `💵 Fərq: təxm. ${formatNumberAz(totalDiff)} AZN`,
  ].join("\n");
}

async function tgApi(botToken: string, method: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch (err) {
    console.error(`Telegram API error (${method}):`, err);
    return false;
  }
}

async function findListingByIdOrBinaId(
  supabase: SupabaseClient,
  identifier: string,
): Promise<ListingRow | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  const query = supabase.from("listings").select("*");
  const { data, error } = isUuid
    ? await query.eq("id", identifier).maybeSingle()
    : await query.eq("bina_id", identifier).maybeSingle();
  if (error) {
    console.error("findListingByIdOrBinaId error:", error.message);
    return null;
  }
  return data as ListingRow | null;
}

function parseLeadCommand(rawArgs: string): {
  binaId: string | null;
  clientName: string;
  phoneNormalized: string | null;
  dueAtIso: string;
  stage: "NEW_INQUIRY" | "VIEWING_SCHEDULED";
  priority: "NORMAL" | "HIGH";
  notes: string;
} {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  let idx = 0;

  let binaId: string | null = null;
  if (tokens[idx] && /^\d{4,}$/.test(tokens[idx])) {
    binaId = tokens[idx];
    idx++;
  }

  // Scan remaining tokens for phone, date keywords, time, and note words
  let phoneNormalized: string | null = null;
  const nameTokens: string[] = [];
  const noteTokens: string[] = [];

  const nowBaku = new Date(Date.now() + BAKU_OFFSET_MS);
  let targetYear = nowBaku.getUTCFullYear();
  let targetMonth = nowBaku.getUTCMonth();
  let targetDay = nowBaku.getUTCDate();
  let hasExplicitDate = false;
  let targetHour = 10;
  let targetMinute = 0;
  let hasExplicitTime = false;
  let readingNotes = false;

  for (; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    const lower = tok.toLowerCase();

    // Phone check
    const maybePhone = normalizePhoneAz(tok);
    if (!phoneNormalized && maybePhone && tok.replace(/\D/g, "").length >= 9) {
      phoneNormalized = maybePhone;
      readingNotes = true;
      continue;
    }

    // Relative Azerbaijani dates
    if (lower === "sabah") {
      targetDay += 1;
      hasExplicitDate = true;
      readingNotes = true;
      continue;
    }
    if (lower === "bugün" || lower === "bugun") {
      hasExplicitDate = true;
      readingNotes = true;
      continue;
    }
    if (lower === "bu" && tokens[idx + 1]?.toLowerCase() === "gün") {
      hasExplicitDate = true;
      readingNotes = true;
      idx++;
      continue;
    }

    // Explicit YYYY-MM-DD
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tok);
    if (isoMatch) {
      targetYear = Number(isoMatch[1]);
      targetMonth = Number(isoMatch[2]) - 1;
      targetDay = Number(isoMatch[3]);
      hasExplicitDate = true;
      readingNotes = true;
      continue;
    }

    // Explicit DD.MM or DD.MM.YYYY
    const dmyMatch = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(tok);
    if (dmyMatch) {
      targetDay = Number(dmyMatch[1]);
      targetMonth = Number(dmyMatch[2]) - 1;
      if (dmyMatch[3]) targetYear = Number(dmyMatch[3]);
      hasExplicitDate = true;
      readingNotes = true;
      continue;
    }

    // Explicit HH:MM
    const hmMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(tok);
    if (hmMatch) {
      targetHour = Number(hmMatch[1]);
      targetMinute = Number(hmMatch[2]);
      hasExplicitTime = true;
      readingNotes = true;
      continue;
    }

    if (!readingNotes && nameTokens.length < 2) {
      nameTokens.push(tok);
    } else {
      noteTokens.push(tok);
    }
  }

  let dueUtcMs: number;
  if (hasExplicitDate || hasExplicitTime) {
    dueUtcMs = Date.UTC(targetYear, targetMonth, targetDay, targetHour, targetMinute, 0) - BAKU_OFFSET_MS;
    if (!hasExplicitDate && dueUtcMs < Date.now()) {
      dueUtcMs += 24 * 60 * 60 * 1000;
    }
  } else {
    // Default follow-up: +3 hours from now
    dueUtcMs = Date.now() + 3 * 60 * 60 * 1000;
  }

  const notes = noteTokens.join(" ").trim();
  const combinedNotesLower = rawArgs.toLowerCase();
  const isViewing =
    combinedNotesLower.includes("baxış") ||
    combinedNotesLower.includes("baxis") ||
    combinedNotesLower.includes("görüş") ||
    combinedNotesLower.includes("gorus");

  return {
    binaId,
    clientName: nameTokens.join(" ").trim() || "Müştəri",
    phoneNormalized,
    dueAtIso: new Date(dueUtcMs).toISOString(),
    stage: isViewing ? "VIEWING_SCHEDULED" : "NEW_INQUIRY",
    priority: isViewing ? "HIGH" : "NORMAL",
    notes,
  };
}

async function handleLeadCommand(
  supabase: SupabaseClient,
  botToken: string,
  chatId: string | number,
  rawArgs: string,
): Promise<void> {
  if (!rawArgs.trim()) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: [
        "ℹ️ <b>İstifadə qaydası:</b>",
        "<code>/lead 5616503 Elvin +994501234567 sabah 14:00 baxış</code>",
        "və ya sadəcə:",
        "<code>/lead Elvin +994501234567 2 otaqlı Yasamal</code>",
      ].join("\n"),
    });
    return;
  }

  const parsed = parseLeadCommand(rawArgs);
  const listing = parsed.binaId ? await findListingByIdOrBinaId(supabase, parsed.binaId) : null;

  const { data: leadRow, error: leadErr } = await supabase
    .from("buyer_leads")
    .insert({
      client_name: parsed.clientName,
      phone_normalized: parsed.phoneNormalized,
      source_channel: "TELEGRAM",
      stage: parsed.stage,
      notes: parsed.notes || (parsed.binaId && !listing ? `bina_id=${parsed.binaId}` : null),
      next_followup_at: parsed.dueAtIso,
    })
    .select("id, client_name, stage")
    .single();

  if (leadErr || !leadRow) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `❌ Müştəri yazılarkən xəta baş verdi: ${leadErr?.message ?? "unknown"}`,
    });
    return;
  }

  if (listing) {
    await supabase.from("lead_listings").upsert(
      {
        lead_id: leadRow.id,
        listing_id: listing.id,
        relation: "INQUIRED",
        notes: parsed.notes || null,
      },
      { onConflict: "lead_id,listing_id" },
    );
  }

  const taskTitle = listing
    ? `${parsed.clientName} — #${listing.bina_id}${parsed.notes ? ` (${parsed.notes})` : ""}`
    : `${parsed.clientName}${parsed.notes ? ` — ${parsed.notes}` : " (Follow-up)"}`;

  const { data: taskRow } = await supabase
    .from("follow_up_tasks")
    .insert({
      entity_type: "BUYER_LEAD",
      lead_id: leadRow.id,
      listing_id: listing?.id ?? null,
      title: taskTitle,
      due_at: parsed.dueAtIso,
      priority: parsed.priority,
      status: "OPEN",
    })
    .select("id")
    .single();

  const lines = [
    "✅ <b>Müştəri CRM-ə əlavə edildi!</b>",
    `👤 <b>Ad:</b> ${escapeHtml(parsed.clientName)}`,
    parsed.phoneNormalized ? `📞 <b>Telefon:</b> <code>${parsed.phoneNormalized}</code>` : null,
    listing
      ? `🏠 <b>Elan:</b> #${listing.bina_id} (${escapeHtml(listing.location || "Bakı")})`
      : parsed.binaId
      ? `🏠 <b>Elan:</b> #${parsed.binaId} (bazada tapılmadı, qeyd kimi saxlandı)`
      : null,
    `📌 <b>Mərhələ:</b> ${parsed.stage} | <b>Prioritet:</b> ${parsed.priority}`,
    `⏰ <b>Xatırlatma (Bakı):</b> ${formatBakuDateTime(parsed.dueAtIso)}`,
    parsed.notes ? `📝 <b>Qeyd:</b> ${escapeHtml(parsed.notes)}` : null,
  ].filter(Boolean);

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: lines.join("\n"),
    reply_markup: taskRow?.id ? buildTaskActionKeyboard(taskRow.id) : undefined,
  });
}

async function handleTodayCommand(
  supabase: SupabaseClient,
  botToken: string,
  chatId: string | number,
): Promise<void> {
  const { endIso } = getBakuDayBounds();
  const { data: tasks, error } = await supabase
    .from("follow_up_tasks")
    .select("id, entity_type, title, due_at, priority, status")
    .in("status", ["OPEN", "SNOOZED"])
    .lte("due_at", endIso)
    .order("due_at", { ascending: true })
    .limit(20);

  if (error) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `❌ Tapşırıqlar oxunmadı: ${error.message}`,
    });
    return;
  }

  if (!tasks || tasks.length === 0) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "✅ <b>Bu gün üçün gecikmiş və ya açıq follow-up tapşırığı yoxdur.</b>",
    });
    return;
  }

  const nowMs = Date.now();
  const priorityOrder: Record<string, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };
  const sorted = [...tasks].sort(
    (a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1),
  );

  const lines = [`📋 <b>Bugünkü Follow-Up Siyahısı (${sorted.length})</b>`, ""];
  const buttons: InlineButton[][] = [];

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const overdue = new Date(t.due_at).getTime() < nowMs;
    const icon = t.priority === "HIGH" ? "🔴" : overdue ? "⚠️" : "🟡";
    lines.push(
      `${i + 1}. ${icon} <b>${escapeHtml(t.title)}</b> — <code>${formatBakuDateTime(t.due_at)}</code>`,
    );
    if (i < 4) {
      buttons.push([
        { text: `✅ #${i + 1} Bitdi`, callback_data: `task_done_${t.id}` },
        { text: `⏰ +3s`, callback_data: `task_snooze_3h_${t.id}` },
        { text: `📅 Sabah`, callback_data: `task_tomorrow_${t.id}` },
      ]);
    }
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: lines.join("\n"),
    reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
  });
}

export function formatSocialCommentLeadAlert(payload: SocialCommentLeadAlertPayload): {
  text: string;
  reply_markup: InlineKeyboardMarkup;
} {
  const binaId = payload.bina_id ? String(payload.bina_id) : "-";
  const loc = payload.location || "Bakı";
  const numPrice = Number(payload.price ?? 0);
  const curr = payload.currency || "AZN";
  const formattedPrice = numPrice > 0 ? `${formatNumberAz(numPrice)} ${curr}` : "Münasib Qiymət";

  const rawHandle = (payload.author_handle || "Müştəri").trim();
  const cleanHandle = rawHandle.replace(/^@/, "").trim();
  const displayHandle = rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`;
  const dmUrl = `https://ig.me/m/${cleanHandle}`;

  const lines = [
    "🎯 <b>Yeni Sosial Şəbəkə Müştəri Sorğusu!</b>",
    "",
    `🏠 <b>Elan:</b> #${binaId}`,
    `📍 <b>Ünvan:</b> ${escapeHtml(loc)}`,
    `💰 <b>Qiymət:</b> ${formattedPrice}`,
    `👤 <b>Müştəri:</b> ${escapeHtml(displayHandle)}`,
    `💬 <b>Şərh:</b> "<i>${escapeHtml(payload.comment_text)}</i>"`,
  ];

  if (payload.suggested_reply) {
    lines.push(
      "",
      "💡 <b>Təklif olunan cavab:</b>",
      `"<i>${escapeHtml(payload.suggested_reply)}</i>"`,
    );
  }

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: "📱 Instagram DM-də Cavab Ver",
          url: dmUrl,
        },
      ],
    ],
  };

  return {
    text: lines.join("\n"),
    reply_markup: replyMarkup,
  };
}

export interface CockpitCardTelegramPayload {
  id: string;
  headline: string;
  channel?: string;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT" | string;
  reason?: string;
  draft_text?: string;
  sentinel_warning?: string;
  owner_phone?: string;
  target_uri?: string;
}

export function formatCockpitCardTelegram(card: CockpitCardTelegramPayload): {
  text: string;
  reply_markup: InlineKeyboardMarkup;
} {
  const cardId = card.id || "";
  const headline = (card.headline || "AI Məsləhət Kartı").trim();
  const channel = (card.channel || "WHATSAPP").toUpperCase().trim();
  const priority = (card.priority || "NORMAL").toUpperCase().trim();
  const reason = (card.reason || "").trim();
  const draftText = (card.draft_text || "").trim();
  const sentinelWarning = card.sentinel_warning;
  const rawPhone = (card.owner_phone || "").trim();
  const targetUri = card.target_uri;

  const priorityIcons: Record<string, string> = {
    URGENT: "🔴 TƏCİLİ",
    HIGH: "🟠 YÜKSƏK",
    NORMAL: "🟡 STANDART",
    LOW: "⚪ AŞAĞI",
  };
  const pBadge = priorityIcons[priority] || "🟡 STANDART";

  const channelIcons: Record<string, string> = {
    WHATSAPP: "📱 WhatsApp",
    TELEGRAM: "✈️ Telegram",
    CALL: "📞 Zəng",
    INSTAGRAM: "📸 Instagram DM",
    TIKTOK: "🎵 TikTok DM",
    SMS: "✉️ SMS",
  };
  const cBadge = channelIcons[channel] || `📡 ${channel}`;

  let waUrl = "https://wa.me/";
  if (rawPhone) {
    const digits = rawPhone.replace(/\D/g, "");
    const waDigits = digits.startsWith("0")
      ? `994${digits.slice(1)}`
      : digits.startsWith("994")
      ? digits
      : `994${digits}`;
    waUrl = `https://wa.me/${waDigits}?text=${encodeURIComponent(draftText)}`;
  } else if (targetUri && targetUri.startsWith("http")) {
    waUrl = targetUri;
  } else if (draftText) {
    waUrl = `https://wa.me/?text=${encodeURIComponent(draftText)}`;
  }

  const lines = [
    "🎯 <b>AI SATIŞ MƏŞVƏRƏT KARTI (COCKPIT HUD)</b>",
    `⚡ <b>Prioritet:</b> ${pBadge} | <b>Kanal:</b> ${cBadge}`,
    `📌 <b>Başlıq:</b> <b>${escapeHtml(headline)}</b>`,
  ];

  if (reason) {
    lines.push(`💡 <b>Strategiya:</b> <i>${escapeHtml(reason)}</i>`);
  }
  if (sentinelWarning) {
    lines.push(`\n⚠️ <b>Sentinel Qoruyucu:</b> <i>${escapeHtml(sentinelWarning)}</i>`);
  }
  if (draftText) {
    lines.push(
      `\n💬 <b>Hazır Mesaj (kopyalamaq üçün toxunun):</b>\n<code>${escapeHtml(draftText)}</code>`,
    );
  }
  lines.push("\n<i>Aşağıdakı düymələrlə dərhal icra edin və ya ləğv edin:</i>");

  const replyMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: "💬 WhatsApp Sahibinə", url: waUrl },
      ],
      [
        { text: "🚀 Təsdiqlə", callback_data: `cockpit_act_${cardId}` },
        { text: "❌ Ləğv Et", callback_data: `cockpit_dismiss_${cardId}` },
      ],
    ],
  };

  return {
    text: lines.join("\n"),
    reply_markup: replyMarkup,
  };
}

export async function dispatchSocialCommentLeadAlert(
  botToken: string,
  chatId: string | number,
  payload: SocialCommentLeadAlertPayload,
): Promise<boolean> {
  const formatted = formatSocialCommentLeadAlert(payload);
  return await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: formatted.text,
    reply_markup: formatted.reply_markup,
  });
}

export async function handlePublishedCommand(
  supabase: SupabaseClient,
  botToken: string,
  chatId: string | number,
  rawArgs: string,
): Promise<{ ok: boolean; binaId?: string; pubId?: string; error?: string }> {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: [
        "ℹ️ <b>İstifadə qaydası:</b>",
        "<code>/published &lt;bina_id&gt; &lt;post_url&gt;</code>",
        "",
        "Nümunə:",
        "<code>/published 5616503 https://www.instagram.com/reel/C8xYz123456/</code>",
      ].join("\n"),
    });
    return { ok: false, error: "invalid_arguments" };
  }

  const binaId = tokens[0];
  const postUrl = tokens[1];

  const isInstagram = INSTAGRAM_REEL_REGEX.test(postUrl);
  const isTikTok = TIKTOK_VIDEO_REGEX.test(postUrl);

  if (!isInstagram && !isTikTok) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: [
        "❌ <b>Yanlış video linki formatı!</b>",
        "",
        "Zəhmət olmasa yalnız Instagram Reels və ya TikTok video linki daxil edin:",
        "• Instagram: <code>https://(www.)instagram.com/reel/[id]</code>",
        "• TikTok: <code>https://(www.)tiktok.com/@[user]/video/[id]</code>",
      ].join("\n"),
    });
    return { ok: false, error: "invalid_url_format" };
  }

  const channel = isInstagram ? "INSTAGRAM_REELS" : "TIKTOK";

  const listing = await findListingByIdOrBinaId(supabase, binaId);
  if (!listing) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `❌ Elan <b>#${escapeHtml(binaId)}</b> bazada tapılmadı.`,
    });
    return { ok: false, error: "listing_not_found" };
  }

  const nowIso = new Date().toISOString();
  // next_poll_at = NOW() + INTERVAL '4 hours'
  const nextPollIso = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

  // Find existing publication for this listing
  const { data: existingPub } = await supabase
    .from("publications")
    .select("id, status")
    .eq("listing_id", listing.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let pubId: string | null = existingPub?.id ?? null;

  if (existingPub) {
    const { data: updatedPub, error: pubErr } = await supabase
      .from("publications")
      .update({
        status: "PUBLISHED",
        post_url: postUrl,
        channel: channel,
        published_at: nowIso,
        telemetry_status: "ACTIVE",
        next_poll_at: nextPollIso,
        last_scrape_error: null,
      })
      .eq("id", existingPub.id)
      .select("id")
      .single();

    if (pubErr) {
      console.error("Failed to update publication:", pubErr.message);
    } else if (updatedPub) {
      pubId = updatedPub.id;
    }
  } else {
    // Get latest completed render version if available
    const { data: latestRender } = await supabase
      .from("render_versions")
      .select("id")
      .eq("listing_id", listing.id)
      .order("version_num", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: newPub, error: insertErr } = await supabase
      .from("publications")
      .insert({
        listing_id: listing.id,
        render_version_id: latestRender?.id ?? null,
        channel: channel,
        post_url: postUrl,
        status: "PUBLISHED",
        published_at: nowIso,
        telemetry_status: "ACTIVE",
        next_poll_at: nextPollIso,
      })
      .select("id")
      .single();

    if (insertErr) {
      console.error("Failed to insert publication:", insertErr.message);
    } else if (newPub) {
      pubId = newPub.id;
    }
  }

  // Update public.listings editorial_status = 'PUBLISHED'
  const { error: listingErr } = await supabase
    .from("listings")
    .update({ editorial_status: "PUBLISHED" })
    .eq("id", listing.id);

  if (listingErr) {
    console.error("Failed to update listing editorial_status:", listingErr.message);
  }

  await supabase.from("listing_events").insert({
    listing_id: listing.id,
    event_type: "STATUS_CHANGED",
    old_value_json: { editorial_status: listing.editorial_status },
    new_value_json: { editorial_status: "PUBLISHED", post_url: postUrl, channel },
    actor: "telegram_user",
  });

  // Insert immediate pipeline_job: job_type = 'SYNC_SOCIAL_METRICS'
  // payload = { publication_id: pub.id, post_url: <url>, channel: 'INSTAGRAM_REELS' }
  const jobPayload = {
    publication_id: pubId,
    post_url: postUrl,
    channel: channel,
  };

  const { error: jobErr } = await supabase
    .from("pipeline_jobs")
    .insert({
      idempotency_key: `sync_social:${pubId ?? listing.id}:${Date.now()}`,
      job_type: "SYNC_SOCIAL_METRICS",
      listing_id: listing.id,
      trigger_source: "TELEGRAM_WEBHOOK",
      params_json: jobPayload,
      status: "QUEUED",
    });

  if (jobErr) {
    console.error("Failed to insert SYNC_SOCIAL_METRICS job:", jobErr.message);
  }

  // Send Telegram confirmation in Azerbaijani:
  // "🚀 Elan #<bina_id> uğurla 'Yayımlandı' olaraq qeyd edildi!\n🔗 Link: <url>\n📊 Telemetriya monitorinqi aktivləşdirildi (ilk yoxlama 4 saat sonra)."
  const confirmationText = [
    `🚀 Elan #${listing.bina_id} uğurla 'Yayımlandı' olaraq qeyd edildi!`,
    `🔗 Link: ${escapeHtml(postUrl)}`,
    "📊 Telemetriya monitorinqi aktivləşdirildi (ilk yoxlama 4 saat sonra).",
  ].join("\n");

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: confirmationText,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🌐 Videoya Bax", url: postUrl },
          { text: "🏠 Bina.az Elanı", url: listing.url || `https://bina.az/items/${listing.bina_id}` },
        ],
      ],
    },
  });

  return { ok: true, binaId: listing.bina_id, pubId: pubId ?? undefined };
}

async function handleCallbackQuery(
  supabase: SupabaseClient,
  botToken: string,
  chatId: string | number,
  // deno-lint-ignore no-explicit-any
  cb: Record<string, any>,
): Promise<Record<string, unknown>> {
  const cbId = String(cb.id ?? "");
  const data = String(cb.data ?? "");
  const messageId = Number(cb.message?.message_id ?? 0);

  // Match multi-word prefixes first before single-word action prefixes
  let action = "";
  let rest = "";
  const multiPrefixes = [
    "cockpit_act_",
    "cockpit_dismiss_",
    "task_snooze_3h_",
    "task_tomorrow_",
    "task_done_",
    "dup_confirm_",
    "dup_separate_",
    "ask_puburl_",
  ];
  for (const prefix of multiPrefixes) {
    if (data.startsWith(prefix)) {
      action = prefix.slice(0, -1);
      rest = data.slice(prefix.length);
      break;
    }
  }
  if (!action) {
    const sepIdx = data.indexOf("_");
    action = sepIdx === -1 ? data : data.slice(0, sepIdx);
    rest = sepIdx === -1 ? "" : data.slice(sepIdx + 1);
  }

  // 0. Cockpit Card Actions
  if (action === "cockpit_act") {
    const cardId = rest;
    const { data: updatedCard, error } = await supabase
      .from("cockpit_cards")
      .update({ status: "EXECUTED" })
      .eq("id", cardId)
      .select("id, lead_id, listing_id, headline")
      .maybeSingle();

    if (error) {
      console.error(`Error updating cockpit card ${cardId}:`, error);
    }

    try {
      await supabase.from("lead_timeline_events").insert({
        lead_id: updatedCard?.lead_id ?? null,
        listing_id: updatedCard?.listing_id ?? null,
        actor: "OPERATOR",
        event_type: "OFFER",
        summary: `Cockpit kartı təsdiqləndi: ${updatedCard?.headline ?? cardId}`,
        metadata: { card_id: cardId, action: "ACT" }
      });
    } catch (tlErr) {
      console.warn("Could not insert lead_timeline_events:", tlErr);
    }

    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: "🚀 Cockpit təklifi təsdiqləndi və icraya göndərildi!",
    });

    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Təsdiqləndi (İcrada)", callback_data: `noop_${cardId}` }]
          ],
        },
      });
    }
    return { action, cardId, ok: true };
  }

  if (action === "cockpit_dismiss") {
    const cardId = rest;
    const { data: updatedCard, error } = await supabase
      .from("cockpit_cards")
      .update({ status: "DISMISSED" })
      .eq("id", cardId)
      .select("id, lead_id, listing_id, headline")
      .maybeSingle();

    if (error) {
      console.error(`Error dismissing cockpit card ${cardId}:`, error);
    }

    try {
      await supabase.from("lead_timeline_events").insert({
        lead_id: updatedCard?.lead_id ?? null,
        listing_id: updatedCard?.listing_id ?? null,
        actor: "OPERATOR",
        event_type: "OBJECTION",
        summary: `Cockpit kartı ləğv edildi: ${updatedCard?.headline ?? cardId}`,
        metadata: { card_id: cardId, action: "DISMISS" }
      });
    } catch (tlErr) {
      console.warn("Could not insert lead_timeline_events:", tlErr);
    }

    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: "❌ Cockpit təklifi ləğv edildi.",
    });

    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: "❌ Ləğv Edildi", callback_data: `noop_${cardId}` }]
          ],
        },
      });
    }
    return { action, cardId, ok: true };
  }

  // 1. Task callbacks
  if (action === "task_done") {
    const taskId = rest;
    const { error } = await supabase
      .from("follow_up_tasks")
      .update({ status: "DONE", completed_at: new Date().toISOString() })
      .eq("id", taskId);
    if (error) {
      await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: `Xəta: ${error.message}`, show_alert: true });
      return { action, ok: false };
    }
    await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: "✅ Tapşırıq tamamlandı!" });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "✅ Tamamlandı", callback_data: `noop_${taskId}` }]] },
      });
    }
    return { action, taskId, ok: true };
  }

  if (action === "task_snooze_3h") {
    const taskId = rest;
    const { data: existing } = await supabase
      .from("follow_up_tasks")
      .select("snooze_count")
      .eq("id", taskId)
      .maybeSingle();
    const nextDue = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("follow_up_tasks")
      .update({
        status: "SNOOZED",
        due_at: nextDue,
        snooze_count: (existing?.snooze_count ?? 0) + 1,
        reminder_sent_at: null,
      })
      .eq("id", taskId);
    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: `⏰ +3 saat təxirə salındı (${formatBakuDateTime(nextDue)})`,
    });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: `⏰ ${formatBakuDateTime(nextDue)}`, callback_data: `noop_${taskId}` },
            { text: "✅ Bitdi", callback_data: `task_done_${taskId}` },
          ]],
        },
      });
    }
    return { action, taskId, nextDue, ok: true };
  }

  if (action === "task_tomorrow") {
    const taskId = rest;
    const { data: existing } = await supabase
      .from("follow_up_tasks")
      .select("snooze_count")
      .eq("id", taskId)
      .maybeSingle();
    const { tomorrow0930Iso } = getBakuDayBounds();
    await supabase
      .from("follow_up_tasks")
      .update({
        status: "SNOOZED",
        due_at: tomorrow0930Iso,
        snooze_count: (existing?.snooze_count ?? 0) + 1,
        reminder_sent_at: null,
      })
      .eq("id", taskId);
    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: `📅 Sabaha keçirildi (${formatBakuDateTime(tomorrow0930Iso)})`,
    });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: `📅 Sabah 09:30`, callback_data: `noop_${taskId}` },
            { text: "✅ Bitdi", callback_data: `task_done_${taskId}` },
          ]],
        },
      });
    }
    return { action, taskId, tomorrow0930Iso, ok: true };
  }

  // 2. Duplicate review callbacks
  if (action === "dup_confirm") {
    const listing = await findListingByIdOrBinaId(supabase, rest);
    if (!listing) {
      await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: "Elan tapılmadı", show_alert: true });
      return { action, ok: false };
    }
    await supabase
      .from("listings")
      .update({
        duplicate_resolution: "CONFIRMED_DUPLICATE",
        editorial_status: "ARCHIVED",
        pipeline_status: "SKIPPED_DUPLICATE",
      })
      .eq("id", listing.id);
    await supabase
      .from("follow_up_tasks")
      .update({
        status: "DONE",
        completed_at: new Date().toISOString(),
        outcome_note: "Confirmed duplicate via Telegram",
      })
      .eq("listing_id", listing.id)
      .eq("entity_type", "DUPLICATE_REVIEW")
      .in("status", ["OPEN", "SNOOZED"]);
    await supabase.from("listing_events").insert({
      listing_id: listing.id,
      event_type: "STATUS_CHANGED",
      old_value_json: { duplicate_resolution: listing.duplicate_resolution, editorial_status: listing.editorial_status },
      new_value_json: { duplicate_resolution: "CONFIRMED_DUPLICATE", editorial_status: "ARCHIVED" },
      actor: "telegram_user",
    });
    await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: "✅ Təkrar kimi təsdiqləndi və arxivləndi." });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "✅ Təkrar Təsdiqləndi (Arxiv)", callback_data: `noop_${listing.bina_id}` }]] },
      });
    }
    return { action, binaId: listing.bina_id, ok: true };
  }

  if (action === "dup_separate") {
    const listing = await findListingByIdOrBinaId(supabase, rest);
    if (!listing) {
      await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: "Elan tapılmadı", show_alert: true });
      return { action, ok: false };
    }
    await supabase
      .from("listings")
      .update({
        duplicate_resolution: "FALSE_POSITIVE",
        duplicate_of_listing_id: null,
        pipeline_status: "QUEUED",
      })
      .eq("id", listing.id);
    const { data: jobRow } = await supabase
      .from("pipeline_jobs")
      .insert({
        idempotency_key: `tg:dup_separate:${listing.bina_id}:${cbId}`,
        job_type: "RENDER_INITIAL",
        listing_id: listing.id,
        trigger_source: "TELEGRAM_WEBHOOK",
        params_json: { telegram_chat_id: String(chatId), telegram_message_id: messageId },
        status: "QUEUED",
      })
      .select("id")
      .maybeSingle();
    await supabase
      .from("follow_up_tasks")
      .update({
        status: "DONE",
        completed_at: new Date().toISOString(),
        outcome_note: "Marked separate apartment & queued render via Telegram",
      })
      .eq("listing_id", listing.id)
      .eq("entity_type", "DUPLICATE_REVIEW")
      .in("status", ["OPEN", "SNOOZED"]);
    await supabase.from("listing_events").insert({
      listing_id: listing.id,
      event_type: "STATUS_CHANGED",
      old_value_json: { duplicate_resolution: listing.duplicate_resolution },
      new_value_json: { duplicate_resolution: "FALSE_POSITIVE", pipeline_status: "QUEUED" },
      triggered_job_id: jobRow?.id ?? null,
      actor: "telegram_user",
    });
    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: "🎬 Ayrı mənzil kimi qeyd edildi — render növbəyə salındı!",
    });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "⏳ Render Növbəyə Salındı", callback_data: `noop_${listing.bina_id}` }]] },
      });
    }
    return { action, binaId: listing.bina_id, jobId: jobRow?.id ?? null, ok: true };
  }

  // 3. Listing editorial & analytics callbacks
  if (action === "keenable") {
    const binaId = rest;
    const listing = await findListingByIdOrBinaId(supabase, binaId);
    const alertText = listing
      ? computeKeenableStats(
          listing.location || "Bakı",
          Number(listing.price_azn_normalized || listing.price || 0),
          Number(listing.area || 0),
        )
      : `📊 #${binaId} elanı bazada tapılmadı.`;
    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: alertText,
      show_alert: true,
    });
    return { action, binaId, ok: true };
  }

  if (action === "publish" || action === "ask_puburl") {
    const binaId = rest;
    const listing = await findListingByIdOrBinaId(supabase, binaId);

    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: "Link daxil etmə tələb olunur 👇",
    });

    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: "⏳ Link Daxil Edilməsi Gözlənilir...", callback_data: `noop_${binaId}` }],
            [{ text: "🌐 Bina.az Elanı", url: listing?.url || `https://bina.az/items/${binaId}` }],
          ],
        },
      });
    }

    if (listing) {
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: generatePublicCaption(listing),
      });
    }

    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: [
        "Zəhmət olmasa, paylaşılan Instagram Reels və ya TikTok video linkini daxil edin:",
        `(Məsələn: <code>/published ${binaId} https://...</code>)`,
      ].join("\n"),
      reply_markup: {
        force_reply: true,
        input_field_placeholder: `/published ${binaId} https://...`,
      },
    });

    return { action, binaId, ok: true };
  }

  if (action === "archive") {
    const binaId = rest;
    const listing = await findListingByIdOrBinaId(supabase, binaId);
    if (listing) {
      await supabase
        .from("listings")
        .update({ editorial_status: "ARCHIVED" })
        .eq("id", listing.id);
      await supabase.from("listing_events").insert({
        listing_id: listing.id,
        event_type: "STATUS_CHANGED",
        old_value_json: { editorial_status: listing.editorial_status },
        new_value_json: { editorial_status: "ARCHIVED" },
        actor: "telegram_user",
      });
    }
    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: "❌ Elan arxivləşdirildi.",
    });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: "❌ Bu Elan Arxivləşdirilib", callback_data: `noop_${binaId}` }]] },
      });
    }
    return { action, binaId, ok: true };
  }

  if (action === "scriptmenu") {
    const binaId = rest;
    await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: "Ssenari bucağını seçin 👇" });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildScriptMenuKeyboard(binaId),
      });
    }
    return { action, binaId, ok: true };
  }

  if (action === "voicemenu") {
    const binaId = rest;
    await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: "Səs mühərrikini seçin 👇" });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildVoiceMenuKeyboard(binaId),
      });
    }
    return { action, binaId, ok: true };
  }

  if (action === "mainmenu") {
    const binaId = rest;
    const listing = await findListingByIdOrBinaId(supabase, binaId);
    await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: "Əsas menyu" });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildMainKeyboard(listing ?? { bina_id: binaId }),
      });
    }
    return { action, binaId, ok: true };
  }

  // 4. Async local-worker render queue callbacks
  if (action === "rerender" || action === "scriptset" || action === "voiceset") {
    let binaId = rest;
    let paramsJson: Record<string, unknown> = {
      telegram_chat_id: String(chatId),
      telegram_message_id: messageId || null,
    };
    let label = "Yenidən Render";

    if (action === "scriptset") {
      const idx = rest.indexOf("_");
      binaId = idx === -1 ? rest : rest.slice(0, idx);
      const angle = idx === -1 ? "family" : rest.slice(idx + 1);
      paramsJson = { ...paramsJson, script_angle: angle, trigger_reason: "SCRIPT_ANGLE" };
      label = `Yeni Ssenari (${angle})`;
    } else if (action === "voiceset") {
      const idx = rest.indexOf("_");
      binaId = idx === -1 ? rest : rest.slice(0, idx);
      const voice = idx === -1 ? "nova" : rest.slice(idx + 1);
      const voiceMap: Record<string, { voice_engine: string; voice_id: string }> = {
        eleven_male: { voice_engine: "elevenlabs", voice_id: "ZQJv3hwvRAIC7fvWZ1Qr" },
        eleven_female: { voice_engine: "elevenlabs", voice_id: "DZaip8UahF0Qri1FxU8M" },
        eleven_arif: { voice_engine: "elevenlabs", voice_id: "ZQJv3hwvRAIC7fvWZ1Qr" },
        eleven_ayan: { voice_engine: "elevenlabs", voice_id: "DZaip8UahF0Qri1FxU8M" },
        nova: { voice_engine: "openai", voice_id: "nova" },
        edge: { voice_engine: "edge", voice_id: "az-AZ-BabekNeural" },
      };
      const resolved = voiceMap[voice] ?? { voice_engine: "openai", voice_id: "nova" };
      paramsJson = {
        ...paramsJson,
        ...resolved,
        voice_choice: voice,
        trigger_reason: "VOICE_SWITCH",
      };
      label = `Yeni Səs (${voice})`;
    } else {
      paramsJson = { ...paramsJson, trigger_reason: "MANUAL_RERENDER" };
    }

    const listing = await findListingByIdOrBinaId(supabase, binaId);
    if (!listing) {
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cbId,
        text: `❌ Elan #${binaId} bazada tapılmadı.`,
        show_alert: true,
      });
      return { action, binaId, ok: false };
    }

    const { data: jobRow, error: jobErr } = await supabase
      .from("pipeline_jobs")
      .insert({
        idempotency_key: `tg:${action}:${binaId}:${cbId}`,
        job_type: "RERENDER",
        listing_id: listing.id,
        trigger_source: "TELEGRAM_WEBHOOK",
        params_json: paramsJson,
        status: "QUEUED",
      })
      .select("id")
      .single();

    if (jobErr) {
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cbId,
        text: `❌ Növbə xətası: ${jobErr.message}`,
        show_alert: true,
      });
      return { action, binaId, ok: false };
    }

    await supabase
      .from("listings")
      .update({ editorial_status: "NEEDS_RERENDER", pipeline_status: "QUEUED" })
      .eq("id", listing.id);

    await tgApi(botToken, "answerCallbackQuery", {
      callback_query_id: cbId,
      text: `⏳ ${label} növbəyə salındı! Lokal PC worker avtomatik icra edəcək.`,
    });
    if (messageId) {
      await tgApi(botToken, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: `⏳ ${label} — Növbədədir...`, callback_data: `noop_${binaId}` }],
            [{ text: "⬅️ Əsas Menyu", callback_data: `mainmenu_${binaId}` }],
          ],
        },
      });
    }
    return { action, binaId, jobId: jobRow?.id ?? null, ok: true };
  }

  // Fallback / noop
  await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cbId, text: "" });
  return { action: "noop", data };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Fail-closed secret token check
  const expectedSecret = (Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "").trim();
  const providedSecret = (req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "").trim();
  if (!expectedSecret || !providedSecret || !timingSafeEqual(expectedSecret, providedSecret)) {
    return new Response(JSON.stringify({ error: "Forbidden: invalid webhook secret" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const allowedChatsRaw = (Deno.env.get("TELEGRAM_CHAT_ID") ?? "").trim();
  const allowedChatIds = new Set(
    allowedChatsRaw.split(",").map((s) => s.trim()).filter(Boolean),
  );
  if (allowedChatIds.size === 0) {
    return new Response(JSON.stringify({ error: "Forbidden: TELEGRAM_CHAT_ID not configured" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const botToken = (Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "").trim();
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (!botToken || !supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Server misconfiguration" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // deno-lint-ignore no-explicit-any
  let update: Record<string, any>;
  try {
    update = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Extract and enforce authorized chat_id.
  // Secret token is already verified above, so return 200 OK ("ignored") for
  // unauthorized chat_ids to prevent Telegram 24h webhook retry storms.
  const incomingChatId = String(
    update.callback_query?.message?.chat?.id ??
      update.message?.chat?.id ??
      update.callback_query?.from?.id ??
      update.chat_id ??
      update.payload?.chat_id ??
      "",
  );
  if (!incomingChatId || !allowedChatIds.has(incomingChatId)) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Support inbound dispatch of social comment lead alert
  if (update.action === "dispatch_social_lead_alert" || update.type === "SOCIAL_COMMENT_ALERT") {
    const payload = (update.payload ?? update) as SocialCommentLeadAlertPayload;
    const sent = await dispatchSocialCommentLeadAlert(botToken, incomingChatId, payload);
    return new Response(JSON.stringify({ ok: sent }), {
      status: sent ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (update.callback_query) {
    const result = await handleCallbackQuery(supabase, botToken, incomingChatId, update.callback_query);
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (update.message?.text) {
    const text = String(update.message.text).trim();

    if (text.startsWith("/published")) {
      const args = text.replace(/^\/published(?:@\S+)?\s*/i, "");
      const res = await handlePublishedCommand(supabase, botToken, incomingChatId, args);
      return new Response(JSON.stringify({ ok: res.ok, command: "/published", result: res }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Direct reply to the bot's ForceReply prompt with just the URL
    if (update.message?.reply_to_message?.text && !text.startsWith("/")) {
      const replyText = String(update.message.reply_to_message.text);
      const match = replyText.match(/(?:#|\/published\s+)(\d{4,})/i);
      if (match && (INSTAGRAM_REEL_REGEX.test(text) || TIKTOK_VIDEO_REGEX.test(text))) {
        const repliedBinaId = match[1];
        const res = await handlePublishedCommand(supabase, botToken, incomingChatId, `${repliedBinaId} ${text}`);
        return new Response(JSON.stringify({ ok: res.ok, command: "/published_reply", result: res }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (text.startsWith("/lead")) {
      const args = text.replace(/^\/lead(?:@\S+)?\s*/i, "");
      await handleLeadCommand(supabase, botToken, incomingChatId, args);
      return new Response(JSON.stringify({ ok: true, command: "/lead" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (text.startsWith("/today")) {
      await handleTodayCommand(supabase, botToken, incomingChatId);
      return new Response(JSON.stringify({ ok: true, command: "/today" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await tgApi(botToken, "sendMessage", {
        chat_id: incomingChatId,
        parse_mode: "HTML",
        text: [
          "👋 <b>BakuEstate-AI 24/7 Bulud CRM Botu</b>",
          "",
          "• <code>/published &lt;bina_id&gt; &lt;url&gt;</code> — Instagram Reels / TikTok linkini bağla və monitorinqi aktivləşdir",
          "• <code>/lead &lt;bina_id&gt; &lt;ad&gt; [telefon] [tarix/qeyd]</code> — 10 saniyəyə müştəri və follow-up əlavə et",
          "• <code>/today</code> — Bugünkü və gecikmiş follow-up siyahısı",
          "• Video kartlarındakı bütün inline düymələr 24/7 işləyir.",
        ].join("\n"),
      });
      return new Response(JSON.stringify({ ok: true, command: "/help" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, ignored: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
