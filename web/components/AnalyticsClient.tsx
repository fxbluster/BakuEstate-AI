"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  DollarSign,
  ExternalLink,
  Eye,
  Heart,
  HelpCircle,
  Info,
  Layers,
  MessageCircle,
  MessageSquare,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Trophy,
  Users,
  Video,
} from "lucide-react";
import {
  DURATION_BUCKET_LABELS,
  formatAzn,
  formatCompactNumber,
  formatRelativeAz,
  HOOK_TYPE_LABELS,
  INTENT_CATEGORY_META,
} from "@/lib/format";
import type {
  BuyerLead,
  ChannelNiche,
  LeadTimelineEvent,
  Listing,
  Publication,
  RenderVersion,
  SocialComment,
  TelemetrySnapshot,
} from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

export interface EnrichedPublication extends Publication {
  listing?: Pick<
    Listing,
    | "id"
    | "bina_id"
    | "title"
    | "price_azn_normalized"
    | "location"
    | "photo_urls"
  > | null;
  render?: Pick<
    RenderVersion,
    | "id"
    | "version_num"
    | "hook_type"
    | "duration_bucket"
    | "duration_seconds"
    | "status"
    | "video_cdn_url"
  > | null;
  leads_count?: number;
  ner_score?: number | null;
}

export interface EnrichedComment extends SocialComment {
  listing?: Pick<
    Listing,
    "id" | "bina_id" | "title" | "price_azn_normalized" | "location"
  > | null;
  publication?: Pick<Publication, "id" | "post_url" | "channel"> | null;
  buyer_lead?: Pick<
    BuyerLead,
    "id" | "client_name" | "phone_normalized" | "stage"
  > | null;
}

export interface AnalyticsClientProps {
  publications: EnrichedPublication[];
  comments: EnrichedComment[];
  snapshots: TelemetrySnapshot[];
  leads?: BuyerLead[];
  timelineEvents?: LeadTimelineEvent[];
}

export type NicheFilter = "ALL" | ChannelNiche;

interface NicheTabItem {
  id: NicheFilter;
  label: string;
  handle: string;
  badgeClass: string;
  activeClass: string;
}

const NICHE_TABS: NicheTabItem[] = [
  {
    id: "ALL",
    label: "Hamısı",
    handle: "Bütün Kanallar",
    badgeClass: "text-slate-300 border-slate-700 bg-obsidian-900",
    activeClass: "bg-gold-500/20 text-gold-300 border-gold-500/50 shadow-sm",
  },
  {
    id: "LUXURY",
    label: "💎 @bakuestate.premium",
    handle: "@bakuestate.premium",
    badgeClass: "text-amber-300 border-amber-500/30 bg-amber-950/20",
    activeClass: "bg-amber-500/25 text-amber-300 border-amber-500/60 shadow-sm shadow-amber-500/10",
  },
  {
    id: "AFFORDABLE",
    label: "🏠 @baku.serfeli.evler",
    handle: "@baku.serfeli.evler",
    badgeClass: "text-emerald-300 border-emerald-500/30 bg-emerald-950/20",
    activeClass: "bg-emerald-500/25 text-emerald-300 border-emerald-500/60 shadow-sm shadow-emerald-500/10",
  },
  {
    id: "GENERAL",
    label: "🏢 @bakuestate.official",
    handle: "@bakuestate.official",
    badgeClass: "text-sky-300 border-sky-500/30 bg-sky-950/20",
    activeClass: "bg-sky-500/25 text-sky-300 border-sky-500/60 shadow-sm shadow-sky-500/10",
  },
  {
    id: "TIKTOK",
    label: "🔥 @baku_emlak_ai",
    handle: "@baku_emlak_ai",
    badgeClass: "text-rose-300 border-rose-500/30 bg-rose-950/20",
    activeClass: "bg-rose-500/25 text-rose-300 border-rose-500/60 shadow-sm shadow-rose-500/10",
  },
];

