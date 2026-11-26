"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  Send,
  Play,
  Pause,
  RefreshCw,
  Film,
  Building,
  CheckCircle2,
  Clock,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Volume2,
} from "lucide-react";
import type { StageCardInstance, VideoStagePayload } from "@/lib/copilot-context";
import { resolveClientVideoSrc } from "@/lib/r2-media-client";
import { useCopilot } from "@/lib/copilot-context";
import { createClient } from "@/lib/supabase/client";
import { extractErrorMessage } from "@/lib/errors";
import { resolveCanonicalListingNiche } from "@/lib/niche-router";

interface LiveListingData {
  id?: string;
  bina_id?: string | number;
  title?: string;
  price?: number;
  price_azn_normalized?: number;
  rooms?: number;
  area?: number;
  location?: string;
  district_normalized?: string;
  address?: string;
  archetype?: string;
  canonical_niche?: string;
  photo_urls?: string[];
}

interface LiveRenderData {
  id?: string;
  listing_id?: string;
  version_num?: number;
  status?: string;
  video_cdn_url?: string | null;
  voice_engine?: string | null;
  duration_seconds?: number | null;
}

export interface VideoPipelineCardProps {
  card: StageCardInstance;
  isMaximized?: boolean;
  onMaximizeToggle?: () => void;
  onClose?: () => void;
  onRefresh?: () => void;
}

