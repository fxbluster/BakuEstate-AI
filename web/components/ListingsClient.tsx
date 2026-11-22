"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Building2,
  ExternalLink,
  FileCheck2,
  Film,
  Search,
  Send,
  SlidersHorizontal,
  ArrowUpRight,
  ArrowUpDown,
  X,
  MessageCircle,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PreflightModal } from "./PreflightModal";
import { sortListings, SORT_OPTIONS, type SortMode } from "@/lib/listing-sorter";
import {
  ARCHETYPE_LABELS,
  type BadgeTone,
  DUPLICATE_RESOLUTION_META,
  EDITORIAL_STATUS_META,
  formatAzn,
  formatBakuDate,
  formatCompactNumber,
  formatPrice,
  OWNER_OUTREACH_META,
  RENDER_STATUS_META,
  SOURCE_AVAILABILITY_META,
} from "@/lib/format";
import type {
  Archetype,
  ChannelNiche,
  EditorialStatus,
  Listing,
  Publication,
  PublicationChannel,
  RenderStatus,
  SourceAvailability,
} from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

export interface ListingWithLatestRender extends Listing {
  latestRender?: {
    id?: string;
    version_num: number;
    status: RenderStatus;
    video_cdn_url: string | null;
    hook_type?: string | null;
    duration_bucket?: string | null;
    rendered_price?: number | null;
    rendered_currency?: string | null;
    created_at?: string | null;
    completed_at?: string | null;
  } | null;
  publication?: Publication | null;
}

interface ListingsClientProps {
  initialListings: ListingWithLatestRender[];
}

function getWhatsAppUrl(
  phoneRaw: string | null | undefined,
  binaId: string | number
): string | null {
  if (!phoneRaw) return null;
  const digits = phoneRaw.replace(/\D/g, "");
  if (!digits) return null;
  let normalized = digits;
  if (normalized.startsWith("0")) {
    normalized = `994${normalized.slice(1)}`;
  } else if (!normalized.startsWith("994")) {
    normalized = `994${normalized}`;
  }
  const text = encodeURIComponent(
    `Salam, bina.az-dakı #${binaId} nömrəli elanınızla bağlı narahat edirəm.`
  );
  return `https://wa.me/${normalized}?text=${text}`;
}

export function resolveListingNiche(item: ListingWithLatestRender): {
  niche: ChannelNiche;
  handle: string;
} {
  if (item.publication?.channel_niche) {
    const niche = item.publication.channel_niche;
    const handle =
      item.publication.target_account_handle ||
      (niche === "LUXURY"
        ? "@bakuestate.premium"
        : niche === "AFFORDABLE"
        ? "@baku.serfeli.evler"
        : niche === "TIKTOK"
        ? "@baku_emlak_ai"
        : "@bakuestate.official");
    return { niche, handle };
  }

  if (item.publication?.target_account_handle) {
    const handle = item.publication.target_account_handle;
    if (handle.includes("premium")) return { niche: "LUXURY", handle };
    if (handle.includes("serfeli")) return { niche: "AFFORDABLE", handle };
    if (handle.includes("emlak_ai")) return { niche: "TIKTOK", handle };
    return { niche: "GENERAL", handle };
  }

  // Fallback precedence based on deterministic waterfall:
  // Priority 1: High price drop (>= 10%) or urgent/viral
  const priceDrop = Number(
    (item as unknown as { price_drop_pct?: number }).price_drop_pct || 0
  );
  if (priceDrop >= 10.0) {
    return { niche: "TIKTOK", handle: "@baku_emlak_ai" };
  }

  // Priority 2: Price Dominance
  const priceAzn = item.price_azn_normalized || 0;
  if (priceAzn >= 250000) {
    return { niche: "LUXURY", handle: "@bakuestate.premium" };
  } else if (priceAzn > 0 && priceAzn < 150000) {
    return { niche: "AFFORDABLE", handle: "@baku.serfeli.evler" };
  } else {
    return { niche: "GENERAL", handle: "@bakuestate.official" };
  }
}