export function AnalyticsClient({
  publications,
  comments,
  snapshots,
  leads = [],
  timelineEvents = [],
}: AnalyticsClientProps) {
  // ---------------------------------------------------------------------------
  // SLICE 1: selectedNiche (Interactive Account Filter Tabs)
  // ---------------------------------------------------------------------------
  const [selectedNiche, setSelectedNiche] = useState<NicheFilter>("ALL");
  const [commentFilter, setCommentFilter] = useState<
    "ALL" | "LEADS_ONLY" | "PRICE" | "MORTGAGE" | "LOCATION"
  >("ALL");
  const [showFormulaTooltip, setShowFormulaTooltip] = useState(false);

  // Helper map from publication id to channel_niche
  const pubNicheMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of publications) {
      if (p.channel_niche) {
        map.set(p.id, p.channel_niche);
      } else if (p.target_account_handle) {
        if (p.target_account_handle.includes("premium")) map.set(p.id, "LUXURY");
        else if (p.target_account_handle.includes("serfeli")) map.set(p.id, "AFFORDABLE");
        else if (p.target_account_handle.includes("emlak_ai")) map.set(p.id, "TIKTOK");
        else map.set(p.id, "GENERAL");
      }
    }
    return map;
  }, [publications]);

  // Compute publication counts per niche for tab badges
  const nicheCounts = useMemo(() => {
    const counts: Record<string, number> = {
      ALL: publications.length,
      LUXURY: 0,
      AFFORDABLE: 0,
      GENERAL: 0,
      TIKTOK: 0,
    };
    for (const p of publications) {
      const niche = p.channel_niche || pubNicheMap.get(p.id);
      if (niche && counts[niche] !== undefined) {
        counts[niche]++;
      }
    }
    return counts;
  }, [publications, pubNicheMap]);

  // Filter publications by selected niche
  const filteredPublications = useMemo(() => {
    if (selectedNiche === "ALL") return publications;
    return publications.filter((p) => {
      const niche = p.channel_niche || pubNicheMap.get(p.id);
      return niche === selectedNiche;
    });
  }, [publications, selectedNiche, pubNicheMap]);

  // Filter comments by selected niche
  const nicheComments = useMemo(() => {
    if (selectedNiche === "ALL") return comments;
    return comments.filter((c) => {
      const niche = pubNicheMap.get(c.publication_id);
      return niche === selectedNiche;
    });
  }, [comments, selectedNiche, pubNicheMap]);

  // Filter leads by selected niche
  const filteredLeads = useMemo(() => {
    if (selectedNiche === "ALL") return leads;
    return leads.filter((l) => {
      if (l.attributed_channel_niche === selectedNiche) return true;
      if (
        l.attributed_publication_id &&
        pubNicheMap.get(l.attributed_publication_id) === selectedNiche
      ) {
        return true;
      }
      return false;
    });
  }, [leads, selectedNiche, pubNicheMap]);

  // ---------------------------------------------------------------------------
  // SLICE 2: perNicheMedians (Isolated Rolling Median Views per Niche)
  // ---------------------------------------------------------------------------
  const perNicheMedians = useMemo(() => {
    const map = new Map<string, number>();
    const baselines: Record<string, number> = {
      LUXURY: 800,
      AFFORDABLE: 4500,
      GENERAL: 2200,
      TIKTOK: 12000,
      ALL: 2200,
    };
    for (const niche of ["LUXURY", "AFFORDABLE", "GENERAL", "TIKTOK", "ALL"]) {
      const pubs =
        niche === "ALL"
          ? publications
          : publications.filter(
              (p) => (p.channel_niche || pubNicheMap.get(p.id)) === niche
            );
      const views = pubs
        .map((p) => p.views_count)
        .filter((v) => v > 0)
        .sort((a, b) => a - b);

      if (views.length < 5) {
        map.set(niche, baselines[niche] ?? 2200);
      } else {
        const mid = Math.floor(views.length / 2);
        map.set(
          niche,
          views.length % 2 !== 0
            ? views[mid]
            : Math.round((views[mid - 1] + views[mid]) / 2)
        );
      }
    }
    return map;
  }, [publications, pubNicheMap]);

  // Compute comment & lead stats per publication
  const commentsByPub = useMemo(() => {
    const map = new Map<string, { total: number; leads: number }>();
    for (const c of comments) {
      const cur = map.get(c.publication_id) || { total: 0, leads: 0 };
      cur.total++;
      if (c.is_intent_lead || c.buyer_lead_id) {
        cur.leads++;
      }
      map.set(c.publication_id, cur);
    }
    return map;
  }, [comments]);

  // Attach computed metrics & fair per-niche NER scores to filtered publications
  const rankedPublications = useMemo(() => {
    return filteredPublications.map((p) => {
      const stats = commentsByPub.get(p.id) || {
        total: p.comments_count,
        leads: 0,
      };
      const pubLeads = stats.leads;
      const cCount = Math.max(1, p.comments_count || stats.total);
      const nicheKey = p.channel_niche || pubNicheMap.get(p.id) || "GENERAL";
      const median =
        perNicheMedians.get(nicheKey) ?? perNicheMedians.get("GENERAL") ?? 2200;

      // Guarded NER Formula:
      // (Views_48h / perNicheMedian) * 0.6 + (Leads_48h / max(1, Comments_48h)) * 0.4
      const viewRatio = (p.views_count || 0) / Math.max(1, median);
      const leadRatio = pubLeads / cCount;
      const ner = Number((viewRatio * 0.6 + leadRatio * 0.4).toFixed(2));

      return {
        ...p,
        leads_count: pubLeads,
        ner_score: ner,
      };
    });
  }, [filteredPublications, commentsByPub, perNicheMedians, pubNicheMap]);

  // ---------------------------------------------------------------------------
  // SLICE 3: erMetricCards (Resilient Social ER% & Health Badges)
  // ---------------------------------------------------------------------------
  const erMetricCards = useMemo(() => {
    const totalViews = rankedPublications.reduce(
      (acc, p) => acc + (p.views_count || 0),
      0
    );
    const totalLikes = rankedPublications.reduce(
      (acc, p) => acc + (p.likes_count || 0),
      0
    );
    const totalComments = rankedPublications.reduce(
      (acc, p) => acc + (p.comments_count || 0),
      0
    );
    const totalShares = rankedPublications.reduce(
      (acc, p) => acc + (p.shares_count || 0),
      0
    );
    const totalInteractions = totalLikes + totalComments + totalShares;

    // Resilient ER% formula:
    // Effective ER% = ((Likes + Comments + Shares) / max(1, Views)) * 100
    // Guarded: returns 0.00% if views == 0, with cold-start guard for views < 50
    let erPercent = 0;
    if (totalViews >= 50) {
      erPercent = Number(
        ((totalInteractions / Math.max(1, totalViews)) * 100).toFixed(2)
      );
    } else if (totalViews > 0) {
      erPercent = Number(
        ((totalInteractions / totalViews) * 100).toFixed(2)
      );
    }

    // Health badge determination:
    // > 3.5% High / Green, 1.5% - 3.5% Normal / Gold, < 1.5% Low / Slate
    let health: {
      label: string;
      description: string;
      badgeClass: string;
      textColor: string;
      dotColor: string;
    };

    if (totalViews < 50) {
      health = {
        label: "İlkin Telemetriya",
        description: "Baxış < 50 (soyuq başlanğıc mərhələsi)",
        badgeClass: "bg-slate-500/15 text-slate-300 border-slate-500/30",
        textColor: "text-slate-300",
        dotColor: "bg-slate-400",
      };
    } else if (erPercent > 3.5) {
      health = {
        label: "Yüksək / Əla",
        description: "ER > 3.5% • Yüksək auditoriya reaksiyası",
        badgeClass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
        textColor: "text-emerald-300",
        dotColor: "bg-emerald-400",
      };
    } else if (erPercent >= 1.5) {
      health = {
        label: "Normal / Qənaətbəxş",
        description: "ER 1.5% - 3.5% • Sənaye standartına uyğun",
        badgeClass: "bg-amber-500/15 text-amber-300 border-amber-500/40",
        textColor: "text-amber-300",
        dotColor: "bg-amber-400",
      };
    } else {
      health = {
        label: "Zəif / Aşağı",
        description: "ER < 1.5% • Qarmaq optimizasiyası tövsiyə olunur",
        badgeClass: "bg-slate-500/15 text-slate-400 border-slate-500/30",
        textColor: "text-slate-400",
        dotColor: "bg-slate-500",
      };
    }

    return {
      totalViews,
      totalLikes,
      totalComments,
      totalShares,
      totalInteractions,
      erPercent,
      health,
      activePubsCount: rankedPublications.length,
    };
  }, [rankedPublications]);

  // ---------------------------------------------------------------------------
  // SLICE 4: funnelBreakdown (4-Tier Mobile Instagram & TikTok Pipeline Funnel)
  // ---------------------------------------------------------------------------
  const funnelBreakdown = useMemo(() => {
    // Stage 1: Total Views across niche reels
    const views = erMetricCards.totalViews;

    // Stage 2: Engagement & Scraped Intent Comments
    const interactions = erMetricCards.totalInteractions;
    const intentCommentsCount = nicheComments.filter(
      (c) => c.is_intent_lead || c.buyer_lead_id !== null
    ).length;

    // Stage 3: Inbound WhatsApp Leads (attributed via bio link & kod:{bina_id})
    const leadsCount = filteredLeads.length;

    // Stage 4: Showings & Closed Won Commissions
    const leadIdSet = new Set(filteredLeads.map((l) => l.id));
    const showingEventsCount = timelineEvents.filter(
      (e) =>
        e.event_type === "SHOWING_SCHEDULED" &&
        (!e.lead_id || leadIdSet.has(e.lead_id))
    ).length;

    const showingsFromLeads = filteredLeads.filter(
      (l) =>
        l.stage === "VIEWING_SCHEDULED" ||
        l.stage === "VIEWED" ||
        l.stage === "NEGOTIATING" ||
        l.stage === "DEPOSIT" ||
        l.stage === "WON_CLOSED"
    ).length;

    const showingsCount = Math.max(showingsFromLeads, showingEventsCount);

    const wonLeads = filteredLeads.filter((l) => l.stage === "WON_CLOSED");
    const closedCount = wonLeads.length;
    const totalCommissionAzn = filteredLeads.reduce(
      (acc, l) => acc + (l.actual_commission_azn || 0),
      0
    );

    // Progressive conversion rates
    const viewToEngRate =
      views > 0 ? Number(((interactions / views) * 100).toFixed(1)) : 0;
    const engToLeadRate =
      interactions > 0
        ? Number(((leadsCount / interactions) * 100).toFixed(1))
        : 0;
    const leadToShowingRate =
      leadsCount > 0
        ? Number(((showingsCount / leadsCount) * 100).toFixed(1))
        : 0;
    const showingToWonRate =
      showingsCount > 0
        ? Number(((closedCount / showingsCount) * 100).toFixed(1))
        : 0;

    return {
      stage1: {
        title: "1. Ümumi Baxış",
        subtitle: "Sosial mediada yayımlanan videolara toplam baxış sayı",
        value: views,
        badge: "Baxış Bazası",
        rateText: "100%",
      },
      stage2: {
        title: "2. Sosial Maraq və Şərhlər",
        subtitle: `${intentCommentsCount} alıcı niyyətli şərh daxil olmaqla`,
        value: interactions,
        badge: `${intentCommentsCount} Alıcı Niyyəti`,
        rateText: `${viewToEngRate}% baxışdan reaksiyaya`,
      },
      stage3: {
        title: "3. Qeydə Alınan Leadlər",
        subtitle: "WhatsApp bio linki və NLP ilə CRM-ə daxil olan alıcılar",
        value: leadsCount,
        badge: "kod:{id} İnteqrasiyası",
        rateText: `${engToLeadRate}% reaksiyadan lead-ə`,
      },
      stage4: {
        title: "4. Fiziki Baxış və Satış",
        subtitle: `${showingsCount} baxış təyin edilib • ${closedCount} uğurla satılıb`,
        value: closedCount,
        showingsCount,
        commissionAzn: totalCommissionAzn,
        badge: formatAzn(totalCommissionAzn),
        rateText: `${leadToShowingRate}% baxışa keçid • ${showingToWonRate}% satış`,
      },
    };
  }, [erMetricCards, nicheComments, filteredLeads, timelineEvents]);

  // Leaderboard: Top performing videos by views / engagement
  const leaderboard = useMemo(() => {
    return [...rankedPublications]
      .sort((a, b) => (b.views_count || 0) - (a.views_count || 0))
      .slice(0, 10);
  }, [rankedPublications]);

  // A/B Hook Type Comparison: PRICE_FIRST vs LOCATION_FIRST
  const abHookMetrics = useMemo(() => {
    const priceFirstPubs = rankedPublications.filter(
      (p) => p.render?.hook_type === "PRICE_FIRST"
    );
    const locationFirstPubs = rankedPublications.filter(
      (p) => p.render?.hook_type === "LOCATION_FIRST"
    );

    function calcMetrics(pubs: EnrichedPublication[]) {
      if (pubs.length === 0) {
        return { count: 0, avgViews: 0, avgLeads: 0, avgNer: 0 };
      }
      const sumViews = pubs.reduce((s, p) => s + (p.views_count || 0), 0);
      const sumLeads = pubs.reduce((s, p) => s + (p.leads_count || 0), 0);
      const sumNer = pubs.reduce((s, p) => s + (p.ner_score || 0), 0);
      return {
        count: pubs.length,
        avgViews: Math.round(sumViews / pubs.length),
        avgLeads: Number((sumLeads / pubs.length).toFixed(1)),
        avgNer: Number((sumNer / pubs.length).toFixed(2)),
      };
    }

    return {
      priceFirst: calcMetrics(priceFirstPubs),
      locationFirst: calcMetrics(locationFirstPubs),
    };
  }, [rankedPublications]);

  // A/B Duration Bucket Comparison: SHORT_25_30 vs LONG_40_50
  const abDurationMetrics = useMemo(() => {
    const shortPubs = rankedPublications.filter(
      (p) => p.render?.duration_bucket === "SHORT_25_30"
    );
    const longPubs = rankedPublications.filter(
      (p) => p.render?.duration_bucket === "LONG_40_50"
    );

    function calcMetrics(pubs: EnrichedPublication[]) {
      if (pubs.length === 0) {
        return { count: 0, avgViews: 0, avgLeads: 0, avgNer: 0 };
      }
      const sumViews = pubs.reduce((s, p) => s + (p.views_count || 0), 0);
      const sumLeads = pubs.reduce((s, p) => s + (p.leads_count || 0), 0);
      const sumNer = pubs.reduce((s, p) => s + (p.ner_score || 0), 0);
      return {
        count: pubs.length,
        avgViews: Math.round(sumViews / pubs.length),
        avgLeads: Number((sumLeads / pubs.length).toFixed(1)),
        avgNer: Number((sumNer / pubs.length).toFixed(2)),
      };
    }

    return {
      short: calcMetrics(shortPubs),
      long: calcMetrics(longPubs),
    };
  }, [rankedPublications]);

  // Filtered comments stream
  const filteredComments = useMemo(() => {
    return nicheComments.filter((c) => {
      if (commentFilter === "LEADS_ONLY") {
        return c.is_intent_lead || c.buyer_lead_id !== null;
      }
      if (commentFilter === "PRICE") {
        return c.intent_category === "PRICE";
      }
      if (commentFilter === "MORTGAGE") {
        return c.intent_category === "MORTGAGE";
      }
      if (commentFilter === "LOCATION") {
        return c.intent_category === "LOCATION";
      }
      return true;
    });
  }, [nicheComments, commentFilter]);

  // Current active niche label
  const activeNicheTab =
    NICHE_TABS.find((t) => t.id === selectedNiche) || NICHE_TABS[0];
  const currentNicheMedian =
    perNicheMedians.get(selectedNiche) ?? perNicheMedians.get("GENERAL") ?? 2200;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-400">
            Sosial İntellekt, Niş Reytinqi &amp; 4-Pilləli Qıf
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Sosial Media Analitikası
          </h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>
            Canlı Telemetriya • {snapshots.length} Snapshot • 4 Hesab Paylanması
          </span>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 1. Account Filter Tabs (Slice 1: selectedNiche)                       */}
      {/* -------------------------------------------------------------------- */}
      <div className="exec-card p-3 bg-obsidian-900/90 border-slate-800/80">
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800/60">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-gold-400" />
            <span className="text-xs font-semibold text-slate-200">
              Kanal &amp; Niş Filtri:
            </span>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Aktiv Niş Medianı:{" "}
            <span className="font-bold text-gold-300">
              {formatCompactNumber(currentNicheMedian)} baxış
            </span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {NICHE_TABS.map((tab) => {
            const isSelected = selectedNiche === tab.id;
            const count = nicheCounts[tab.id] ?? 0;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSelectedNiche(tab.id)}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-medium border transition-all ${
                  isSelected
                    ? tab.activeClass
                    : "border-slate-800 bg-obsidian-950/70 text-slate-400 hover:text-slate-200 hover:border-slate-700"
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[10px] font-mono font-semibold ${
                    isSelected
                      ? "bg-obsidian-950/80 text-white"
                      : "bg-slate-800/80 text-slate-400"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 2. Executive Resilient ER & KPI Metric Cards (Slice 3: erMetricCards)  */}
      {/* -------------------------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* Total Views */}
        <div className="exec-card p-4 space-y-1">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Toplam Baxış</span>
            <div className="rounded-lg bg-sky-500/10 p-1.5 text-sky-400 border border-sky-500/20">
              <Eye className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight text-slate-50">
            {formatCompactNumber(erMetricCards.totalViews)}
          </p>
          <p className="text-[11px] text-slate-400">
            {erMetricCards.activePubsCount} aktiv paylaşımdan ({activeNicheTab.handle})
          </p>
        </div>

        {/* Resilient Social Engagement Rate (ER%) */}
        <div className="exec-card p-4 space-y-1 border-emerald-500/30 bg-gradient-to-br from-obsidian-900 via-obsidian-900 to-emerald-950/20">
          <div className="flex items-center justify-between text-emerald-400">
            <span className="text-xs font-semibold">İştirak Nisbəti (ER%)</span>
            <div className="rounded-lg bg-emerald-500/20 p-1.5 text-emerald-300 border border-emerald-500/40">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold tracking-tight text-emerald-300">
              {erMetricCards.erPercent}%
            </p>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${erMetricCards.health.badgeClass}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${erMetricCards.health.dotColor}`}
              />
              <span>{erMetricCards.health.label}</span>
            </span>
          </div>
          <p className="text-[11px] text-slate-400 truncate">
            {erMetricCards.health.description}
          </p>
        </div>

        {/* Total Social Reactions */}
        <div className="exec-card p-4 space-y-1">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-medium">Sosial Reaksiyalar</span>
            <div className="rounded-lg bg-violet-500/10 p-1.5 text-violet-400 border border-violet-500/20">
              <Heart className="h-4 w-4" />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight text-violet-300">
            {formatCompactNumber(erMetricCards.totalInteractions)}
          </p>
          <p className="text-[11px] text-slate-400">
            {formatCompactNumber(erMetricCards.totalLikes)} like •{" "}
            {formatCompactNumber(erMetricCards.totalComments)} şərh •{" "}
            {formatCompactNumber(erMetricCards.totalShares)} paylaşım
          </p>
        </div>

        {/* Closed Won Commissions / Inbound Leads */}
        <div className="exec-card p-4 space-y-1 border-gold-500/30 bg-gradient-to-br from-obsidian-900 via-obsidian-900 to-gold-950/20">
          <div className="flex items-center justify-between text-gold-400">
            <span className="text-xs font-semibold">Satış &amp; Komissiya</span>
            <div className="rounded-lg bg-gold-500/20 p-1.5 text-gold-300 border border-gold-500/40">
              <DollarSign className="h-4 w-4" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold tracking-tight text-gold-300">
              {formatAzn(funnelBreakdown.stage4.commissionAzn)}
            </p>
            <span className="text-xs font-semibold text-emerald-400">
              ({funnelBreakdown.stage4.value} satış)
            </span>
          </div>
          <p className="text-[11px] text-slate-400">
            {filteredLeads.length} lead-dən tamamlanmış sövdələşmələr
          </p>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 3. Real 4-Tier Pipeline Funnel (Slice 4: funnelBreakdown)            */}
      {/* -------------------------------------------------------------------- */}
      <div className="exec-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-gold-500/15 p-1.5 text-gold-300 border border-gold-500/30">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                4-Pilləli Sosial Qıf &amp; Real Atribusiya (Mobile Pipeline Funnel)
              </h2>
              <p className="text-[11px] text-slate-400">
                Video Baxış $\rightarrow$ Sosial Reaksiyalar $\rightarrow$ WhatsApp / Bio Leadləri $\rightarrow$ Fiziki Baxış və Satış
              </p>
            </div>
          </div>
          <span className="text-xs font-mono text-gold-400 bg-obsidian-950 px-2.5 py-1 rounded-lg border border-slate-800">
            kod:&#123;bina_id&#125; İzləmə Sistemi
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Tier 1: Total Views */}
          <div className="relative rounded-2xl border border-sky-500/30 bg-gradient-to-b from-sky-950/20 to-obsidian-950 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="rounded-md bg-sky-500/20 px-2 py-0.5 text-[10px] font-bold text-sky-300 border border-sky-500/30">
                Pillə 1
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                {funnelBreakdown.stage1.rateText}
              </span>
            </div>
            <h3 className="text-xs font-semibold text-slate-200">
              {funnelBreakdown.stage1.title}
            </h3>
            <p className="text-2xl font-extrabold text-sky-300">
              {formatCompactNumber(funnelBreakdown.stage1.value)}
            </p>
            <p className="text-[11px] text-slate-400 leading-tight">
              {funnelBreakdown.stage1.subtitle}
            </p>
            <div className="pt-2 border-t border-slate-800/80 flex items-center gap-1 text-[10px] text-sky-400 font-mono">
              <Eye className="h-3 w-3" />
              <span>Bütün paylaşılan videolar</span>
            </div>
          </div>

          {/* Tier 2: Engagement & Intent Comments */}
          <div className="relative rounded-2xl border border-violet-500/30 bg-gradient-to-b from-violet-950/20 to-obsidian-950 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="rounded-md bg-violet-500/20 px-2 py-0.5 text-[10px] font-bold text-violet-300 border border-violet-500/30">
                Pillə 2
              </span>
              <span className="text-[11px] font-mono text-emerald-400 font-semibold">
                {funnelBreakdown.stage2.rateText}
              </span>
            </div>
            <h3 className="text-xs font-semibold text-slate-200">
              {funnelBreakdown.stage2.title}
            </h3>
            <p className="text-2xl font-extrabold text-violet-300">
              {formatCompactNumber(funnelBreakdown.stage2.value)}
            </p>
            <p className="text-[11px] text-slate-400 leading-tight">
              {funnelBreakdown.stage2.subtitle}
            </p>
            <div className="pt-2 border-t border-slate-800/80 flex items-center gap-1 text-[10px] text-violet-400 font-mono">
              <MessageSquare className="h-3 w-3" />
              <span>{funnelBreakdown.stage2.badge}</span>
            </div>
          </div>

          {/* Tier 3: Inbound WhatsApp / Bio Leads */}
          <div className="relative rounded-2xl border border-emerald-500/30 bg-gradient-to-b from-emerald-950/20 to-obsidian-950 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="rounded-md bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/30">
                Pillə 3
              </span>
              <span className="text-[11px] font-mono text-emerald-400 font-semibold">
                {funnelBreakdown.stage3.rateText}
              </span>
            </div>
            <h3 className="text-xs font-semibold text-slate-200">
              {funnelBreakdown.stage3.title}
            </h3>
            <p className="text-2xl font-extrabold text-emerald-300">
              {funnelBreakdown.stage3.value} Lead
            </p>
            <p className="text-[11px] text-slate-400 leading-tight">
              {funnelBreakdown.stage3.subtitle}
            </p>
            <div className="pt-2 border-t border-slate-800/80 flex items-center gap-1 text-[10px] text-emerald-400 font-mono">
              <Sparkles className="h-3 w-3" />
              <span>{funnelBreakdown.stage3.badge}</span>
            </div>
          </div>

          {/* Tier 4: Showings & Won Closed Deals */}
          <div className="relative rounded-2xl border border-gold-500/40 bg-gradient-to-b from-gold-950/30 to-obsidian-950 p-4 space-y-2 shadow-lg shadow-gold-950/20">
            <div className="flex items-center justify-between">
              <span className="rounded-md bg-gold-500/20 px-2 py-0.5 text-[10px] font-bold text-gold-300 border border-gold-500/40">
                Pillə 4
              </span>
              <span className="text-[11px] font-mono text-gold-300 font-semibold">
                {funnelBreakdown.stage4.rateText}
              </span>
            </div>
            <h3 className="text-xs font-semibold text-slate-200">
              {funnelBreakdown.stage4.title}
            </h3>
            <p className="text-2xl font-extrabold text-gold-300">
              {funnelBreakdown.stage4.badge}
            </p>
            <p className="text-[11px] text-slate-400 leading-tight">
              {funnelBreakdown.stage4.subtitle}
            </p>
            <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-gold-400">
              <span>{funnelBreakdown.stage4.showingsCount} baxış</span>
              <span className="font-bold text-emerald-400 inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                <span>{funnelBreakdown.stage4.value} satış qapandı</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 4. A/B Performance Summary & NER Niche Medians                       */}
      {/* -------------------------------------------------------------------- */}
      <div className="exec-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-gold-500/15 p-1.5 text-gold-300 border border-gold-500/30">
              <TrendingUp className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                A/B Test Nəticələri &amp; Niş-Seqmentli NER Analizi
              </h2>
              <p className="text-[11px] text-slate-400">
                Qarmaq növü və video xronometrajının auditoriya konversiyasına təsiri
              </p>
            </div>
          </div>

          {/* Formula Tooltip Button */}
          <button
            type="button"
            onClick={() => setShowFormulaTooltip(!showFormulaTooltip)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-obsidian-850 px-2.5 py-1 text-xs text-slate-300 hover:text-gold-300 hover:border-gold-500/40 transition"
          >
            <Info className="h-3.5 w-3.5 text-gold-400" />
            <span>Niş Medianı &amp; NER Düsturu</span>
          </button>
        </div>

        {/* Formula Explanation Callout */}
        {showFormulaTooltip && (
          <div className="rounded-xl border border-gold-500/30 bg-gold-500/5 p-4 text-xs space-y-2 animate-in fade-in duration-150">
            <div className="flex items-center gap-2 font-bold text-gold-300">
              <HelpCircle className="h-4 w-4" />
              <span>Ədalətli Niş-Seqmentli NER (Normalized Engagement Ratio) Düsturu</span>
            </div>
            <div className="font-mono bg-obsidian-950/80 p-2.5 rounded-lg border border-slate-800 text-slate-200">
              NER = (Views_48h / Niche_Median_Views) × 0.6 + (Leads_48h / max(1, Comments_48h)) × 0.4
            </div>
            <p className="text-slate-300 leading-relaxed">
              Əvvəlki qlobal median (bütün kanallar üzrə 10,000+ baxış) lüks mənzilləri ədalətsiz cəzalandırırdı. İndi hər kanal öz fərdi niş medianı ilə qiymətləndirilir:
              <br />
              • <strong className="text-amber-300">LUXURY (@bakuestate.premium):</strong> Baza medianı 800 baxış (yüksək marjalı lüks əmlaklar).
              <br />
              • <strong className="text-emerald-300">AFFORDABLE (@baku.serfeli.evler):</strong> Baza medianı 4,500 baxış (orta və büdcəli evlər).
              <br />
              • <strong className="text-sky-300">GENERAL (@bakuestate.official):</strong> Baza medianı 2,200 baxış (standart portfel).
              <br />
              • <strong className="text-rose-300">TIKTOK (@baku_emlak_ai):</strong> Baza medianı 12,000 baxış (viral dinamika).
            </p>
          </div>
        )}

        {/* 2-Column Comparison Grid */}
        <div className="grid gap-4 md:grid-cols-2">
          {/* Hook Type: Price-First vs Location-First */}
          <div className="rounded-xl border border-slate-800 bg-obsidian-950/60 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">
                Qarmaq Növü (Hook Angle)
              </span>
              <span className="text-[11px] font-mono text-gold-400">
                {abHookMetrics.priceFirst.avgNer >=
                abHookMetrics.locationFirst.avgNer
                  ? "🏆 Price-First Öndədir"
                  : "🏆 Location-First Öndədir"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-slate-800/90 bg-obsidian-900/90 p-3 space-y-1">
                <p className="text-[11px] font-semibold text-gold-300">
                  Price-First (Qiymət)
                </p>
                <p className="text-lg font-bold text-slate-100">
                  {formatCompactNumber(abHookMetrics.priceFirst.avgViews)} baxış
                </p>
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                  <span>Ort. Müştəri:</span>
                  <span className="font-mono text-emerald-400">
                    {abHookMetrics.priceFirst.avgLeads}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>NER Reytinq:</span>
                  <span className="font-mono font-bold text-gold-300">
                    {abHookMetrics.priceFirst.avgNer}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/90 bg-obsidian-900/90 p-3 space-y-1">
                <p className="text-[11px] font-semibold text-sky-300">
                  Location-First (Məkan)
                </p>
                <p className="text-lg font-bold text-slate-100">
                  {formatCompactNumber(abHookMetrics.locationFirst.avgViews)} baxış
                </p>
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                  <span>Ort. Müştəri:</span>
                  <span className="font-mono text-emerald-400">
                    {abHookMetrics.locationFirst.avgLeads}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>NER Reytinq:</span>
                  <span className="font-mono font-bold text-sky-300">
                    {abHookMetrics.locationFirst.avgNer}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Duration Bucket: 25-30s vs 40-50s */}
          <div className="rounded-xl border border-slate-800 bg-obsidian-950/60 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">
                Xronometraj (Duration Bucket)
              </span>
              <span className="text-[11px] font-mono text-emerald-400">
                {abDurationMetrics.short.avgViews >=
                abDurationMetrics.long.avgViews
                  ? "⚡ 25–30s Daha Çox Baxılır"
                  : "⚡ 40–50s Daha Çox Baxılır"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-slate-800/90 bg-obsidian-900/90 p-3 space-y-1">
                <p className="text-[11px] font-semibold text-emerald-300">
                  25–30 san (Qısa)
                </p>
                <p className="text-lg font-bold text-slate-100">
                  {formatCompactNumber(abDurationMetrics.short.avgViews)} baxış
                </p>
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                  <span>Ort. Müştəri:</span>
                  <span className="font-mono text-emerald-400">
                    {abDurationMetrics.short.avgLeads}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>NER Reytinq:</span>
                  <span className="font-mono font-bold text-emerald-300">
                    {abDurationMetrics.short.avgNer}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/90 bg-obsidian-900/90 p-3 space-y-1">
                <p className="text-[11px] font-semibold text-violet-300">
                  40–50 san (Ətraflı)
                </p>
                <p className="text-lg font-bold text-slate-100">
                  {formatCompactNumber(abDurationMetrics.long.avgViews)} baxış
                </p>
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                  <span>Ort. Müştəri:</span>
                  <span className="font-mono text-violet-400">
                    {abDurationMetrics.long.avgLeads}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>NER Reytinq:</span>
                  <span className="font-mono font-bold text-violet-300">
                    {abDurationMetrics.long.avgNer}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 5. Top-Performing Video Leaderboard (Filtered by Niche)              */}
      {/* -------------------------------------------------------------------- */}
      <div className="exec-card p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-gold-500/15 p-1.5 text-gold-300 border border-gold-500/30">
              <Trophy className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                Top Video Reytinqi (Leaderboard - {activeNicheTab.label})
              </h2>
              <p className="text-[11px] text-slate-400">
                Ən çox baxış və müştəri sorğusu gətirən paylaşımlar (Fərdi Niş NER əsasında)
              </p>
            </div>
          </div>
          <span className="text-xs text-slate-400">
            Top {leaderboard.length} video
          </span>
        </div>

        {leaderboard.length === 0 ? (
          <div className="py-10 text-center text-slate-500 text-xs">
            Seçilmiş niş üzrə hələlik telemetriya toplanmış video paylaşımı yoxdur.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {leaderboard.map((item, index) => {
              const thumb = item.listing?.photo_urls?.[0];
              const rank = index + 1;
              const medalColor =
                rank === 1
                  ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                  : rank === 2
                    ? "bg-slate-300/20 text-slate-200 border-slate-400/40"
                    : rank === 3
                      ? "bg-amber-700/20 text-amber-600 border-amber-700/40"
                      : "bg-obsidian-950 text-slate-400 border-slate-800";

              const itemNiche =
                item.channel_niche || pubNicheMap.get(item.id) || "GENERAL";

              return (
                <div
                  key={item.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 hover:bg-obsidian-850/40 px-2 rounded-xl transition"
                >
                  <div className="flex items-center gap-3">
                    {/* Rank Badge */}
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border font-mono text-xs font-bold ${medalColor}`}
                    >
                      {rank}
                    </span>

                    {/* Thumbnail */}
                    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-slate-800 bg-obsidian-950">
                      {thumb ? (
                        <img
                          src={thumb}
                          alt="Listing thumb"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate-600">
                          <Video className="h-5 w-5" />
                        </div>
                      )}
                    </div>

                    {/* Listing Info */}
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        {item.listing?.bina_id && (
                          <Link
                            href={`/listings/${item.listing.bina_id}`}
                            className="font-mono text-xs font-bold text-gold-300 hover:underline"
                          >
                            #{item.listing.bina_id}
                          </Link>
                        )}
                        <span className="text-xs font-semibold text-slate-100 line-clamp-1">
                          {item.listing?.title ||
                            item.listing?.location ||
                            "Mənzil"}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                        {item.listing?.price_azn_normalized && (
                          <span className="font-semibold text-slate-300">
                            {formatAzn(item.listing.price_azn_normalized)}
                          </span>
                        )}
                        {item.render?.hook_type && (
                          <span className="rounded bg-obsidian-950 px-1.5 py-0.5 text-[10px] text-gold-400 border border-slate-800">
                            {HOOK_TYPE_LABELS[item.render.hook_type]}
                          </span>
                        )}
                        {item.render?.duration_bucket && (
                          <span className="rounded bg-obsidian-950 px-1.5 py-0.5 text-[10px] text-sky-400 border border-slate-800">
                            {DURATION_BUCKET_LABELS[item.render.duration_bucket]}
                          </span>
                        )}
                        <span className="rounded bg-obsidian-950 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 border border-slate-800">
                          {item.target_account_handle || itemNiche}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Metrics & Actions */}
                  <div className="flex items-center gap-4 sm:gap-6 self-end sm:self-center">
                    <div className="text-right">
                      <p className="text-xs font-bold text-slate-100 flex items-center gap-1 justify-end">
                        <Eye className="h-3 w-3 text-sky-400" />
                        <span>{formatCompactNumber(item.views_count)}</span>
                      </p>
                      <p className="text-[10px] text-slate-400">baxış</p>
                    </div>

                    <div className="text-right">
                      <p className="text-xs font-bold text-rose-300 flex items-center gap-1 justify-end">
                        <Heart className="h-3 w-3 text-rose-400" />
                        <span>{formatCompactNumber(item.likes_count)}</span>
                      </p>
                      <p className="text-[10px] text-slate-400">like</p>
                    </div>

                    <div className="text-right">
                      <p className="text-xs font-bold text-gold-300 flex items-center gap-1 justify-end">
                        <Users className="h-3 w-3 text-gold-400" />
                        <span>{item.leads_count || 0} lead</span>
                      </p>
                      <p className="text-[10px] text-slate-400">
                        NER: <span className="font-bold text-gold-300">{item.ner_score ?? "—"}</span>
                      </p>
                    </div>

                    {item.post_url && (
                      <a
                        href={item.post_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="exec-btn-secondary text-xs px-2.5 py-1.5 shrink-0"
                      >
                        <span>Aç</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 6. Live Social Comments Stream (Filtered by Niche & Intent)          */}
      {/* -------------------------------------------------------------------- */}
      <div className="exec-card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-emerald-500/15 p-1.5 text-emerald-300 border border-emerald-500/30">
              <MessageCircle className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                Canlı Sosial Şərhlər &amp; Alıcı Sorğuları Stream-i ({activeNicheTab.label})
              </h2>
              <p className="text-[11px] text-slate-400">
                Instagram Reels və TikTok-dan toplanan real vaxt şərhləri və süni intellekt təsnifatı
              </p>
            </div>
          </div>

          {/* Comment Stream Filter Tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCommentFilter("ALL")}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                commentFilter === "ALL"
                  ? "bg-gold-500/20 text-gold-300 border border-gold-500/40"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Hamısı ({nicheComments.length})
            </button>
            <button
              type="button"
              onClick={() => setCommentFilter("LEADS_ONLY")}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                commentFilter === "LEADS_ONLY"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              🎯 Alıcı Sorğuları (
              {
                nicheComments.filter(
                  (c) => c.is_intent_lead || c.buyer_lead_id !== null
                ).length
              }
              )
            </button>
            <button
              type="button"
              onClick={() => setCommentFilter("PRICE")}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                commentFilter === "PRICE"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Qiymət
            </button>
            <button
              type="button"
              onClick={() => setCommentFilter("MORTGAGE")}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                commentFilter === "MORTGAGE"
                  ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              İpoteka
            </button>
          </div>
        </div>

        {filteredComments.length === 0 ? (
          <div className="py-12 text-center text-slate-500 text-xs">
            Seçilmiş filtrə və nişə uyğun şərh tapılmadı.
          </div>
        ) : (
          <div className="space-y-3">
            {filteredComments.map((comment) => {
              const cleanHandle = comment.author_handle.replace(/^@/, "");
              const dmUrl = `https://ig.me/m/${cleanHandle}`;
              const categoryMeta =
                comment.intent_category &&
                INTENT_CATEGORY_META[comment.intent_category]
                  ? INTENT_CATEGORY_META[comment.intent_category]
                  : {
                      label: comment.intent_category || "Ümumi",
                      tone: "neutral" as const,
                    };

              return (
                <div
                  key={comment.id}
                  className="rounded-xl border border-slate-800 bg-obsidian-950/70 p-4 space-y-2.5 transition hover:border-slate-700"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-200 text-xs">
                        @{cleanHandle}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {formatRelativeAz(comment.created_at)}
                      </span>

                      {/* Intent Classification Tag */}
                      <StatusBadge
                        label={categoryMeta.label}
                        tone={categoryMeta.tone}
                      />

                      {/* Captured Lead Indicator */}
                      {(comment.is_intent_lead || comment.buyer_lead_id) && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-950/80 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                          <Sparkles className="h-3 w-3" />
                          <span>CRM Alıcı</span>
                        </span>
                      )}
                    </div>

                    {comment.listing?.bina_id && (
                      <Link
                        href={`/listings/${comment.listing.bina_id}`}
                        className="text-[11px] font-mono text-gold-400 hover:underline"
                      >
                        Elan #{comment.listing.bina_id}
                      </Link>
                    )}
                  </div>

                  {/* Comment Text */}
                  <p className="text-xs text-slate-100 bg-obsidian-900/90 p-2.5 rounded-lg border border-slate-850">
                    &ldquo;{comment.comment_text}&rdquo;
                  </p>

                  {/* Suggested AI Reply & Action Buttons */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
                    {comment.suggested_reply ? (
                      <p className="text-[11px] text-slate-400 line-clamp-1 italic">
                        <span className="text-gold-400 font-medium">
                          Təklif olunan cavab:
                        </span>{" "}
                        {comment.suggested_reply}
                      </p>
                    ) : (
                      <span className="text-[11px] text-slate-500">
                        Cavab göndərilməyib
                      </span>
                    )}

                    <div className="flex items-center gap-2 shrink-0">
                      {comment.buyer_lead_id && (
                        <Link
                          href="/leads"
                          className="exec-btn-secondary text-[11px] py-1 px-2.5"
                        >
                          <Users className="h-3 w-3 text-gold-400" />
                          <span>Müştəri Kartı</span>
                        </Link>
                      )}

                      <a
                        href={dmUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25 transition"
                      >
                        <Send className="h-3 w-3" />
                        <span>DM-də Cavab Ver</span>
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
