"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Sparkles,
  ShieldAlert,
  MessageCircle,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Flame,
  Clock,
  Radio,
  Zap,
  RefreshCw,
  Bot,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { CockpitCard } from "@/lib/types";
import { formatRelativeAz } from "@/lib/format";
import { computeTriagedRadar } from "@/lib/copilot-core";
import { invokeCopilot, StrategistCockpitResult } from "@/lib/ai-client";
import { useCopilot } from "@/lib/copilot-context";

interface RawTopCard {
  lead_id?: string | null;
  listing_id?: string | null;
  channel?: string | null;
  priority?: string | null;
  headline?: string | null;
  draft_text?: string | null;
  reason?: string | null;
  sentinel_warning?: string | null;
  status?: string | null;
  target_uri?: string | null;
  strategic_rationale?: string | null;
}

export function CockpitCardHUD() {
  const [cards, setCards] = useState<CockpitCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { openAgentHub } = useCopilot();

  const isMountedRef = useRef(false);

  // Fetch PENDING cards from DB
  const fetchCards = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("cockpit_cards")
        .select("*")
        .eq("status", "PENDING")
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) {
        console.debug("Cockpit cards fetch notice:", error.message);
      } else if (data && data.length > 0) {
        setCards(data as CockpitCard[]);
      }
    } catch (err) {
      console.debug("Cockpit cards exception:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Tier 1: Background AI elevation to /api/ai/copilot ('strategist_cockpit')
  const runStrategistElevation = useCallback(async (force: boolean = false) => {
    if (typeof window === "undefined") return;

    const lastGenStr = localStorage.getItem("last_cockpit_generated_at");
    const now = Date.now();
    const isStale =
      !lastGenStr || now - new Date(lastGenStr).getTime() > 120 * 60 * 1000;

    if (!force && !isStale) {
      return;
    }

    setIsRefreshing(true);
    try {
      const res = await invokeCopilot<StrategistCockpitResult>({
        action: "strategist_cockpit",
        limit: 10,
      });

      if (res.ok && res.data?.top_cards && Array.isArray(res.data.top_cards)) {
        const supabase = createClient();
        const cardsToInsert = res.data.top_cards.map((c: RawTopCard) => ({
          lead_id: c.lead_id || null,
          listing_id: c.listing_id || null,
          channel: c.channel || "CRM",
          priority: (c.priority || "HIGH").toUpperCase(),
          headline: c.headline || "Günün Fürsət Kartı",
          draft_text: c.draft_text || null,
          reason: c.reason || c.strategic_rationale || "Strategist AI tərəfindən seçildi",
          sentinel_warning: c.sentinel_warning || null,
          status: "PENDING",
          target_uri: c.target_uri || null,
          strategic_rationale: c.strategic_rationale || c.reason || null,
        }));

        if (cardsToInsert.length > 0) {
          const { data: inserted, error: insertErr } = await supabase
            .from("cockpit_cards")
            .insert(cardsToInsert)
            .select();

          if (!insertErr && inserted) {
            setCards((prev) => {
              const newIds = new Set(inserted.map((item: { id: string }) => item.id));
              const existingFiltered = prev.filter((item) => !newIds.has(item.id));
              return [...(inserted as CockpitCard[]), ...existingFiltered];
            });
          }
        }

        localStorage.setItem("last_cockpit_generated_at", new Date().toISOString());
      }
    } catch (err) {
      console.warn("Strategist cockpit elevation notice:", err);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // Tier 0: On mount, read `bakuestate_cached_leads_v1` from localStorage and display deterministic cards via computeTriagedRadar()
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const cachedRaw = localStorage.getItem("bakuestate_cached_leads_v1");
        if (cachedRaw) {
          const cachedLeads = JSON.parse(cachedRaw);
          if (Array.isArray(cachedLeads) && cachedLeads.length > 0) {
            const radarItems = computeTriagedRadar(cachedLeads);
            const initialDeterministicCards: CockpitCard[] = radarItems.map(
              (item, idx) => ({
                id: item.id || `radar-cached-${idx}`,
                lead_id: item.lead_id || item.id || null,
                listing_id: item.listing_id || null,
                channel: item.channel || "CRM",
                priority:
                  item.priority ||
                  (item.radar_score >= 100
                    ? "URGENT"
                    : item.radar_score >= 75
                      ? "HIGH"
                      : "NORMAL"),
                headline: item.headline || `Top Fürsət: ${item.client_name || "Müştəri"}`,
                draft_text: item.draft_text || `Salam! BakuEstate-dən əlaqə saxlayırıq.`,
                reason: item.reason || "0ms Yerli Radar Heuristikası",
                sentinel_warning: item.sentinel_warning || null,
                status: "PENDING",
                created_at: item.created_at || new Date().toISOString(),
                target_uri: item.target_uri || null,
                strategic_rationale:
                  item.strategic_rationale ||
                  "Yerli keş əsasında dərhal generasiya olunan radar kartı",
              })
            );
            setCards(initialDeterministicCards);
            setLoading(false);
          }
        }
      } catch (e) {
        console.debug("Tier 0 cache read notice:", e);
      }
    }

    // Load fresh cards from DB
    fetchCards();

    // Trigger Tier 1 elevation if stale (>120m)
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      runStrategistElevation(false);
    }

    // Subscribe to Realtime updates on cockpit_cards with 500ms trailing debounce
    let debounceTimer: NodeJS.Timeout | null = null;
    try {
      const supabase = createClient();
      const channel = supabase
        .channel("cockpit_cards_realtime_hud")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "cockpit_cards" },
          () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              fetchCards();
            }, 500);
          }
        )
        .subscribe();

      return () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        supabase.removeChannel(channel);
      };
    } catch (e) {
      console.debug("Realtime subscription fallback:", e);
    }
  }, [fetchCards, runStrategistElevation]);

  async function handleMarkStatus(
    cardId: string,
    nextStatus: "EXECUTED" | "DISMISSED"
  ) {
    setProcessingId(cardId);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("cockpit_cards")
        .update({ status: nextStatus })
        .eq("id", cardId);

      if (error) {
        console.error("Cockpit update error:", error);
      }

      // Optimistically remove card from local state
      setCards((prev) => prev.filter((c) => c.id !== cardId));
    } catch (err) {
      console.error("Failed to update card status:", err);
    } finally {
      setProcessingId(null);
    }
  }

  async function copyToClipboard(text: string, cardId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(cardId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopiedId(null);
    }
  }

  // Priority badge helper
  function renderPriorityBadge(priority: string) {
    const p = (priority || "NORMAL").toUpperCase();
    if (p === "URGENT" || p === "HIGH") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/50 bg-rose-950/80 px-2 py-0.5 text-[10px] font-bold text-rose-300">
          <Flame className="h-3 w-3 text-rose-400 animate-pulse" />
          <span>{p}</span>
        </span>
      );
    }
    if (p === "LOW") {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
          <span>AŞAĞI</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-950/80 px-2 py-0.5 text-[10px] font-bold text-amber-300">
        <Zap className="h-3 w-3 text-amber-400" />
        <span>VACİB</span>
      </span>
    );
  }

  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-gold-500/30 bg-gradient-to-b from-obsidian-900/95 via-obsidian-900/90 to-obsidian-950/95 shadow-xl backdrop-blur-md transition-all">
      {/* Top HUD Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 text-obsidian-950 shadow-md">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold tracking-wider uppercase text-gold-400">
                AI Cockpit HUD
              </span>
              <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                <Radio className="h-3 w-3 animate-pulse" />
                <span>Canlı Nəzarət</span>
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Sentinel & Strategist Avtonom Satış Dəstəsi
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Manual Refresh Button */}
          <button
            type="button"
            disabled={isRefreshing}
            onClick={() => runStrategistElevation(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gold-500/30 bg-gold-500/10 px-2.5 py-1 text-xs font-semibold text-gold-300 hover:bg-gold-500/20 active:scale-95 transition disabled:opacity-50"
            title="AI Cockpit Kartlarını Yenidən Qiymətləndir"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin text-gold-400" : ""}`}
            />
            <span className="hidden sm:inline">
              {isRefreshing ? "Yenilənir..." : "🔄 Yenilə"}
            </span>
          </button>

          {cards.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-950/70 px-2.5 py-1 text-xs font-bold text-amber-300">
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
              <span>{cards.length} Gözləyən Tapşırıq</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-950/50 px-2.5 py-1 text-xs font-medium text-emerald-300">
              <CheckCircle2 className="h-3 w-3 text-emerald-400" />
              <span>Bütün kartlar icra olunub</span>
            </span>
          )}

          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="rounded-lg border border-slate-800 bg-obsidian-850 p-1.5 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition"
            title={isCollapsed ? "Genişləndir" : "Yığcamlaşdır"}
            aria-label="Toggle Cockpit HUD"
          >
            {isCollapsed ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Main HUD Body */}
      {!isCollapsed && (
        <div className="p-4 sm:p-5">
          {loading && cards.length === 0 ? (
            <div className="flex items-center justify-center py-6 text-xs text-slate-500">
              <span className="animate-pulse">Cockpit kartları yüklənir...</span>
            </div>
          ) : cards.length === 0 ? (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-obsidian-950/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-950/60 text-emerald-400 border border-emerald-500/20">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-200">
                    Gözləyən təxirəsalınmaz Cockpit kartı yoxdur
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Sentinel ünvan sızması qalxanı və 50–100 ₼ komissiya müdafiəsi 24/7 rejimdə aktivdir.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openAgentHub("mudir")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gold-400/50 bg-gold-500/15 hover:bg-gold-500/25 px-3 py-1.5 text-xs font-bold text-gold-300 transition"
                >
                  <Zap className="h-3.5 w-3.5 text-gold-400 fill-gold-400" />
                  <span>⚡ AI Qərargahını Aç</span>
                </button>
                <span className="rounded-md border border-slate-800 bg-obsidian-850 px-2 py-1 font-mono text-[10px] text-slate-400">
                  0 PENDING
                </span>
              </div>
            </div>
          ) : (
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card) => {
                const isProcessing = processingId === card.id;
                const isCopied = copiedId === card.id;
                const waUrl =
                  card.target_uri &&
                  (card.target_uri.startsWith("http") ||
                    card.target_uri.startsWith("wa.me"))
                    ? card.target_uri
                    : card.draft_text
                      ? `https://wa.me/?text=${encodeURIComponent(card.draft_text)}`
                      : null;

                return (
                  <div
                    key={card.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-800/90 bg-obsidian-950/80 p-3.5 transition hover:border-gold-500/40 shadow-sm"
                  >
                    <div className="space-y-2.5">
                      {/* Priority, Channel & Time */}
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {renderPriorityBadge(card.priority)}
                          <span className="rounded-md border border-slate-800 bg-obsidian-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-300">
                            {card.channel || "CRM"}
                          </span>
                        </div>
                        <span className="flex items-center gap-1 text-[10px] text-slate-400">
                          <Clock className="h-2.5 w-2.5" />
                          <span>{formatRelativeAz(card.created_at)}</span>
                        </span>
                      </div>

                      {/* Headline */}
                      <h4 className="text-xs font-bold text-slate-100 line-clamp-2">
                        {card.headline}
                      </h4>

                      {/* Sentinel Warning Banner */}
                      {card.sentinel_warning && (
                        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-950/30 p-2 text-[11px] text-rose-200">
                          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-400 mt-0.5" />
                          <div>
                            <span className="font-bold text-rose-300">
                              SENTINEL MÜDAFİƏSİ:{" "}
                            </span>
                            <span>{card.sentinel_warning}</span>
                          </div>
                        </div>
                      )}

                      {/* Rationale / Reason */}
                      {(card.reason || card.strategic_rationale) && (
                        <p className="text-[11px] text-slate-400 italic">
                          💡 {card.reason || card.strategic_rationale}
                        </p>
                      )}

                      {/* Baku-Dialect WhatsApp Draft Text */}
                      {card.draft_text && (
                        <div className="rounded-lg border border-slate-800/80 bg-obsidian-900/90 p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between text-[10px] font-semibold text-gold-400">
                            <span>Scribe WhatsApp Qaralaması:</span>
                            <button
                              type="button"
                              onClick={() =>
                                copyToClipboard(card.draft_text!, card.id)
                              }
                              className="inline-flex items-center gap-1 rounded border border-gold-500/30 bg-gold-500/10 px-1.5 py-0.5 text-gold-300 hover:bg-gold-500/20 transition"
                            >
                              {isCopied ? (
                                <>
                                  <Check className="h-2.5 w-2.5 text-emerald-400" />
                                  <span>Kopyalandı!</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-2.5 w-2.5" />
                                  <span>Kopyala</span>
                                </>
                              )}
                            </button>
                          </div>
                          <p className="text-xs text-slate-200 font-sans whitespace-pre-wrap leading-relaxed line-clamp-4">
                            {card.draft_text}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Action Buttons Row */}
                    <div className="mt-3.5 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5">
                        {waUrl && (
                          <a
                            href={waUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 border border-emerald-500/40 px-2 py-1 text-[11px] font-semibold text-white shadow-sm transition"
                          >
                            <MessageCircle className="h-3 w-3" />
                            <span>WhatsApp</span>
                            <ExternalLink className="h-2.5 w-2.5 opacity-70" />
                          </a>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            const persona = card.listing_id && !card.lead_id ? "mudir" : "musteri_psixologiyasi";
                            openAgentHub(persona, {
                              leadId: card.lead_id || undefined,
                              listingId: card.listing_id || undefined,
                              initialPrompt: card.draft_text || card.headline || undefined,
                            });
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-gold-500/30 bg-gold-500/10 hover:bg-gold-500/20 px-2 py-1 text-[11px] font-semibold text-gold-300 transition"
                          title="Bu kartı AI Qərargahında Aç"
                        >
                          <Bot className="h-3 w-3 text-gold-400" />
                          <span>Copilot</span>
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={() => handleMarkStatus(card.id, "EXECUTED")}
                          className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-gold-500 to-gold-600 hover:from-gold-400 hover:to-gold-500 px-2.5 py-1 text-[11px] font-bold text-obsidian-950 shadow-sm transition disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          <span>İcra Et</span>
                        </button>

                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={() => handleMarkStatus(card.id, "DISMISSED")}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-obsidian-900 hover:bg-rose-950/40 hover:border-rose-500/50 hover:text-rose-200 px-2 py-1 text-[11px] font-medium text-slate-400 transition disabled:opacity-50"
                        >
                          <XCircle className="h-3 w-3" />
                          <span>Ləğv</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