export function ListingsClient({ initialListings }: ListingsClientProps) {
  const [listings, setListings] =
    useState<ListingWithLatestRender[]>(initialListings);
  const [activeTab, setActiveTab] = useState<
    "ALL" | "DRAFTS" | "PUBLISHED"
  >("ALL");
  const [query, setQuery] = useState("");
  const [editorialFilter, setEditorialFilter] = useState<
    EditorialStatus | "ALL"
  >("ALL");
  const [availabilityFilter, setAvailabilityFilter] = useState<
    SourceAvailability | "ALL"
  >("ALL");
  const [archetypeFilter, setArchetypeFilter] = useState<Archetype | "ALL">(
    "ALL"
  );
  const [kupcaFilter, setKupcaFilter] = useState<"ALL" | "YES" | "NO">("ALL");
  const [duplicateFilter, setDuplicateFilter] = useState<
    "ALL" | "PENDING_REVIEW" | "CONFIRMED_DUPLICATE" | "CLEAN"
  >("ALL");
  const [nicheFilter, setNicheFilter] = useState<ChannelNiche | "ALL">("ALL");
  const [sortMode, setSortMode] = useState<SortMode>("DEFAULT");

  // Modal state for publishing
  const [selectedListingForPublish, setSelectedListingForPublish] =
    useState<ListingWithLatestRender | null>(null);
  const [publishUrl, setPublishUrl] = useState("");
  const [publishChannel, setPublishChannel] =
    useState<PublicationChannel>("INSTAGRAM_REELS");
  const [publishNotes, setPublishNotes] = useState("");
  const [submittingPublish, setSubmittingPublish] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  // Modal state for pre-flight verification
  const [selectedListingForPreflight, setSelectedListingForPreflight] =
    useState<ListingWithLatestRender | null>(null);

  // Segment counts computed over all current listings
  const counts = useMemo(() => {
    let drafts = 0;
    let published = 0;
    for (const item of listings) {
      if (item.publication?.status === "PUBLISHED") {
        published++;
      } else if (
        item.latestRender?.status === "COMPLETED" &&
        (!item.publication ||
          item.publication.status === "DRAFT_READY" ||
          item.publication.status === "READY_TO_PUBLISH")
      ) {
        drafts++;
      }
    }
    return {
      all: listings.length,
      drafts,
      published,
    };
  }, [listings]);

  // Channel Niche counts respecting the active lifecycle tab
  const nicheCounts = useMemo(() => {
    let luxury = 0;
    let affordable = 0;
    let general = 0;
    let tiktok = 0;

    for (const item of listings) {
      if (activeTab === "DRAFTS") {
        const isDraft =
          item.latestRender?.status === "COMPLETED" &&
          (!item.publication ||
            item.publication.status === "DRAFT_READY" ||
            item.publication.status === "READY_TO_PUBLISH");
        if (!isDraft) continue;
      } else if (activeTab === "PUBLISHED") {
        if (item.publication?.status !== "PUBLISHED") continue;
      }

      const { niche } = resolveListingNiche(item);
      if (niche === "LUXURY") luxury++;
      else if (niche === "AFFORDABLE") affordable++;
      else if (niche === "TIKTOK") tiktok++;
      else general++;
    }

    return {
      all:
        activeTab === "DRAFTS"
          ? counts.drafts
          : activeTab === "PUBLISHED"
          ? counts.published
          : counts.all,
      luxury,
      affordable,
      general,
      tiktok,
    };
  }, [listings, activeTab, counts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = listings.filter((item) => {
      // Top Segmented Tab filtering
      if (activeTab === "DRAFTS") {
        const isDraft =
          item.latestRender?.status === "COMPLETED" &&
          (!item.publication ||
            item.publication.status === "DRAFT_READY" ||
            item.publication.status === "READY_TO_PUBLISH");
        if (!isDraft) return false;
      } else if (activeTab === "PUBLISHED") {
        if (item.publication?.status !== "PUBLISHED") return false;
      }

      // Secondary Channel Niche filter
      if (nicheFilter !== "ALL") {
        const { niche } = resolveListingNiche(item);
        if (niche !== nicheFilter) return false;
      }

      // Secondary filters
      if (
        editorialFilter !== "ALL" &&
        item.editorial_status !== editorialFilter
      )
        return false;
      if (
        availabilityFilter !== "ALL" &&
        item.source_availability !== availabilityFilter
      )
        return false;
      if (archetypeFilter !== "ALL" && item.archetype !== archetypeFilter)
        return false;
      if (kupcaFilter === "YES" && !item.has_bill_of_sale) return false;
      if (kupcaFilter === "NO" && item.has_bill_of_sale) return false;
      if (
        duplicateFilter === "PENDING_REVIEW" &&
        item.duplicate_resolution !== "PENDING_REVIEW"
      )
        return false;
      if (
        duplicateFilter === "CONFIRMED_DUPLICATE" &&
        item.duplicate_resolution !== "CONFIRMED_DUPLICATE"
      )
        return false;
      if (
        duplicateFilter === "CLEAN" &&
        (item.duplicate_resolution === "PENDING_REVIEW" ||
          item.duplicate_resolution === "CONFIRMED_DUPLICATE")
      )
        return false;

      if (q) {
        const haystack = [
          item.bina_id,
          item.title,
          item.location,
          item.district_normalized,
          item.address,
          item.owner_phone_raw,
          item.owner_phone_normalized,
          item.contact_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    return sortListings(matched, sortMode);
  }, [
    listings,
    activeTab,
    nicheFilter,
    query,
    editorialFilter,
    availabilityFilter,
    archetypeFilter,
    kupcaFilter,
    duplicateFilter,
    sortMode,
  ]);

  function resetFilters() {
    setQuery("");
    setSortMode("DEFAULT");
    setNicheFilter("ALL");
    setEditorialFilter("ALL");
    setAvailabilityFilter("ALL");
    setArchetypeFilter("ALL");
    setKupcaFilter("ALL");
    setDuplicateFilter("ALL");
  }

  function openPublishModal(item: ListingWithLatestRender) {
    setSelectedListingForPublish(item);
    setPublishUrl(item.publication?.post_url || "");
    setPublishChannel(item.publication?.channel || "INSTAGRAM_REELS");
    setPublishNotes(item.publication?.notes || "");
  }

  async function handleConfirmPublish(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedListingForPublish || !publishUrl.trim()) return;

    setSubmittingPublish(true);
    setFeedback(null);
    const supabase = createClient();
    const cleanUrl = publishUrl.trim();

    // Auto-detect channel if matched
    let channel: PublicationChannel = publishChannel;
    if (cleanUrl.includes("tiktok.com")) {
      channel = "TIKTOK";
    } else if (cleanUrl.includes("instagram.com")) {
      channel = "INSTAGRAM_REELS";
    }

    try {
      let pubId = selectedListingForPublish.publication?.id;
      const nowIso = new Date().toISOString();
      const nextPollIso = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

      if (pubId) {
        const { error: pubErr } = await supabase
          .from("publications")
          .update({
            status: "PUBLISHED",
            channel,
            post_url: cleanUrl,
            published_at: nowIso,
            telemetry_status: "ACTIVE",
            next_poll_at: nextPollIso,
            notes: publishNotes.trim() || null,
          })
          .eq("id", pubId);
        if (pubErr) throw pubErr;
      } else {
        const { data: newPub, error: insertErr } = await supabase
          .from("publications")
          .insert({
            listing_id: selectedListingForPublish.id,
            render_version_id: selectedListingForPublish.latestRender?.id || null,
            channel,
            post_url: cleanUrl,
            status: "PUBLISHED",
            published_at: nowIso,
            telemetry_status: "ACTIVE",
            next_poll_at: nextPollIso,
            notes: publishNotes.trim() || null,
          })
          .select()
          .single();
        if (insertErr) throw insertErr;
        pubId = newPub.id;
      }

      // Update listings table editorial_status to PUBLISHED
      await supabase
        .from("listings")
        .update({ editorial_status: "PUBLISHED" })
        .eq("id", selectedListingForPublish.id);

      // Audit event
      await supabase.from("listing_events").insert({
        listing_id: selectedListingForPublish.id,
        event_type: "STATUS_CHANGED",
        old_value_json: {
          editorial_status: selectedListingForPublish.editorial_status,
        },
        new_value_json: {
          editorial_status: "PUBLISHED",
          post_url: cleanUrl,
        },
        actor: "web_user",
      });

      // Immediate SYNC_SOCIAL_METRICS job
      await supabase.from("pipeline_jobs").insert({
        idempotency_key: `sync_social_${pubId}_${Date.now()}`,
        job_type: "SYNC_SOCIAL_METRICS",
        listing_id: selectedListingForPublish.id,
        trigger_source: "WEB_UI",
        params_json: {
          publication_id: pubId,
          post_url: cleanUrl,
          channel,
        },
        status: "QUEUED",
      });

      // Update local state so tab reflects immediately
      setListings((prev) =>
        prev.map((item) => {
          if (item.id === selectedListingForPublish.id) {
            return {
              ...item,
              editorial_status: "PUBLISHED",
              publication: {
                ...(item.publication || ({} as Publication)),
                id: pubId!,
                listing_id: item.id,
                render_version_id:
                  selectedListingForPublish.latestRender?.id || null,
                channel,
                post_url: cleanUrl,
                caption_used: null,
                status: "PUBLISHED",
                published_at: nowIso,
                notes: publishNotes.trim() || null,
                views_count: item.publication?.views_count || 0,
                likes_count: item.publication?.likes_count || 0,
                comments_count: item.publication?.comments_count || 0,
                shares_count: item.publication?.shares_count || 0,
                external_post_id: null,
                telemetry_status: "ACTIVE",
                last_scraped_at: null,
                next_poll_at: nextPollIso,
                created_at: item.publication?.created_at || nowIso,
              },
            };
          }
          return item;
        })
      );

      setFeedback({
        type: "ok",
        text: `🚀 Elan #${selectedListingForPublish.bina_id} uğurla yayımlandı və telemetriya monitorinqi aktivləşdirildi!`,
      });
      setSelectedListingForPublish(null);
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Yayımlama xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setSubmittingPublish(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-400">
            Vahid Postgres Reyestri
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Elanlar Reyestri
          </h1>
        </div>
        <p className="text-xs text-slate-400">
          Göstərilir:{" "}
          <span className="font-semibold text-slate-100">{filtered.length}</span>{" "}
          / {listings.length} elan
        </p>
      </div>

      {/* Segmented Top Tabs */}
      <div className="flex flex-wrap items-center gap-2 p-1.5 rounded-2xl border border-slate-800/80 bg-obsidian-900/80 backdrop-blur-md">
        <button
          type="button"
          onClick={() => setActiveTab("ALL")}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
            activeTab === "ALL"
              ? "bg-gold-500/20 text-gold-300 border border-gold-500/40 shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <Building2 className="h-3.5 w-3.5" />
          <span>Bütün Elanlar</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] text-slate-400">
            {counts.all}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("DRAFTS")}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
            activeTab === "DRAFTS"
              ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <Film className="h-3.5 w-3.5" />
          <span>🎬 Yayıma Hazır Qaralamalar</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-amber-300">
            {counts.drafts}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("PUBLISHED")}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
            activeTab === "PUBLISHED"
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <Send className="h-3.5 w-3.5" />
          <span>🚀 Canlı Yayımda Olanlar</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-emerald-300">
            {counts.published}
          </span>
        </button>
      </div>

      {/* Secondary Filter Pill Row for Channel Niches */}
      <div className="flex flex-wrap items-center gap-2 p-1.5 rounded-2xl border border-slate-800/80 bg-obsidian-900/60 backdrop-blur-md">
        <span className="text-[11px] font-semibold text-slate-400 pl-2 pr-1 uppercase tracking-wider">
          Kanal / Niche:
        </span>

        <button
          type="button"
          onClick={() => setNicheFilter("ALL")}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
            nicheFilter === "ALL"
              ? "bg-gold-500/20 text-gold-300 border border-gold-500/40 shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <span>Hamısı</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
            {nicheCounts.all}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setNicheFilter("LUXURY")}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
            nicheFilter === "LUXURY"
              ? "bg-amber-500/20 text-amber-300 border border-amber-400/50 shadow-sm"
              : "text-slate-400 hover:text-amber-300 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <span>💎 @bakuestate.premium</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-amber-300">
            {nicheCounts.luxury}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setNicheFilter("AFFORDABLE")}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
            nicheFilter === "AFFORDABLE"
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/50 shadow-sm"
              : "text-slate-400 hover:text-emerald-300 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <span>🏠 @baku.serfeli.evler</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-emerald-300">
            {nicheCounts.affordable}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setNicheFilter("GENERAL")}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
            nicheFilter === "GENERAL"
              ? "bg-sky-500/20 text-sky-300 border border-sky-400/50 shadow-sm"
              : "text-slate-400 hover:text-sky-300 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <span>🏢 @bakuestate.official</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-sky-300">
            {nicheCounts.general}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setNicheFilter("TIKTOK")}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition ${
            nicheFilter === "TIKTOK"
              ? "bg-rose-500/20 text-rose-300 border border-rose-400/50 shadow-sm"
              : "text-slate-400 hover:text-rose-300 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <span>🔥 @baku_emlak_ai</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-rose-300">
            {nicheCounts.tiktok}
          </span>
        </button>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${
            feedback.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs opacity-75 hover:opacity-100"
          >
            Bağla
          </button>
        </div>
      )}

      {/* Search & Filter Panel */}
      <div className="exec-card p-4 space-y-3">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Axtar: bina_id, ünvan, rayon, başlıq və ya mülkiyyətçi telefonu..."
              className="exec-input pl-10"
            />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ArrowUpDown className="h-4 w-4 text-gold-400 shrink-0" />
            <select
              aria-label="Sıralama rejimi"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="exec-select text-xs min-w-[210px]"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <select
            aria-label="Redaksiya statusu"
            value={editorialFilter}
            onChange={(e) =>
              setEditorialFilter(e.target.value as EditorialStatus | "ALL")
            }
            className="exec-select text-xs"
          >
            <option value="ALL">Bütün redaksiya</option>
            {Object.entries(EDITORIAL_STATUS_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Mənbə aktivliyi"
            value={availabilityFilter}
            onChange={(e) =>
              setAvailabilityFilter(
                e.target.value as SourceAvailability | "ALL"
              )
            }
            className="exec-select text-xs"
          >
            <option value="ALL">Bütün aktivlik</option>
            {Object.entries(SOURCE_AVAILABILITY_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Arxetip"
            value={archetypeFilter}
            onChange={(e) =>
              setArchetypeFilter(e.target.value as Archetype | "ALL")
            }
            className="exec-select text-xs"
          >
            <option value="ALL">Bütün arxetiplər</option>
            {Object.entries(ARCHETYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>

          <select
            aria-label="Kupça"
            value={kupcaFilter}
            onChange={(e) =>
              setKupcaFilter(e.target.value as "ALL" | "YES" | "NO")
            }
            className="exec-select text-xs"
          >
            <option value="ALL">Kupça: Hamısı</option>
            <option value="YES">Kupçalı</option>
            <option value="NO">Kupçasız</option>
          </select>

          <select
            aria-label="Təkrar filtri"
            value={duplicateFilter}
            onChange={(e) =>
              setDuplicateFilter(
                e.target.value as
                  | "ALL"
                  | "PENDING_REVIEW"
                  | "CONFIRMED_DUPLICATE"
                  | "CLEAN"
              )
            }
            className="exec-select text-xs"
          >
            <option value="ALL">Təkrar: Hamısı</option>
            <option value="PENDING_REVIEW">Şübhəli Təkrar</option>
            <option value="CONFIRMED_DUPLICATE">Təsdiqlənmiş Təkrar</option>
            <option value="CLEAN">Yalnız Təkrarsız</option>
          </select>

          <button
            type="button"
            onClick={resetFilters}
            className="exec-btn-secondary text-xs py-2"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Sıfırla</span>
          </button>
        </div>
      </div>

      {/* Listings Grid */}
      {filtered.length === 0 ? (
        <div className="exec-card flex flex-col items-center justify-center py-14 text-center px-6">
          <Building2 className="h-10 w-10 text-slate-600" />
          <p className="mt-3 text-sm font-medium text-slate-200">
            Filtrə uyğun elan tapılmadı
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Axtarış mətnini və ya filtrləri dəyişdirərək yenidən yoxlayın.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => {
            const thumb = Array.isArray(item.photo_urls)
              ? item.photo_urls[0]
              : undefined;
            const edMeta = EDITORIAL_STATUS_META[item.editorial_status] ?? {
              label: item.editorial_status || "Baxış gözləyir",
              tone: "amber" as BadgeTone,
            };
            const avMeta = SOURCE_AVAILABILITY_META[item.source_availability] ?? {
              label: item.source_availability || "Aktiv",
              tone: "emerald" as BadgeTone,
            };
            const ownerMeta = OWNER_OUTREACH_META[item.owner_outreach_status] ?? {
              label: item.owner_outreach_status || "Əlaqə yoxdur",
              tone: "neutral" as BadgeTone,
            };
            const dupMeta =
              DUPLICATE_RESOLUTION_META[item.duplicate_resolution] ?? {
                label: item.duplicate_resolution || "Təkrarsız",
                tone: "neutral" as BadgeTone,
              };
            const render = item.latestRender;
            const pub = item.publication;
            const isDraftReady =
              render?.status === "COMPLETED" &&
              (!pub ||
                pub.status === "DRAFT_READY" ||
                pub.status === "READY_TO_PUBLISH");
            const isLive = pub?.status === "PUBLISHED";
            const ownerPhone = item.owner_phone_raw || item.owner_phone_normalized;
            const waUrl = getWhatsAppUrl(ownerPhone, item.bina_id);
            const nicheInfo = resolveListingNiche(item);

            return (
              <div
                key={item.id}
                className="exec-card group overflow-hidden flex flex-col transition hover:border-gold-500/45"
              >
                <Link
                  href={`/listings/${item.bina_id}`}
                  className="block relative h-44 w-full bg-obsidian-950 overflow-hidden"
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={item.title || `Elan #${item.bina_id}`}
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-slate-600">
                      <Building2 className="h-10 w-10" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-obsidian-950 via-obsidian-950/20 to-transparent" />

                  <div className="absolute top-3 left-3 flex flex-wrap gap-1.5 max-w-[85%]">
                    <span className="rounded-lg bg-obsidian-950/85 px-2 py-0.5 font-mono text-xs font-semibold text-gold-300 border border-gold-500/30">
                      #{item.bina_id}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold backdrop-blur-md ${
                        nicheInfo.niche === "LUXURY"
                          ? "border-amber-400/50 bg-amber-950/85 text-amber-200"
                          : nicheInfo.niche === "AFFORDABLE"
                          ? "border-emerald-400/50 bg-emerald-950/85 text-emerald-200"
                          : nicheInfo.niche === "TIKTOK"
                          ? "border-rose-400/50 bg-rose-950/85 text-rose-200"
                          : "border-sky-400/50 bg-sky-950/85 text-sky-200"
                      }`}
                    >
                      <span>
                        {nicheInfo.niche === "LUXURY"
                          ? "💎"
                          : nicheInfo.niche === "AFFORDABLE"
                          ? "🏠"
                          : nicheInfo.niche === "TIKTOK"
                          ? "🔥"
                          : "🏢"}
                      </span>
                      <span>{nicheInfo.handle}</span>
                    </span>
                    <StatusBadge
                      label={ARCHETYPE_LABELS[item.archetype]}
                      tone="neutral"
                    />
                    {item.has_bill_of_sale && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-950/85 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                        <FileCheck2 className="h-3 w-3" />
                        Kupça
                      </span>
                    )}
                  </div>

                  {/* Video Version Indicator */}
                  <div className="absolute top-3 right-3">
                    {render ? (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold backdrop-blur-sm ${
                          render.status === "COMPLETED"
                            ? "border-emerald-500/50 bg-emerald-950/85 text-emerald-200"
                            : render.status === "FAILED"
                              ? "border-rose-500/50 bg-rose-950/85 text-rose-200"
                              : "border-violet-500/50 bg-violet-950/85 text-violet-200"
                        }`}
                      >
                        <Film className="h-3 w-3" />
                        v{render.version_num} •{" "}
                        {(RENDER_STATUS_META[render.status] ?? { label: render.status }).label}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-obsidian-950/80 px-2.5 py-0.5 text-[11px] text-slate-400">
                        <Film className="h-3 w-3" />
                        Video yoxdur
                      </span>
                    )}
                  </div>

                  {/* Price Overlay */}
                  <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between">
                    <div>
                      <p className="text-xl font-bold text-slate-50 drop-shadow">
                        {formatAzn(item.price_azn_normalized)}
                      </p>
                      {item.currency !== "AZN" && item.price !== null && (
                        <p className="text-[11px] text-slate-300">
                          Orijinal: {formatPrice(item.price, item.currency)}
                        </p>
                      )}
                    </div>
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-obsidian-950/80 text-gold-300 border border-slate-700 transition group-hover:border-gold-400">
                      <ArrowUpRight className="h-4 w-4" />
                    </span>
                  </div>
                </Link>

                {/* Body */}
                <div className="flex flex-1 flex-col justify-between p-4 space-y-3">
                  <Link href={`/listings/${item.bina_id}`} className="space-y-1.5 block">
                    <h3 className="text-sm font-semibold text-slate-100 line-clamp-2 group-hover:text-gold-300 transition">
                      {item.title || item.address || `Elan #${item.bina_id}`}
                    </h3>
                    <p className="text-xs text-slate-400 line-clamp-1">
                      {item.location || item.district_normalized || "Bakı"} •{" "}
                      {item.rooms ?? "?"} otaq • {item.area ?? "?"} m²
                      {item.floor !== null && item.floors !== null
                        ? ` • ${item.floor}/${item.floors} mərt.`
                        : ""}
                    </p>
                  </Link>

                  <div className="space-y-2 border-t border-slate-800/80 pt-3">
                    <div className="flex flex-wrap gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          nicheInfo.niche === "LUXURY"
                            ? "border-amber-400/40 bg-amber-950/70 text-amber-300"
                            : nicheInfo.niche === "AFFORDABLE"
                            ? "border-emerald-400/40 bg-emerald-950/70 text-emerald-300"
                            : nicheInfo.niche === "TIKTOK"
                            ? "border-rose-400/40 bg-rose-950/70 text-rose-300"
                            : "border-sky-400/40 bg-sky-950/70 text-sky-300"
                        }`}
                      >
                        <span>
                          {nicheInfo.niche === "LUXURY"
                            ? "💎"
                            : nicheInfo.niche === "AFFORDABLE"
                            ? "🏠"
                            : nicheInfo.niche === "TIKTOK"
                            ? "🔥"
                            : "🏢"}
                        </span>
                        <span>{nicheInfo.handle}</span>
                      </span>
                      <StatusBadge label={edMeta.label} tone={edMeta.tone} />
                      <StatusBadge label={avMeta.label} tone={avMeta.tone} />
                      <StatusBadge
                        label={ownerMeta.label}
                        tone={ownerMeta.tone}
                      />
                      {item.duplicate_resolution !== "NONE" && (
                        <StatusBadge
                          label={dupMeta.label}
                          tone={dupMeta.tone}
                        />
                      )}
                      {/* Preflight verification badge */}
                      {pub?.preflight_status === "PASSED" ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-950/85 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                          <span>✅ Yoxlanılıb</span>
                        </span>
                      ) : pub?.preflight_status === "PRICE_CHANGED" ||
                        pub?.preflight_status === "PRICE_MISMATCH" ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-950/85 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                          <AlertTriangle className="h-3 w-3 text-amber-400" />
                          <span>⚠️ Qiymət Dəyişib</span>
                        </span>
                      ) : pub?.preflight_status === "REMOVED_ON_BINA" ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-950/85 px-2 py-0.5 text-[11px] font-semibold text-rose-300">
                          <span>❌ bina.az-dan Silinib</span>
                        </span>
                      ) : null}
                    </div>

                    {/* Prominent Action for Drafts */}
                    {isDraftReady && (
                      <div className="space-y-2 mt-2">
                        {/* Owner phone badge with 1-click WhatsApp launcher */}
                        {waUrl && (
                          <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-950/30 px-3 py-1.5 text-xs">
                            <span className="text-slate-400 flex items-center gap-1.5 truncate">
                              <span>Mülkiyyətçi:</span>
                              <span className="font-mono text-slate-200">
                                {item.contact_name || ownerPhone}
                              </span>
                            </span>
                            <a
                              href={waUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 px-2 py-0.5 font-semibold text-emerald-300 hover:bg-emerald-500/25 transition flex-shrink-0"
                            >
                              <MessageCircle className="h-3.5 w-3.5 text-emerald-400" />
                              <span>WhatsApp</span>
                            </a>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              setSelectedListingForPreflight(item);
                            }}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-blue-600 px-2.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.99]"
                          >
                            <Search className="h-3.5 w-3.5" />
                            <span>🔍 Yoxla və Göndər</span>
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              openPublishModal(item);
                            }}
                            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-2.5 py-2 text-xs font-semibold text-slate-950 shadow-sm transition hover:brightness-110 active:scale-[0.99]"
                          >
                            <Send className="h-3.5 w-3.5" />
                            <span>🚀 Paylaşıldı</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Telemetry info for Live Published */}
                    {isLive && pub && (
                      <div className="mt-2 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-950/40 px-3 py-2 text-xs">
                        <span className="inline-flex items-center gap-1.5 text-emerald-300 font-medium">
                          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                          <span>{formatCompactNumber(pub.views_count)} baxış</span>
                          <span className="text-slate-500">•</span>
                          <span>{formatCompactNumber(pub.likes_count)} like</span>
                        </span>
                        {pub.post_url && (
                          <a
                            href={pub.post_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-semibold text-gold-400 hover:text-gold-300"
                          >
                            <span>Link</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                      <span>Son görünmə: {formatBakuDate(item.last_seen_at)}</span>
                      {ownerPhone && (
                        waUrl ? (
                          <a
                            href={waUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-emerald-300 transition hover:bg-emerald-500/20"
                            title="1-kliklə WhatsApp-da aç"
                          >
                            <MessageCircle className="h-3 w-3 text-emerald-400" />
                            <span>{ownerPhone}</span>
                          </a>
                        ) : (
                          <span className="font-mono text-slate-400">
                            {ownerPhone}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Post URL Publish Modal Dialog */}
      {selectedListingForPublish && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-obsidian-950/80 p-4 backdrop-blur-md">
          <div className="exec-card w-full max-w-lg p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between border-b border-slate-800/80 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                  Sosial Şəbəkə Yayımlanması
                </p>
                <h3 className="mt-1 text-lg font-bold text-slate-100">
                  🚀 Elan #{selectedListingForPublish.bina_id} Paylaşıldı
                </h3>
                <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">
                  {selectedListingForPublish.title ||
                    selectedListingForPublish.address ||
                    "Bakı"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedListingForPublish(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-obsidian-850 hover:text-slate-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleConfirmPublish} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Sosial Şəbəkə Kanalı
                </label>
                <select
                  value={publishChannel}
                  onChange={(e) =>
                    setPublishChannel(e.target.value as PublicationChannel)
                  }
                  className="exec-select w-full text-xs"
                >
                  <option value="INSTAGRAM_REELS">Instagram Reels</option>
                  <option value="TIKTOK">TikTok</option>
                  <option value="YOUTUBE_SHORTS">YouTube Shorts</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Canlı Video Linki (Instagram Reels və ya TikTok URL) *
                </label>
                <input
                  type="url"
                  required
                  value={publishUrl}
                  onChange={(e) => {
                    const val = e.target.value;
                    setPublishUrl(val);
                    if (val.includes("tiktok.com")) {
                      setPublishChannel("TIKTOK");
                    } else if (val.includes("instagram.com")) {
                      setPublishChannel("INSTAGRAM_REELS");
                    }
                  }}
                  placeholder="https://www.instagram.com/reel/C7xyz... və ya https://www.tiktok.com/@baku/video/..."
                  className="exec-input text-xs"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Link daxil edildikdə dərhal telemetriya və şərhlər üzrə müştəri tutma robotu işə düşəcək.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Qeyd (İxtiyari)
                </label>
                <textarea
                  rows={2}
                  value={publishNotes}
                  onChange={(e) => setPublishNotes(e.target.value)}
                  placeholder="Məs: Musiqi trendi istifadə edildi, bio linki yeniləndi..."
                  className="exec-input text-xs"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-800/80">
                <button
                  type="button"
                  disabled={submittingPublish}
                  onClick={() => setSelectedListingForPublish(null)}
                  className="exec-btn-secondary text-xs"
                >
                  Ləğv et
                </button>
                <button
                  type="submit"
                  disabled={submittingPublish || !publishUrl.trim()}
                  className="exec-btn-primary text-xs"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>
                    {submittingPublish
                      ? "Yadda saxlanılır..."
                      : "Təsdiqlə & Telemetriya Başlat"}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pre-Flight Verification Modal Dialog */}
      <PreflightModal
        isOpen={!!selectedListingForPreflight}
        onClose={() => setSelectedListingForPreflight(null)}
        listing={selectedListingForPreflight}
        onListingUpdated={(updated) => {
          setListings((prev) =>
            prev.map((item) => (item.id === updated.id ? updated : item))
          );
        }}
      />
    </div>
  );
}
