"use client";

import { useEffect, useState, useRef } from "react";
import {
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  AlertCircle,
  RefreshCw,
  ExternalLink,
  Film,
  Send,
  ShieldAlert,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { formatAzn } from "@/lib/format";
import type { ChannelNiche } from "@/lib/types";
import type { ListingWithLatestRender } from "./ListingsClient";

export interface TargetAccountInfo {
  niche: ChannelNiche;
  handle: string;
  label: string;
  badgeStyle: string;
  textColor: string;
  borderColor: string;
  bgGradient: string;
  dotColor: string;
}

export function resolveTargetAccount(
  listing: ListingWithLatestRender
): TargetAccountInfo {
  let niche: ChannelNiche = "GENERAL";
  let handle = "@bakuestate.official";

  // 1. Check publication if present
  if (listing.publication?.channel_niche) {
    niche = listing.publication.channel_niche;
    handle =
      listing.publication.target_account_handle ||
      (niche === "LUXURY"
        ? "@bakuestate.premium"
        : niche === "AFFORDABLE"
        ? "@baku.serfeli.evler"
        : niche === "TIKTOK"
        ? "@baku_emlak_ai"
        : "@bakuestate.official");
  } else if (listing.publication?.target_account_handle) {
    handle = listing.publication.target_account_handle;
    if (handle.includes("premium")) niche = "LUXURY";
    else if (handle.includes("serfeli")) niche = "AFFORDABLE";
    else if (handle.includes("emlak_ai")) niche = "TIKTOK";
    else niche = "GENERAL";
  } else {
    // 2. Client-side fallback: dynamically derive from price, location, and urgency
    const priceAzn = listing.price_azn_normalized || listing.price || 0;
    const loc = (
      listing.location ||
      listing.district_normalized ||
      listing.address ||
      ""
    ).toLowerCase();
    const isUrgent = Boolean(
      (listing as unknown as { is_urgent?: boolean }).is_urgent
    );
    const priceDropPct = Number(
      (listing as unknown as { price_drop_pct?: number }).price_drop_pct || 0
    );

    const eliteDistricts = [
      "səbail",
      "sabail",
      "nəsimi",
      "nasimi",
      "nərimanov",
      "narimanov",
      "gənclik",
      "ganclik",
      "ağ şəhər",
      "ag seher",
      "badamdar",
      "bilgəh",
      "bilgah",
      "mərdəkan",
      "mardakan",
    ];
    const suburbanDistricts = [
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

    const isElite = eliteDistricts.some((d) => loc.includes(d));
    const isSuburban = suburbanDistricts.some((d) => loc.includes(d));

    if (isUrgent || priceDropPct >= 10.0) {
      niche = "TIKTOK";
      handle = "@baku_emlak_ai";
    } else if (priceAzn >= 250000 || isElite) {
      niche = "LUXURY";
      handle = "@bakuestate.premium";
    } else if ((priceAzn > 0 && priceAzn <= 120000) || isSuburban) {
      niche = "AFFORDABLE";
      handle = "@baku.serfeli.evler";
    } else {
      niche = "GENERAL";
      handle = "@bakuestate.official";
    }
  }

  switch (niche) {
    case "LUXURY":
      return {
        niche,
        handle,
        label: "💎 @bakuestate.premium (LÜKS & MƏRKƏZ)",
        badgeStyle: "bg-amber-500/15 text-amber-300 border-amber-500/40",
        textColor: "text-amber-300",
        borderColor: "border-amber-500/40",
        bgGradient: "from-amber-950/40 via-obsidian-900 to-amber-900/15",
        dotColor: "bg-amber-400",
      };
    case "AFFORDABLE":
      return {
        niche,
        handle,
        label: "🏠 @baku.serfeli.evler (SƏRFƏLİ EVLƏR)",
        badgeStyle: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
        textColor: "text-emerald-300",
        borderColor: "border-emerald-500/40",
        bgGradient: "from-emerald-950/40 via-obsidian-900 to-emerald-900/15",
        dotColor: "bg-emerald-400",
      };
    case "TIKTOK":
      return {
        niche,
        handle,
        label: "🔥 @baku_emlak_ai (VİRAL & ENDİRİM)",
        badgeStyle: "bg-rose-500/15 text-rose-300 border-rose-500/40",
        textColor: "text-rose-300",
        borderColor: "border-rose-500/40",
        bgGradient: "from-rose-950/40 via-obsidian-900 to-rose-900/15",
        dotColor: "bg-rose-400",
      };
    case "GENERAL":
    default:
      return {
        niche,
        handle,
        label: "🏢 @bakuestate.official (RƏSMİ ŞƏBƏKƏ)",
        badgeStyle: "bg-sky-500/15 text-sky-300 border-sky-500/40",
        textColor: "text-sky-300",
        borderColor: "border-sky-500/40",
        bgGradient: "from-sky-950/40 via-obsidian-900 to-sky-900/15",
        dotColor: "bg-sky-400",
      };
  }
}

export type PreflightStatusState =
  | "IDLE"
  | "CHECKING"
  | "PASSED"
  | "PRICE_CHANGED"
  | "REMOVED_ON_BINA"
  | "SCRAPE_FALLBACK_PROMPT"
  | "ERROR";

export interface PreflightResponseData {
  ok: boolean;
  reason?:
    | "PASSED"
    | "PRICE_CHANGED"
    | "REMOVED_ON_BINA"
    | "SCRAPE_ERROR"
    | "ERROR";
  message?: string;
  error?: string;
  can_fallback_to_db?: boolean;
  db_price?: number;
  old_price?: number;
  new_price?: number;
  delta_pct?: number;
  portal_price?: number;
  video_price?: number;
  response_time_ms?: number;
  telegram_message_id?: number | string;
  telegram_url?: string;
  already_dispatched?: boolean;
}

interface PreflightModalProps {
  isOpen: boolean;
  onClose: () => void;
  listing: ListingWithLatestRender | null;
  onListingUpdated?: (updated: ListingWithLatestRender) => void;
}

export function PreflightModal({
  isOpen,
  onClose,
  listing,
  onListingUpdated,
}: PreflightModalProps) {
  const [statusState, setStatusState] = useState<PreflightStatusState>("IDLE");
  const [resultData, setResultData] = useState<PreflightResponseData | null>(
    null
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [isRerendering, setIsRerendering] = useState(false);
  const [rerenderSuccess, setRerenderSuccess] = useState(false);
  const [isDispatchingTelegram, setIsDispatchingTelegram] = useState(false);
  const [telegramSent, setTelegramSent] = useState(false);

  // Guard ref: Prevents duplicate execution and infinite re-render loops
  const lastCheckedListingIdRef = useRef<string | null>(null);

  const runInitialPreflightCheck = async (targetListing: ListingWithLatestRender) => {
    setStatusState("CHECKING");
    setErrorMessage(null);
    setTelegramError(null);
    setResultData(null);
    setRerenderSuccess(false);
    setTelegramSent(false);

    try {
      const res = await fetch(`/api/listings/${targetListing.bina_id}/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: targetListing.id,
          render_version_id: targetListing.latestRender?.id || null,
          dispatch_to_telegram: false, // Verification ONLY - requires explicit user confirmation
        }),
      });

      const data: PreflightResponseData = await res.json().catch(() => ({
        ok: false,
        reason: "ERROR",
        message: "API cavabı oxuna bilmədi (JSON parse xətası).",
      }));

      setResultData(data);

      if (res.ok && data.ok) {
        setStatusState("PASSED");
        if (onListingUpdated) {
          onListingUpdated({
            ...targetListing,
            editorial_status: "APPROVED",
            publication: {
              ...(targetListing.publication || {
                id: "",
                listing_id: targetListing.id,
                render_version_id: targetListing.latestRender?.id || null,
                channel: "INSTAGRAM_REELS",
                post_url: null,
                caption_used: null,
                published_at: null,
                notes: null,
                views_count: 0,
                likes_count: 0,
                comments_count: 0,
                shares_count: 0,
                external_post_id: null,
                telemetry_status: "PENDING",
                last_scraped_at: null,
                next_poll_at: null,
                created_at: new Date().toISOString(),
              }),
              status: "READY_TO_PUBLISH",
              preflight_status: "PASSED",
              verified_at: new Date().toISOString(),
            },
          });
        }
      } else if (data.reason === "PRICE_CHANGED") {
        setStatusState("PRICE_CHANGED");
        if (onListingUpdated) {
          const newPrice = data.new_price ?? targetListing.price_azn_normalized;
          onListingUpdated({
            ...targetListing,
            price: newPrice,
            price_azn_normalized: newPrice,
            editorial_status: "NEEDS_RERENDER",
            publication: targetListing.publication
              ? {
                  ...targetListing.publication,
                  preflight_status: "PRICE_CHANGED",
                  last_preflight_error: `Qiymət dəyişib: ${data.old_price} -> ${data.new_price} AZN`,
                }
              : null,
          });
        }
      } else if (data.reason === "REMOVED_ON_BINA") {
        setStatusState("REMOVED_ON_BINA");
        if (onListingUpdated) {
          onListingUpdated({
            ...targetListing,
            source_availability: "REMOVED_ON_BINA",
            editorial_status: "ARCHIVED",
            publication: targetListing.publication
              ? {
                  ...targetListing.publication,
                  preflight_status: "REMOVED_ON_BINA",
                  status: "ARCHIVED",
                  last_preflight_error: "Elan bina.az-da aktiv deyil",
                }
              : null,
          });
        }
      } else if (data.reason === "SCRAPE_ERROR" || res.status === 502) {
        setStatusState("SCRAPE_FALLBACK_PROMPT");
        setErrorMessage(
          data.message ||
            "bina.az portalı bulud IP-sini blokladı. Canlı qiymət oxuna bilmədi."
        );
      } else {
        setStatusState("ERROR");
        setErrorMessage(
          data.message ||
            data.error ||
            "Pre-flight yoxlaması zamanı server və ya bina.az xətası baş verdi."
        );
      }
    } catch (err) {
      setStatusState("ERROR");
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Pre-flight sorğusu göndərilərkən şəbəkə xətası baş verdi."
      );
    }
  };

  useEffect(() => {
    if (isOpen && listing && lastCheckedListingIdRef.current !== listing.id) {
      lastCheckedListingIdRef.current = listing.id;
      runInitialPreflightCheck(listing);
    }
    if (!isOpen) {
      lastCheckedListingIdRef.current = null;
      setStatusState("IDLE");
      setResultData(null);
      setErrorMessage(null);
      setTelegramError(null);
      setRerenderSuccess(false);
      setTelegramSent(false);
      setIsDispatchingTelegram(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, listing?.id]);

  // Explicit user confirmation to dispatch to Telegram
  async function handleDispatchToTelegram(bypassLiveCheck = false) {
    if (!listing || isDispatchingTelegram || telegramSent) return;
    setIsDispatchingTelegram(true);
    setTelegramError(null);

    try {
      const res = await fetch(`/api/listings/${listing.bina_id}/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: listing.id,
          render_version_id: listing.latestRender?.id || null,
          dispatch_to_telegram: true, // User clicked confirm
          bypass_live_check: bypassLiveCheck,
        }),
      });

      const data: PreflightResponseData = await res.json().catch(() => ({
        ok: false,
        reason: "ERROR",
        message: "Telegram göndəriş cavabı oxuna bilmədi.",
      }));

      if (res.ok && data.ok) {
        setTelegramSent(true);
        setStatusState("PASSED");
        if (data.telegram_message_id) {
          setResultData((prev) => (prev ? { ...prev, telegram_message_id: data.telegram_message_id } : data));
        }

        if (onListingUpdated) {
          onListingUpdated({
            ...listing,
            publication: {
              ...(listing.publication || {
                id: "",
                listing_id: listing.id,
                render_version_id: listing.latestRender?.id || null,
                channel: "INSTAGRAM_REELS",
                post_url: null,
                caption_used: null,
                published_at: null,
                notes: null,
                views_count: 0,
                likes_count: 0,
                comments_count: 0,
                shares_count: 0,
                external_post_id: null,
                telemetry_status: "PENDING",
                last_scraped_at: null,
                next_poll_at: null,
                created_at: new Date().toISOString(),
              }),
              status: "READY_TO_PUBLISH",
              preflight_status: "PASSED",
              telegram_dispatched_at: new Date().toISOString(),
              telegram_message_id: data.telegram_message_id || null,
            },
          });
        }
      } else {
        setTelegramError(
          data.message || data.error || "Telegram-a göndərilərkən xəta baş verdi."
        );
      }
    } catch (err) {
      setTelegramError(
        err instanceof Error
          ? err.message
          : "Telegram sorğusunda şəbəkə xətası baş verdi."
      );
    } finally {
      setIsDispatchingTelegram(false);
    }
  }

  async function handleRerenderPriceDrop() {
    if (!listing) return;
    setIsRerendering(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const oldPrice = resultData?.old_price ?? listing.price_azn_normalized;
      const newPrice =
        resultData?.new_price ??
        resultData?.portal_price ??
        listing.price_azn_normalized;
      const deltaPct = resultData?.delta_pct ?? 0;

      const idempotencyKey = `rerender_price_${listing.id}_${Date.now()}`;

      // Insert RENDER_PRICE_DROP job into pipeline_jobs
      const { error: jobErr } = await supabase.from("pipeline_jobs").insert({
        idempotency_key: idempotencyKey,
        job_type: "RENDER_PRICE_DROP",
        listing_id: listing.id,
        trigger_source: "WEB_UI",
        params_json: {
          listing_id: listing.id,
          bina_id: listing.bina_id,
          old_price: oldPrice,
          new_price: newPrice,
          delta_pct: deltaPct,
        },
        status: "QUEUED",
      });

      if (jobErr) throw jobErr;

      // Update listing state to reflect rerender queued
      await supabase
        .from("listings")
        .update({
          editorial_status: "NEEDS_RERENDER",
          price: newPrice,
          price_azn_normalized: newPrice,
        })
        .eq("id", listing.id);

      // Audit event
      await supabase.from("listing_events").insert({
        listing_id: listing.id,
        event_type: "PRICE_CHANGED",
        old_value_json: { price_azn_normalized: oldPrice },
        new_value_json: {
          price_azn_normalized: newPrice,
          delta_pct: deltaPct,
        },
        price_delta_pct: deltaPct,
        actor: "web_user",
      });

      setRerenderSuccess(true);

      if (onListingUpdated) {
        onListingUpdated({
          ...listing,
          price: newPrice,
          price_azn_normalized: newPrice,
          editorial_status: "NEEDS_RERENDER",
        });
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Yeni render növbəsinə əlavə edilərkən xəta baş verdi."
      );
    } finally {
      setIsRerendering(false);
    }
  }

  if (!isOpen || !listing) return null;

  const targetAccount = resolveTargetAccount(listing);
  const oldPriceVal = resultData?.old_price ?? listing.price_azn_normalized;
  const newPriceVal =
    resultData?.new_price ??
    resultData?.portal_price ??
    listing.price_azn_normalized;
  const deltaPctVal = resultData?.delta_pct ?? 0;
  const telegramUrl =
    resultData?.telegram_url || "https://web.telegram.org";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-obsidian-950/85 p-4 backdrop-blur-md">
      <div className="exec-card relative w-full max-w-lg p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150 border-slate-800/90 bg-obsidian-900/95 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-800/80 pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-gold-400">
              Pre-Flight Yoxlanılma & Telegram Göndərişi
            </p>
            <h3 className="mt-1 text-lg font-bold text-slate-100 flex items-center gap-2 flex-wrap">
              <span>Elan #{listing.bina_id}</span>
              {listing.latestRender && (
                <span className="rounded-md bg-obsidian-950 px-2 py-0.5 text-xs font-mono text-slate-400 border border-slate-800">
                  v{listing.latestRender.version_num}
                </span>
              )}
              {targetAccount && (
                <span
                  className={`rounded-md px-2 py-0.5 text-[11px] font-semibold border ${targetAccount.badgeStyle}`}
                >
                  {targetAccount.handle}
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">
              {listing.title || listing.address || "Bakı"} •{" "}
              {formatAzn(listing.price_azn_normalized)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-obsidian-850 hover:text-slate-200 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* State 1: CHECKING */}
        {statusState === "CHECKING" && (
          <div className="py-8 flex flex-col items-center justify-center text-center space-y-4">
            <div className="relative flex items-center justify-center">
              <div className="absolute h-16 w-16 rounded-full bg-gold-500/20 animate-ping" />
              <div className="h-14 w-14 rounded-full bg-obsidian-950 border border-gold-500/40 flex items-center justify-center shadow-lg">
                <Loader2 className="h-7 w-7 text-gold-400 animate-spin" />
              </div>
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-slate-100">
                bina.az-da elanın statusu və qiyməti canlı yoxlanılır...
              </h4>
              <p className="text-xs text-slate-400 max-w-sm">
                Portalın liveness statusu (aktivlik) və cari AZN qiyməti
                videodakı məlumatla birbaşa müqayisə edilir.
              </p>
            </div>
          </div>
        )}

        {/* State 2: PASSED (Verified, Explicit Confirmation for Telegram Dispatch) */}
        {statusState === "PASSED" && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-5 space-y-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-emerald-500/20 border border-emerald-500/50 flex items-center justify-center flex-shrink-0">
                  <CheckCircle2 className="h-6 w-6 text-emerald-400" />
                </div>
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold text-emerald-300 border border-emerald-500/40">
                    {telegramSent
                      ? "🚀 Telegram-a Göndərildi"
                      : "✅ Elan Aktivdir və Qiymət Təsdiqləndi"}
                  </span>
                  <p className="mt-1 text-sm font-medium text-emerald-200 leading-snug">
                    {telegramSent
                      ? "Video və 1-toxunuşla kopyalanan elan mətni Telegram CRM kanalına uğurla çatdırıldı!"
                      : `bina.az-da elan aktivdir və cari portal qiyməti (${formatAzn(resultData?.portal_price || listing.price_azn_normalized)}) videodakı qiymətlə tam uyğundur.`}
                  </p>
                </div>
              </div>

              <div className="mt-2 pt-3 border-t border-emerald-500/20 flex items-center justify-between text-xs text-emerald-300/90">
                <span>bina.az Portal Qiyməti:</span>
                <span className="font-bold font-mono text-emerald-200">
                  {formatAzn(resultData?.portal_price || listing.price_azn_normalized)}
                </span>
              </div>
            </div>

            {telegramError && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0" />
                <span>{telegramError}</span>
              </div>
            )}

            {/* Prominent Color-Coded Target Account Pill */}
            {targetAccount && (
              <div
                className={`rounded-2xl border ${targetAccount.borderColor} bg-gradient-to-r ${targetAccount.bgGradient} p-4 space-y-2.5 transition-all shadow-md`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-2.5 w-2.5 rounded-full ${targetAccount.dotColor} animate-pulse`}
                    />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                      🎯 Paylaşılacaq Hədəf Hesab (Niş)
                    </span>
                  </div>
                  <span
                    className={`rounded-lg border px-2.5 py-0.5 text-xs font-mono font-bold ${targetAccount.badgeStyle}`}
                  >
                    {targetAccount.handle}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-slate-800/80">
                  <span
                    className={`text-sm font-extrabold ${targetAccount.textColor}`}
                  >
                    {targetAccount.label}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {listing.publication?.channel_niche
                      ? "Baza yönləndirilməsi"
                      : "Dinamik təyin olunub"}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="exec-btn-secondary text-xs"
              >
                Bağla
              </button>
              {telegramSent ? (
                <a
                  href={telegramUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-xs font-bold text-slate-950 shadow-sm transition hover:brightness-110 active:scale-[0.99]"
                >
                  <span>🚀 Telegram-da Aç</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : (
                <button
                  type="button"
                  disabled={isDispatchingTelegram}
                  onClick={() => handleDispatchToTelegram(false)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-xs font-bold text-slate-950 shadow-sm transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
                >
                  {isDispatchingTelegram ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Telegram-a Göndərilir...</span>
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      <span>🚀 Təsdiqlə və Telegram-a Göndər</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* State 3: PRICE_CHANGED */}
        {statusState === "PRICE_CHANGED" && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <AlertTriangle className="h-6 w-6 text-amber-400" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold text-amber-300 border border-amber-500/40">
                    ⚠️ Qiymət Dəyişib
                  </span>
                  <p className="text-sm font-medium text-amber-100 leading-snug">
                    ⚠️ Diqqət: Qiymət dəyişib! Əvvəlki:{" "}
                    <span className="font-bold underline">
                      {formatAzn(oldPriceVal)}
                    </span>{" "}
                    -&gt; İndiki:{" "}
                    <span className="font-bold underline text-gold-300">
                      {formatAzn(newPriceVal)}
                    </span>{" "}
                    ({deltaPctVal > 0 ? `+${deltaPctVal}` : deltaPctVal}%).
                    Videoda köhnə qiymət qaldığı üçün göndəriş dayandırıldı.
                  </p>
                </div>
              </div>

              {rerenderSuccess ? (
                <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/15 p-3 text-xs text-emerald-200 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 flex-shrink-0" />
                  <span>
                    🎬 Yeni qiymətlə ({formatAzn(newPriceVal)}) render
                    növbəsinə salındı! Bitdikdə yenidən yoxlaya bilərsiniz.
                  </span>
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="exec-btn-secondary text-xs"
              >
                Bağla
              </button>
              {!rerenderSuccess && (
                <button
                  type="button"
                  disabled={isRerendering}
                  onClick={handleRerenderPriceDrop}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-gold-400 px-4 py-2 text-xs font-bold text-obsidian-950 shadow-sm transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
                >
                  <Film className="h-3.5 w-3.5" />
                  <span>
                    {isRerendering
                      ? "Növbəyə salınır..."
                      : "🎬 Yeni Qiymətlə Təkrar Render Et"}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* State 4: REMOVED_ON_BINA */}
        {statusState === "REMOVED_ON_BINA" && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-full bg-rose-500/20 border border-rose-500/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <XCircle className="h-6 w-6 text-rose-400" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/20 px-2.5 py-0.5 text-xs font-semibold text-rose-300 border border-rose-500/40">
                    ❌ bina.az-da Silinib
                  </span>
                  <p className="text-sm font-medium text-rose-200 leading-snug">
                    ❌ Bu elan artıq bina.az-da aktiv deyil (silinib və ya
                    satılıb). Paylaşılması bloklandı və elan arxivləşdirildi.
                  </p>
                  <p className="text-xs text-rose-300/80">
                    Mənzil artıq bazarda deyil. Bu elan üçün video paylaşımı ləğv
                    edildi.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="exec-btn-secondary text-xs"
              >
                Bağla
              </button>
            </div>
          </div>
        )}

        {/* State 5: SCRAPE_FALLBACK_PROMPT (Amber Cloud IP Block Recovery) */}
        {statusState === "SCRAPE_FALLBACK_PROMPT" && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <ShieldAlert className="h-6 w-6 text-amber-400" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold text-amber-300 border border-amber-500/40">
                    ⚠️ Bulud Bloklaması (502 Scrape Error)
                  </span>
                  <p className="text-sm font-medium text-amber-200 leading-snug">
                    bina.az portalı bulud server IP-sini blokladığı üçün canlı qiymət oxuna bilmədi.
                  </p>
                  <p className="text-xs text-amber-300/80">
                    Bazadakı təsdiqlənmiş qiymətlə ({formatAzn(resultData?.db_price || listing.price_azn_normalized || listing.price)}) davam etmək və Teleqrama göndərmək istəyirsiniz?
                  </p>
                </div>
              </div>

              {telegramError && (
                <div className="mt-2 rounded-xl border border-rose-500/40 bg-rose-500/20 p-2.5 text-xs text-rose-200 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0" />
                  <span>{telegramError}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="exec-btn-secondary text-xs"
              >
                Ləğv Et
              </button>
              <button
                type="button"
                onClick={() => {
                  if (listing) runInitialPreflightCheck(listing);
                }}
                className="exec-btn-secondary text-xs inline-flex items-center gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Yenidən Yoxla</span>
              </button>
              {(listing.price_azn_normalized || listing.price) && (
                <button
                  type="button"
                  disabled={isDispatchingTelegram}
                  onClick={() => handleDispatchToTelegram(true)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-obsidian-950 px-3.5 py-2 text-xs font-bold shadow-md hover:brightness-110 active:scale-[0.99] transition disabled:opacity-50"
                >
                  {isDispatchingTelegram ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Göndərilir...</span>
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      <span>
                        🛡️ Bazadakı Qiymətlə Göndər ({formatAzn(resultData?.db_price || listing.price_azn_normalized || listing.price)})
                      </span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* State 6: ERROR */}
        {statusState === "ERROR" && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-full bg-rose-500/20 border border-rose-500/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <AlertCircle className="h-6 w-6 text-rose-400" />
                </div>
                <div className="space-y-1.5 flex-1">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/20 px-2.5 py-0.5 text-xs font-semibold text-rose-300 border border-rose-500/40">
                    Pre-Flight Xətası
                  </span>
                  <p className="text-sm font-medium text-rose-200">
                    {errorMessage ||
                      "bina.az portalına qoşularkən xəta baş verdi və ya şəbəkə vaxtı bitdi."}
                  </p>
                  <p className="text-xs text-rose-300/80">
                    Bulud IP bloklaması zamanı yerli worker (local_worker.py) işə sala və ya bazadakı təsdiqlənmiş qiymətlə birbaşa davam edə bilərsiniz.
                  </p>
                </div>
              </div>

              {telegramError && (
                <div className="mt-2 rounded-xl border border-rose-500/40 bg-rose-500/20 p-2.5 text-xs text-rose-200 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0" />
                  <span>{telegramError}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="exec-btn-secondary text-xs"
              >
                Bağla
              </button>
              <button
                type="button"
                onClick={() => {
                  if (listing) runInitialPreflightCheck(listing);
                }}
                className="exec-btn-danger text-xs inline-flex items-center gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Yenidən Yoxla</span>
              </button>
              {(listing.price_azn_normalized || listing.price) && (
                <button
                  type="button"
                  disabled={isDispatchingTelegram}
                  onClick={() => handleDispatchToTelegram(true)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white px-3.5 py-2 text-xs font-bold shadow-md hover:brightness-110 active:scale-[0.99] transition disabled:opacity-50"
                >
                  {isDispatchingTelegram ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Telegram-a Göndərilir...</span>
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      <span>
                        🛡️ Baza Qiyməti ilə Göndər ({formatAzn(listing.price_azn_normalized || listing.price)})
                      </span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