export function VideoPipelineCard({
  card,
  isMaximized = false,
  onMaximizeToggle,
  onClose,
  onRefresh,
}: VideoPipelineCardProps) {
  const { updateStageCardPayload } = useCopilot();
  const payload = card.payload as VideoStagePayload;

  // Derive specs without hardcoded demo fallbacks
  const listingId = payload.listingId || card.targetEntityId || "";
  const binaId = payload.binaId || payload.specs?.bina_id || listingId;

  // Live Supabase sync for actual listing specs & rendered videos
  const [liveListing, setLiveListing] = useState<LiveListingData | null>(null);
  const [liveRender, setLiveRender] = useState<LiveRenderData | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadData() {
      const idToSearch = binaId || listingId;
      if (!idToSearch) return;
      try {
        const supabase = createClient();
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isUuid = UUID_REGEX.test(idToSearch);

        let query = supabase.from("listings").select("*");
        if (isUuid) {
          query = query.eq("id", idToSearch);
        } else {
          query = query.eq("bina_id", String(idToSearch));
        }

        const { data: listing } = await query.maybeSingle();
        if (!isMounted) return;

        if (listing) {
          setLiveListing(listing);
          const { data: renders } = await supabase
            .from("render_versions")
            .select("*")
            .eq("listing_id", listing.id)
            .order("version_num", { ascending: false });

          if (isMounted && renders && renders.length > 0) {
            const completed = renders.find((r) => r.status === "COMPLETED" && r.video_cdn_url);
            setLiveRender(completed || renders[0]);
          }
        }
      } catch (err) {
        console.warn("[VideoPipelineCard] live data fetch notice:", err);
      }
    }
    loadData();
    return () => {
      isMounted = false;
    };
  }, [binaId, listingId]);

  const isRendered =
    liveRender?.status === "COMPLETED" && liveRender?.video_cdn_url
      ? true
      : payload.isRendered ?? Boolean(payload.videoCdnUrl);

  const rawVideoCdnUrl =
    liveRender?.status === "COMPLETED" && liveRender?.video_cdn_url
      ? liveRender.video_cdn_url
      : payload.videoCdnUrl || null;

  const videoCdnUrl =
    resolveClientVideoSrc({
      id: liveRender?.id ?? payload.renderVersionId ?? null,
      video_cdn_url: rawVideoCdnUrl,
      storage_pruned_at: null,
    }) ?? rawVideoCdnUrl;

  const title =
    liveListing?.title ||
    payload.title ||
    (binaId ? `Elan #${binaId}` : "Elan təfərrüatları");

  const priceAzn =
    liveListing?.price_azn_normalized ||
    liveListing?.price ||
    payload.priceAzn ||
    payload.specs?.price_azn ||
    0;

  const rooms =
    liveListing?.rooms ??
    payload.rooms ??
    payload.specs?.rooms ??
    null;

  const areaM2 =
    liveListing?.area ??
    payload.areaM2 ??
    payload.specs?.area_m2 ??
    0;

  const location =
    liveListing?.location ||
    liveListing?.address ||
    payload.location ||
    payload.specs?.location ||
    "Bakı";

  const canonicalNiche = resolveCanonicalListingNiche({
    price_azn_normalized: priceAzn,
    location,
    district_normalized: liveListing?.district_normalized,
    canonical_niche: liveListing?.canonical_niche,
  });

  const nicheBadge =
    payload.nicheBadge || payload.specs?.niche_badge || canonicalNiche.label;

  const targetAccount = payload.targetAccount || canonicalNiche.handle;

  // Gallery state for unrendered cards
  const displayPhotos =
    liveListing?.photo_urls && liveListing.photo_urls.length > 0
      ? liveListing.photo_urls
      : payload.photos && payload.photos.length > 0
        ? payload.photos
        : [];
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);

  // Video playback state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Telegram dispatch state
  const [isDispatching, setIsDispatching] = useState(false);
  const [dispatchStatus, setDispatchStatus] = useState<"idle" | "loading" | "success" | "queued" | "error">("idle");
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Render queue state
  const [isQueueing, setIsQueueing] = useState(false);
  const [queueStatus, setQueueStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueSuccessMsg, setQueueSuccessMsg] = useState<string | null>(null);

  // Cooldown countdown effect
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setInterval(() => {
      setCooldownSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownSeconds]);

  // Video play/pause toggle
  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  // Telegram dispatch handler
  const handleTelegramDispatch = async () => {
    if (cooldownSeconds > 0 || isDispatching) return;
    setIsDispatching(true);
    setDispatchStatus("loading");
    setDispatchError(null);

    try {
      const res = await fetch("/api/telegram/dispatch-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: liveListing?.id || listingId,
          render_version_id: liveRender?.id || payload.renderVersionId,
          target_account: targetAccount,
          custom_caption: payload.caption,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        throw new Error(data.error ? extractErrorMessage(data.error) : "Teleqram dispetçerində xəta baş verdi");
      }

      if (data.dispatch_mode === "QUEUED_WORKER") {
        setDispatchStatus("queued");
      } else {
        setDispatchStatus("success");
      }
      setCooldownSeconds(15);
    } catch (err: unknown) {
      setDispatchError(extractErrorMessage(err));
      setDispatchStatus("error");
    } finally {
      setIsDispatching(false);
    }
  };

  // Queue render handler
  const handleQueueRender = async () => {
    if (isQueueing) return;
    setIsQueueing(true);
    setQueueStatus("loading");
    setQueueError(null);

    try {
      const res = await fetch("/api/pipeline/queue-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: listingId,
          bina_id: binaId,
          target_account: targetAccount,
          voice_preset: "Arif",
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        throw new Error(data.error ? extractErrorMessage(data.error) : "Montaj növbəsinə əlavə edilərkən xəta baş verdi");
      }

      setQueueSuccessMsg(
        typeof data.message === "string" && data.message
          ? data.message
          : "Montaj növbəsinə əlavə edildi! Lokal Worker icra edəcək."
      );
      setQueueStatus("success");
      updateStageCardPayload(card.id, {
        isRendered: false,
      });
    } catch (err: unknown) {
      setQueueError(extractErrorMessage(err));
      setQueueStatus("error");
    } finally {
      setIsQueueing(false);
    }
  };

  return (
    <div className="flex flex-col h-full w-full p-3.5 overflow-y-auto">
      {isRendered ? (
        /* Rendered State: Adaptive 2-Column Horizontal Split (580x510) */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 h-full">
          {/* 9:16 Video Player Container */}
          <div
            className={`relative flex items-center justify-center bg-black/80 rounded-xl overflow-hidden border border-slate-800 group aspect-[9/16] ${
              isMaximized ? "max-h-[640px] max-w-[360px]" : "max-h-[440px] max-w-[250px]"
            } mx-auto w-full transition-all duration-300 shadow-xl`}
          >
            {videoCdnUrl ? (
              <video
                ref={videoRef}
                src={videoCdnUrl}
                playsInline
                loop
                className="w-full h-full object-cover"
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
            ) : (
              <div className="flex flex-col items-center justify-center p-4 text-center text-slate-500">
                <Film className="w-10 h-10 mb-2 opacity-50" />
                <span className="text-xs">Video axını tapılmadı</span>
              </div>
            )}

            {/* Play/Pause Overlay Button */}
            <button
              onClick={togglePlay}
              className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors"
            >
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-amber-500/90 text-obsidian-950 shadow-lg hover:scale-110 transition-transform">
                {isPlaying ? (
                  <Pause className="w-6 h-6 fill-current" />
                ) : (
                  <Play className="w-6 h-6 fill-current translate-x-0.5" />
                )}
              </div>
            </button>

            {/* Resolution Tag */}
            <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-sm text-[10px] font-mono text-amber-300 border border-amber-500/30">
              1080 × 1920 MP4
            </div>
          </div>

          {/* Video Specs & Dispatch Controls */}
          <div className="flex flex-col justify-between space-y-3">
            <div className="space-y-2.5">
              {/* Header Badges & Title */}
              <div>
                <div className="flex items-center gap-1.5 flex-wrap mb-1">
                  <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                    {nicheBadge}
                  </span>
                  <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-slate-800 text-slate-300 border border-slate-700">
                    {targetAccount}
                  </span>
                  {liveRender && (
                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      v{liveRender.version_num} • {liveRender.status === "COMPLETED" ? "Hazır" : liveRender.status}
                    </span>
                  )}
                </div>
                <h3 className="text-xs font-semibold text-slate-200 line-clamp-1">{title}</h3>
              </div>

              {/* Pricing & Key Specs */}
              <div className="p-3 rounded-xl bg-obsidian-900/80 border border-slate-800/80 space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-bold text-amber-400 font-mono">
                    {priceAzn > 0 ? `${priceAzn.toLocaleString()} AZN` : "Qiymət gözlənilir"}
                  </span>
                  {priceAzn > 0 && areaM2 > 0 && (
                    <span className="text-xs text-slate-400">
                      {Math.round(priceAzn / areaM2).toLocaleString()} AZN/m²
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-slate-800/60">
                  <div className="text-slate-300">
                    <span className="text-slate-500">Otaq:</span> {rooms ? `${rooms} otaqlı` : "—"}
                  </div>
                  <div className="text-slate-300">
                    <span className="text-slate-500">Sahə:</span> {areaM2 > 0 ? `${areaM2} m²` : "—"}
                  </div>
                  <div className="text-slate-300 col-span-2 flex items-center gap-1">
                    <Building className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span className="truncate">{location}</span>
                  </div>
                </div>
              </div>

              {/* Pipeline Render Specs */}
              <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/60 space-y-1.5 text-xs">
                <div className="flex items-center justify-between text-slate-400">
                  <span>Səs Mühərriki:</span>
                  <span className="text-slate-200 font-medium flex items-center gap-1">
                    <Volume2 className="w-3.5 h-3.5 text-amber-400" />{" "}
                    {liveRender?.voice_engine || "Dinamik TTS (AZE)"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-400">
                  <span>Kinetik Subtitrlər:</span>
                  <span className="text-emerald-400 font-medium">Aktiv (Sarı vurğu)</span>
                </div>
                <div className="flex items-center justify-between text-slate-400">
                  <span>Hədəf Profil:</span>
                  <span className="text-amber-300 font-medium">{targetAccount}</span>
                </div>
              </div>
            </div>

            {/* Telegram Dispatch Action Section */}
            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              {dispatchError && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="truncate">{dispatchError}</span>
                </div>
              )}

              {dispatchStatus === "success" && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>Video Teleqrama göndərildi!</span>
                </div>
              )}

              {dispatchStatus === "queued" && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-300 text-xs">
                  <Clock className="w-4 h-4 shrink-0" />
                  <span>Fayl &gt;20MB olduğu üçün arxa plan işçisinə növbələndi.</span>
                </div>
              )}

              <button
                onClick={handleTelegramDispatch}
                disabled={isDispatching || cooldownSeconds > 0}
                className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all duration-200 shadow-lg ${
                  cooldownSeconds > 0
                    ? "bg-slate-800 text-slate-400 cursor-not-allowed"
                    : isDispatching
                    ? "bg-amber-600/80 text-obsidian-950 cursor-wait"
                    : "bg-amber-500 hover:bg-amber-400 text-obsidian-950 hover:shadow-amber-500/20 active:scale-[0.98]"
                }`}
              >
                {isDispatching ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Göndərilir...</span>
                  </>
                ) : cooldownSeconds > 0 ? (
                  <>
                    <Clock className="w-4 h-4" />
                    <span>{cooldownSeconds}s sonra yenidən göndər</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    <span>✈️ Teleqramıma Göndər</span>
                  </>
                )}
              </button>
              <p className="text-[10px] text-center text-slate-500">
                Şəxsi Teleqram çatınıza video + Reels mətni və heşteqlər birbaşa ötürüləcək.
              </p>
            </div>
          </div>
        </div>
      ) : (
        /* Unrendered State: Compact Stacked Layout (480x540) */
        <div className="space-y-3">
          {/* Status Warning Badge */}
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-center gap-2 text-xs text-amber-300">
              <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
              <span>Bu elanın Reels videosu hələ montaj edilməyib.</span>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              Montaj Gözləyir
            </span>
          </div>

          {/* Photo Carousel / Preview (16:9) */}
          <div className="relative aspect-video rounded-xl overflow-hidden bg-black/60 border border-slate-800 max-h-[220px]">
            {displayPhotos.length > 0 ? (
              <img
                src={displayPhotos[activePhotoIdx]}
                alt={`Elan ${binaId || ""} foto ${activePhotoIdx + 1}`}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-1">
                <Film className="w-8 h-8 opacity-40" />
                <span className="text-xs">Foto mövcud deyil</span>
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />

            {/* Prev/Next buttons */}
            {displayPhotos.length > 1 && (
              <>
                <button
                  onClick={() =>
                    setActivePhotoIdx((prev) => (prev > 0 ? prev - 1 : displayPhotos.length - 1))
                  }
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() =>
                    setActivePhotoIdx((prev) => (prev < displayPhotos.length - 1 ? prev + 1 : 0))
                  }
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </>
            )}

            {/* Counter Pill */}
            {displayPhotos.length > 0 && (
              <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/70 text-[10px] text-slate-300 backdrop-blur-sm border border-slate-700">
                {activePhotoIdx + 1} / {displayPhotos.length}
              </div>
            )}
          </div>

          {/* Thumbnail Strip */}
          {displayPhotos.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {displayPhotos.map((photo, i) => (
                <button
                  key={i}
                  onClick={() => setActivePhotoIdx(i)}
                  className={`relative w-14 h-10 rounded-lg overflow-hidden shrink-0 border-2 transition-all ${
                    activePhotoIdx === i
                      ? "border-amber-400 scale-105"
                      : "border-transparent opacity-60 hover:opacity-100"
                  }`}
                >
                  <img src={photo} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}

          {/* Specs Summary */}
          <div className="p-2.5 rounded-xl bg-obsidian-900/80 border border-slate-800/80 space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-base font-bold text-amber-400 font-mono">
                {priceAzn > 0 ? `${priceAzn.toLocaleString()} AZN` : "Qiymət gözlənilir"}
              </span>
              <span className="text-xs text-slate-400">
                {rooms ? `${rooms} otaqlı` : "—"} • {areaM2 > 0 ? `${areaM2} m²` : "—"}
              </span>
            </div>
            <p className="text-xs text-slate-300 flex items-center gap-1.5">
              <Building className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              {location}
            </p>
          </div>

          {/* Queue Action Button */}
          <div className="space-y-2">
            {queueError && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span className="truncate">{queueError}</span>
              </div>
            )}

            {queueStatus === "success" && (
              <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span className="truncate">
                    {queueSuccessMsg || "Montaj növbəsinə əlavə edildi! İşçi icra edəcək."}
                  </span>
                </div>
                <Link
                  href="/jobs?tab=worker"
                  className="shrink-0 font-semibold text-gold-300 hover:underline"
                >
                  İzlə →
                </Link>
              </div>
            )}

            <button
              onClick={handleQueueRender}
              disabled={isQueueing || queueStatus === "success"}
              className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-semibold transition-all duration-200 shadow-lg ${
                queueStatus === "success"
                  ? "bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 cursor-default"
                  : isQueueing
                  ? "bg-amber-600/80 text-obsidian-950 cursor-wait"
                  : "bg-amber-500 hover:bg-amber-400 text-obsidian-950 hover:shadow-amber-500/20 active:scale-[0.98]"
              }`}
            >
              {isQueueing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Növbəyə Əlavə Edilir...</span>
                </>
              ) : queueStatus === "success" ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>⏳ Növbəyə Əlavə Edildi</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>🚀 Montaj Boru Xəttinə Göndər</span>
                </>
              )}
            </button>
            <p className="text-[10px] text-center text-slate-500">
              Avtomatik olaraq səsləndirmə, FFmpeg vizual kompozisiyası və kinetik subtitrlər hazırlanacaq.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
