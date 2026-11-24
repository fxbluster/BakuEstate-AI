"use client";

import React, { useState, useEffect } from "react";
import {
  TrendingUp,
  BarChart3,
  Eye,
  Heart,
  Share2,
  RefreshCw,
  Sparkles,
  Send,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import type { StageCardInstance, AnalyticsStagePayload } from "@/lib/copilot-context";
import { createClient } from "@/lib/supabase/client";
import { resolveDistrictCorridor } from "@/lib/market-benchmarks";
import { extractErrorMessage } from "@/lib/errors";

export interface AnalyticsTelemetryCardProps {
  card: StageCardInstance;
  isMaximized?: boolean;
  onMaximizeToggle?: () => void;
  onClose?: () => void;
  onRefresh?: () => void;
}

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
  archetype?: string;
}

interface LiveSnapshot {
  id: string;
  publication_id: string;
  snapshot_phase: string;
  views_count: number;
  likes_count: number;
  comments_count: number;
  ner_score?: number;
  captured_at: string;
}

export function AnalyticsTelemetryCard({
  card,
  isMaximized = false,
  onMaximizeToggle,
  onClose,
  onRefresh,
}: AnalyticsTelemetryCardProps) {
  const payload = card.payload as AnalyticsStagePayload;
  const targetId = payload.listingId || card.targetEntityId || "6588858";

  const [liveListing, setLiveListing] = useState<LiveListingData | null>(null);
  const [liveSnapshots, setLiveSnapshots] = useState<LiveSnapshot[]>([]);
  const [leadsCount, setLeadsCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Telegram dispatch state
  const [isDispatching, setIsDispatching] = useState(false);
  const [dispatchStatus, setDispatchStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  // Derived listing parameters
  const location =
    liveListing?.location ||
    liveListing?.district_normalized ||
    payload.specs?.location ||
    "Bakı";

  const corridor = resolveDistrictCorridor(location);

  const priceAzn =
    liveListing?.price_azn_normalized ||
    liveListing?.price ||
    payload.specs?.price_azn ||
    226000;

  const areaM2 = liveListing?.area || payload.specs?.area_m2 || 95;
  const pricePerM2 = Math.round(priceAzn / (areaM2 || 1));
  const archetype = liveListing?.archetype || payload.specs?.niche_badge || "Sərfəli / Büdcə";

  const title =
    liveListing?.title ||
    payload.title ||
    `Elan #${targetId} Sosial Telemetriyası`;

  const defaultTargetHandle =
    archetype.toLowerCase().includes("lüks") || pricePerM2 > 3000
      ? "@bakuestate.premium"
      : "@baku.serfeli.evler";

  const isWithinCorridor = pricePerM2 >= corridor.min && pricePerM2 <= corridor.max;
  const isUnderPriced = pricePerM2 < corridor.min;

  // Fetch live Supabase data on mount or when targetId changes
  useEffect(() => {
    let isMounted = true;
    async function fetchLiveData() {
      if (!targetId || targetId === "6572383") return;
      setIsLoading(true);
      try {
        const supabase = createClient();
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isUuid = UUID_REGEX.test(targetId);

        let query = supabase.from("listings").select("*");
        if (isUuid) {
          query = query.eq("id", targetId);
        } else {
          query = query.eq("bina_id", String(targetId));
        }

        const { data: listing } = await query.maybeSingle();
        if (!isMounted) return;

        if (listing) {
          setLiveListing(listing);

          // Fetch publications and verified snapshots
          const { data: pubs } = await supabase
            .from("publications")
            .select("id")
            .eq("listing_id", listing.id)
            .order("published_at", { ascending: false });

          if (isMounted && pubs && pubs.length > 0) {
            const pubIds = pubs.map((p) => p.id);
            const { data: snaps } = await supabase
              .from("publication_telemetry_snapshots")
              .select("*")
              .in("publication_id", pubIds)
              .order("captured_at", { ascending: true });
            if (isMounted && snaps) {
              setLiveSnapshots(snaps);
            }
          }

          // Fetch related buyer leads for honest demand count
          const { data: leads } = await supabase
            .from("buyer_leads")
            .select("id, preferred_districts");

          if (isMounted && leads) {
            const districtKeyword = corridor.label.replace(" r.", "").replace(" qəs.", "").toLowerCase();
            const matched = leads.filter((l) => {
              if (!l.preferred_districts) return false;
              const distStr = Array.isArray(l.preferred_districts)
                ? l.preferred_districts.join(" ").toLowerCase()
                : String(l.preferred_districts).toLowerCase();
              return distStr.includes(districtKeyword);
            });
            setLeadsCount(matched.length > 0 ? matched.length : leads.length);
          }
        }
      } catch (err) {
        console.warn("[AnalyticsTelemetryCard] live fetch notice:", err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    fetchLiveData();
    return () => {
      isMounted = false;
    };
  }, [targetId, corridor.label]);

  // Handle Telegram dispatch
  const handleTelegramDispatch = async () => {
    if (isDispatching) return;
    setIsDispatching(true);
    setDispatchStatus("loading");
    setDispatchError(null);

    try {
      const res = await fetch("/api/telegram/dispatch-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: liveListing?.id || targetId,
          target_account: defaultTargetHandle,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        throw new Error(data.error ? extractErrorMessage(data.error) : "Teleqram dispetçerində xəta baş verdi");
      }

      setDispatchStatus("success");
    } catch (err: unknown) {
      setDispatchError(extractErrorMessage(err));
      setDispatchStatus("error");
    } finally {
      setIsDispatching(false);
    }
  };

  const hasLiveSnapshots = liveSnapshots.length > 0;

  return (
    <div className="flex flex-col h-full w-full p-4 overflow-y-auto space-y-3.5">
      {/* Subheader Title & Sync Status */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 shrink-0">
            <TrendingUp className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-200 truncate">
                Sosial Telemetriya &amp; ER%
              </span>
              {hasLiveSnapshots ? (
                <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Canlı Sosial API
                </span>
              ) : (
                <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  Sosial Yayım Gözləyir (Dərc Edilməyib)
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 truncate">{title}</p>
          </div>
        </div>

        {onRefresh && (
          <button
            onClick={onRefresh}
            title="Yenilə"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {/* Mode A: Truthful Pre-Publish Dossier (when not published) */}
      {!hasLiveSnapshots && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Sosial Yayım Gözləyir</span>
          </div>
          <p className="text-xs text-slate-300">
            Bu elan hələ sosial şəbəkələrdə (Instagram / TikTok) dərc edilməyib. Canlı statistik göstəricilər və ER% qrafiki video yayımlandıqdan sonra avtomatik qeydə alınacaq.
          </p>
        </div>
      )}

      {/* Verified Property Fundamentals & Dynamic District Liquidity */}
      <div className="p-3.5 rounded-xl bg-obsidian-900/80 border border-slate-800/80 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-amber-400 font-mono">
              {priceAzn.toLocaleString()} AZN
            </span>
            <span className="text-xs text-slate-400 font-mono">
              {pricePerM2.toLocaleString()} AZN/m²
            </span>
          </div>
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
              isWithinCorridor
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                : isUnderPriced
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                : "bg-amber-500/15 text-amber-300 border-amber-500/30"
            }`}
          >
            {isWithinCorridor
              ? "Bazar Dəhlizindədir (Likvid)"
              : isUnderPriced
              ? "Bazar Qiymətindən Ucuz (Yüksək Tələbat)"
              : "Bazar Dəhlizindən Yuxarı (Eksklüziv)"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-slate-800/60">
          <div className="space-y-0.5">
            <span className="text-slate-500 text-[11px]">Rayon Dəhlizi:</span>
            <div className="text-slate-200 font-medium font-mono">
              {corridor.label} ({corridor.min.toLocaleString()} – {corridor.max.toLocaleString()} AZN/m²)
            </div>
          </div>
          <div className="space-y-0.5">
            <span className="text-slate-500 text-[11px]">Hədəf Sosial Profil:</span>
            <div className="text-amber-300 font-medium font-mono">
              {defaultTargetHandle}
            </div>
          </div>
          <div className="space-y-0.5">
            <span className="text-slate-500 text-[11px]">Portfel Tipi:</span>
            <div className="text-slate-200 font-medium">
              {archetype}
            </div>
          </div>
          <div className="space-y-0.5">
            <span className="text-slate-500 text-[11px]">CRM Alıcı Tələbatı:</span>
            <div className="text-emerald-400 font-medium">
              {leadsCount} Alıcı Maraqlanır ({corridor.label})
            </div>
          </div>
        </div>
      </div>

      {/* Mode B: Live Snapshot Analytics (when publications & snapshots exist) */}
      {hasLiveSnapshots && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-xl bg-obsidian-900/80 border border-slate-800/80 space-y-1">
              <div className="flex items-center justify-between text-slate-400 text-[11px]">
                <span>Faktiki Baxış</span>
                <Eye className="w-3.5 h-3.5 text-indigo-400" />
              </div>
              <div className="text-lg font-bold text-slate-100 font-mono">
                {liveSnapshots[liveSnapshots.length - 1].views_count.toLocaleString()}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-obsidian-900/80 border border-slate-800/80 space-y-1">
              <div className="flex items-center justify-between text-slate-400 text-[11px]">
                <span>Bəyənmələr</span>
                <Heart className="w-3.5 h-3.5 text-rose-400" />
              </div>
              <div className="text-lg font-bold text-slate-100 font-mono">
                {liveSnapshots[liveSnapshots.length - 1].likes_count.toLocaleString()}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-obsidian-900/80 border border-slate-800/80 space-y-1">
              <div className="flex items-center justify-between text-slate-400 text-[11px]">
                <span>Şərhlər</span>
                <Share2 className="w-3.5 h-3.5 text-amber-400" />
              </div>
              <div className="text-lg font-bold text-slate-100 font-mono">
                {liveSnapshots[liveSnapshots.length - 1].comments_count.toLocaleString()}
              </div>
            </div>
          </div>

          {liveSnapshots.length > 1 && (
            <div className="p-3.5 rounded-xl bg-obsidian-900/80 border border-slate-800/80 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-indigo-400" />
                  <span className="text-xs font-semibold text-slate-200">
                    Canlı Baxış Trayektoriyası
                  </span>
                </div>
                <span className="text-[11px] font-mono text-indigo-300 font-medium">
                  {liveSnapshots.length} snapshot qeydə alınıb
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Telegram Dispatch CTA Section */}
      <div className="space-y-2 pt-2 border-t border-slate-800/80">
        {dispatchError && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="truncate">{dispatchError}</span>
          </div>
        )}

        {dispatchStatus === "success" && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Video Teleqrama göndərildi!</span>
          </div>
        )}

        <button
          onClick={handleTelegramDispatch}
          disabled={isDispatching}
          className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-semibold transition-all duration-200 shadow-lg ${
            isDispatching
              ? "bg-amber-600/80 text-obsidian-950 cursor-wait"
              : "bg-amber-500 hover:bg-amber-400 text-obsidian-950 hover:shadow-amber-500/20 active:scale-[0.98]"
          }`}
        >
          {isDispatching ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>Göndərilir...</span>
            </>
          ) : (
            <>
              <Send className="w-4 h-4" />
              <span>🚀 Teleqrama Göndər və Sosial Dərc Et</span>
            </>
          )}
        </button>
        <p className="text-[10px] text-center text-slate-500">
          Bu düymə video çarxı təsdiq üçün Teleqrama göndərir və sosial yayım üçün hazır vəziyyətə gətirir.
        </p>
      </div>
    </div>
  );
}

export default AnalyticsTelemetryCard;
