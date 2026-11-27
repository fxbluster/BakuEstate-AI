"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  Plus,
  Search,
  Send,
  SlidersHorizontal,
  ArrowUpRight,
  ArrowUpDown,
  Upload,
  X,
  MessageCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { resolveCanonicalListingNiche } from "@/lib/niche-router";
import { PreflightModal } from "./PreflightModal";
import { sortListings, SORT_OPTIONS, type SortMode } from "@/lib/listing-sorter";
import {
  ARCHETYPE_LABELS,
  type BadgeTone,
  EDITORIAL_STATUS_META,
  formatAzn,
  formatBakuDate,
  formatCompactNumber,
  formatPrice,
  SOURCE_AVAILABILITY_META,
} from "@/lib/format";
import type {
  AgencyRole,
  Archetype,
  ChannelNiche,
  EditorialStatus,
  Listing,
  PaginatedResult,
  Publication,
  PublicationChannel,
  RenderStatus,
  SocialChannelProfile,
  SourceAvailability,
} from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

export interface ListingWithLatestRender extends Listing {
  source_type?: "BINA_AZ" | "OFF_MARKET";
  canonical_niche?: ChannelNiche;
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

export interface ListingsFilterState {
  search?: string;
  niche?: string;
  editorial?: string;
  availability?: string;
  archetype?: string;
  kupca?: string;
  duplicate?: string;
  tab?: string;
  sort?: string;
}

export interface ListingsServerTabCounts {
  all: number;
  noVideo?: number;
  drafts: number;
  published: number;
}

export function getUnifiedListingStatus(item: ListingWithLatestRender): {
  label: string;
  tone: BadgeTone;
} {
  if (item.source_availability === "CONFIRMED_SOLD") {
    return { label: "Satılıb", tone: "neutral" };
  }
  if (
    item.source_availability === "REMOVED_ON_BINA" ||
    item.editorial_status === "ARCHIVED" ||
    item.editorial_status === "REJECTED"
  ) {
    return { label: "Arxiv", tone: "neutral" };
  }
  if (item.publication?.status === "PUBLISHED") {
    return { label: "Paylaşıldı", tone: "emerald" };
  }
  if (
    item.latestRender?.status === "RUNNING" ||
    item.pipeline_status === "RENDERING"
  ) {
    return { label: "Montaj Olunur", tone: "violet" };
  }
  if (
    item.latestRender?.status === "QUEUED" ||
    item.pipeline_status === "QUEUED"
  ) {
    return { label: "Növbədə", tone: "sky" };
  }
  if (
    item.latestRender?.status === "COMPLETED" &&
    Boolean(item.latestRender.video_cdn_url)
  ) {
    return { label: "Video Hazır", tone: "gold" };
  }
  if (
    item.latestRender?.status === "FAILED" ||
    item.pipeline_status === "FAILED"
  ) {
    return { label: "Xəta", tone: "rose" };
  }
  return { label: "Videosuz", tone: "neutral" };
}

export interface ListingsServerNicheCounts {
  all: number;
  luxury: number;
  affordable: number;
  general: number;
  tiktok: number;
}

interface ListingsClientProps {
  initialListings: ListingWithLatestRender[];
  pagination?: PaginatedResult<ListingWithLatestRender>;
  initialFilters?: ListingsFilterState;
  memberRole?: AgencyRole;
  serverTabCounts?: ListingsServerTabCounts;
  serverNicheCounts?: ListingsServerNicheCounts;
  channelProfiles?: Partial<Record<ChannelNiche, SocialChannelProfile>>;
}

export function escapePostgrestSearch(input: string): string {
  return input
    .trim()
    .replace(/[(),*"]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function getWhatsAppUrl(
  phoneRaw: string | null | undefined,
  binaId: string | number | null | undefined
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
    binaId
      ? `Salam, bina.az-dakı #${binaId} nömrəli elanınızla bağlı narahat edirəm.`
      : "Salam, eksklüziv əmlak elanınızla bağlı əlaqə saxlayıram."
  );
  return `https://wa.me/${normalized}?text=${text}`;
}

export function resolveListingNiche(item: ListingWithLatestRender): {
  niche: ChannelNiche;
  handle: string;
} {
  const resolved = resolveCanonicalListingNiche(item);
  return {
    niche: resolved.niche,
    handle: item.publication?.target_account_handle || resolved.handle,
  };
}

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function ListingsClient({
  initialListings,
  pagination,
  initialFilters,
  memberRole = "BROKER",
  serverTabCounts,
  serverNicheCounts,
  channelProfiles,
}: ListingsClientProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [listings, setListings] =
    useState<ListingWithLatestRender[]>(initialListings);

  useEffect(() => {
    setListings(initialListings);
  }, [initialListings]);

  const [activeTab, setActiveTab] = useState<
    "ALL" | "NO_VIDEO" | "DRAFTS" | "PUBLISHED"
  >(
    (initialFilters?.tab as "ALL" | "NO_VIDEO" | "DRAFTS" | "PUBLISHED") ||
      "ALL"
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState(initialFilters?.search ?? "");
  const [editorialFilter, setEditorialFilter] = useState<
    EditorialStatus | "ALL"
  >((initialFilters?.editorial as EditorialStatus | "ALL") || "ALL");
  const [availabilityFilter, setAvailabilityFilter] = useState<
    SourceAvailability | "ALL"
  >((initialFilters?.availability as SourceAvailability | "ALL") || "ALL");
  const [archetypeFilter, setArchetypeFilter] = useState<Archetype | "ALL">(
    (initialFilters?.archetype as Archetype | "ALL") || "ALL"
  );
  const [kupcaFilter, setKupcaFilter] = useState<"ALL" | "YES" | "NO">(
    (initialFilters?.kupca as "ALL" | "YES" | "NO") || "ALL"
  );
  const [duplicateFilter, setDuplicateFilter] = useState<
    "ALL" | "PENDING_REVIEW" | "CONFIRMED_DUPLICATE" | "CLEAN"
  >(
    (initialFilters?.duplicate as
      | "ALL"
      | "PENDING_REVIEW"
      | "CONFIRMED_DUPLICATE"
      | "CLEAN") || "ALL"
  );
  const [nicheFilter, setNicheFilter] = useState<ChannelNiche | "ALL">(
    (initialFilters?.niche as ChannelNiche | "ALL") || "ALL"
  );
  const [sortMode, setSortMode] = useState<SortMode>(
    (initialFilters?.sort as SortMode) || "DEFAULT"
  );

  // Publish modal state
  const [selectedListingForPublish, setSelectedListingForPublish] =
    useState<ListingWithLatestRender | null>(null);
  const [publishUrl, setPublishUrl] = useState("");
  const [publishChannel, setPublishChannel] =
    useState<PublicationChannel>("INSTAGRAM_REELS");
  const [publishNotes, setPublishNotes] = useState("");
  const [submittingPublish, setSubmittingPublish] = useState(false);

  // OFF_MARKET Manual Listing Modal State
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualPriceAzn, setManualPriceAzn] = useState("");
  const [manualAreaM2, setManualAreaM2] = useState("");
  const [manualRooms, setManualRooms] = useState("");
  const [manualDistrict, setManualDistrict] = useState("");
  const [manualAddress, setManualAddress] = useState("");
  const [manualFloor, setManualFloor] = useState("");
  const [manualFloors, setManualFloors] = useState("");
  const [manualHasKupca, setManualHasKupca] = useState(false);
  const [manualOwnerName, setManualOwnerName] = useState("");
  const [manualOwnerPhone, setManualOwnerPhone] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualFiles, setManualFiles] = useState<File[]>([]);

  const [feedback, setFeedback] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  // Modal state for pre-flight verification
  const [selectedListingForPreflight, setSelectedListingForPreflight] =
    useState<ListingWithLatestRender | null>(null);

  const isServerPaginated = Boolean(pagination);
  const currentPage = pagination?.page ?? 1;
  const pageSize = pagination?.pageSize ?? 24;
  const totalCount = pagination?.totalCount ?? listings.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasNextPage = pagination?.hasNextPage ?? false;

  function navigateWithParams(
    updates: Record<string, string | null>,
    resetPage: boolean
  ) {
    const next = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : ""
    );
    for (const [key, val] of Object.entries(updates)) {
      if (!val || val === "ALL" || val === "DEFAULT") {
        next.delete(key);
      } else {
        next.set(key, val);
      }
    }
    if (resetPage) {
      next.set("page", "1");
    }
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function handlePageChange(nextPage: number) {
    const clamped = Math.max(1, Math.min(totalPages, nextPage));
    navigateWithParams({ page: String(clamped) }, false);
  }

  const counts = useMemo(() => {
    if (serverTabCounts) {
      return {
        all: serverTabCounts.all,
        noVideo:
          serverTabCounts.noVideo ??
          Math.max(
            0,
            serverTabCounts.all -
              serverTabCounts.drafts -
              serverTabCounts.published
          ),
        drafts: serverTabCounts.drafts,
        published: serverTabCounts.published,
      };
    }
    let noVideo = 0;
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
      } else {
        noVideo++;
      }
    }
    return {
      all: isServerPaginated ? totalCount : listings.length,
      noVideo,
      drafts,
      published,
    };
  }, [listings, isServerPaginated, totalCount, serverTabCounts]);

  const nicheCounts = useMemo(() => {
    if (serverNicheCounts) {
      return serverNicheCounts;
    }
    let luxury = 0;
    let affordable = 0;
    let general = 0;
    let tiktok = 0;

    for (const item of listings) {
      const { niche } = resolveListingNiche(item);
      if (niche === "LUXURY") luxury++;
      else if (niche === "AFFORDABLE") affordable++;
      else if (niche === "TIKTOK") tiktok++;
      else general++;
    }

    return {
      all: isServerPaginated ? totalCount : listings.length,
      luxury,
      affordable,
      general,
      tiktok,
    };
  }, [listings, isServerPaginated, totalCount, serverNicheCounts]);

  const filtered = useMemo(() => {
    if (isServerPaginated) {
      return sortListings(listings, sortMode);
    }

    const q = query.trim().toLowerCase();
    const matched = listings.filter((item) => {
      if (activeTab === "NO_VIDEO") {
        const isPublished = item.publication?.status === "PUBLISHED";
        const isDraft =
          item.latestRender?.status === "COMPLETED" &&
          (!item.publication ||
            item.publication.status === "DRAFT_READY" ||
            item.publication.status === "READY_TO_PUBLISH");
        if (isPublished || isDraft) return false;
      } else if (activeTab === "DRAFTS") {
        const isDraft =
          item.latestRender?.status === "COMPLETED" &&
          (!item.publication ||
            item.publication.status === "DRAFT_READY" ||
            item.publication.status === "READY_TO_PUBLISH");
        if (!isDraft) return false;
      } else if (activeTab === "PUBLISHED") {
        if (item.publication?.status !== "PUBLISHED") return false;
      }

      if (nicheFilter !== "ALL") {
        const { niche } = resolveListingNiche(item);
        if (niche !== nicheFilter) return false;
      }

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
    isServerPaginated,
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
    setActiveTab("ALL");
    if (isServerPaginated) {
      router.push(`${pathname}?page=1`);
    }
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

    let channel: PublicationChannel = publishChannel;
    if (cleanUrl.includes("tiktok.com")) {
      channel = "TIKTOK";
    } else if (cleanUrl.includes("instagram.com")) {
      channel = "INSTAGRAM_REELS";
    }

    const nicheInfo = resolveListingNiche(selectedListingForPublish);
    const nowIso = new Date().toISOString();

    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc(
        "confirm_publication_atomic",
        {
          p_listing_id: selectedListingForPublish.id,
          p_channel: channel,
          p_post_url: cleanUrl,
          p_render_version_id: selectedListingForPublish.latestRender?.id || null,
          p_published_at: nowIso,
          p_notes: publishNotes.trim() || null,
          p_target_account_handle: nicheInfo.handle,
          p_channel_niche: nicheInfo.niche,
        }
      );

      if (rpcErr) throw rpcErr;
      if (
        rpcData &&
        typeof rpcData === "object" &&
        "ok" in rpcData &&
        (rpcData as { ok?: boolean }).ok === false
      ) {
        throw new Error(
          (rpcData as { error?: string }).error || "Yayımlama təsdiqlənmədi."
        );
      }

      const returnedPub =
        rpcData && typeof rpcData === "object" && "publication" in rpcData
          ? ((rpcData as { publication?: Publication }).publication ?? null)
          : null;

      setListings((prev) =>
        prev.map((item) => {
          if (item.id === selectedListingForPublish.id) {
            return {
              ...item,
              editorial_status: "PUBLISHED",
              publication:
                returnedPub ??
                ({
                  ...(item.publication || ({} as Publication)),
                  id: item.publication?.id || `pub-${item.id}`,
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
                  next_poll_at: null,
                  created_at: item.publication?.created_at || nowIso,
                } as Publication),
            };
          }
          return item;
        })
      );

      const label = selectedListingForPublish.bina_id
        ? `#${selectedListingForPublish.bina_id}`
        : "OFF-MARKET";
      setFeedback({
        type: "ok",
        text: `🚀 Elan ${label} atomik RPC ilə yayımlandı və telemetriya monitorinqi aktivləşdirildi!`,
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

  function handleManualFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    setManualFiles(picked);
  }

  async function handleCreateManualListing(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setManualSubmitting(true);
    setFeedback(null);

    try {
      if (manualFiles.length > 0) {
        if (manualFiles.length < 4 || manualFiles.length > 10) {
          throw new Error(
            "Foto yüklədikdə minimum 4, maksimum 10 şəkil seçilməlidir."
          );
        }
        for (const f of manualFiles) {
          if (!ALLOWED_IMAGE_TYPES.has(f.type)) {
            throw new Error(
              `İcazə verilməyən fayl növü: ${f.name} (yalnız JPEG/PNG/WebP)`
            );
          }
          if (f.size > MAX_UPLOAD_BYTES) {
            throw new Error(`${f.name} faylı 10 MB limitini aşır.`);
          }
        }
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers.Authorization = `Bearer ${session.access_token}`;
        }
      } catch {
        // cookie fallback
      }

      const postRes = await fetch("/api/listings/manual", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: manualTitle.trim(),
          price_azn: Number(manualPriceAzn),
          area_m2: Number(manualAreaM2),
          rooms: Number(manualRooms),
          district: manualDistrict.trim(),
          address: manualAddress.trim(),
          floor: manualFloor ? Number(manualFloor) : undefined,
          floors: manualFloors ? Number(manualFloors) : undefined,
          has_bill_of_sale: manualHasKupca,
          owner_name: manualOwnerName.trim() || undefined,
          owner_phone: manualOwnerPhone.trim() || undefined,
          description: manualDescription.trim() || undefined,
          photo_files:
            manualFiles.length > 0
              ? manualFiles.map((f) => ({
                  name: f.name,
                  contentType: f.type,
                  sizeBytes: f.size,
                }))
              : undefined,
        }),
      });

      const postData = await postRes.json().catch(() => ({}));
      if (!postRes.ok || postData?.ok === false) {
        throw new Error(
          postData?.error || `Elan yaradılmadı (HTTP ${postRes.status})`
        );
      }

      const listingId = String(postData.listing_id);
      const uploadUrls = Array.isArray(postData.upload_urls)
        ? (postData.upload_urls as Array<{
            object_key: string;
            put_url: string;
            public_path: string;
            content_type?: string;
          }>)
        : [];

      if (uploadUrls.length > 0 && manualFiles.length === uploadUrls.length) {
        const uploadedPaths: string[] = [];
        for (let i = 0; i < uploadUrls.length; i += 1) {
          const slot = uploadUrls[i];
          const file = manualFiles[i];
          const putRes = await fetch(slot.put_url, {
            method: "PUT",
            headers: {
              "Content-Type": slot.content_type || file.type,
            },
            body: file,
          });
          if (!putRes.ok) {
            throw new Error(
              `Foto yükləmə xətası (${file.name}, HTTP ${putRes.status})`
            );
          }
          uploadedPaths.push(slot.public_path);
        }

        const patchRes = await fetch("/api/listings/manual", {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            listing_id: listingId,
            photo_urls: uploadedPaths,
          }),
        });
        const patchData = await patchRes.json().catch(() => ({}));
        if (!patchRes.ok || patchData?.ok === false) {
          throw new Error(
            patchData?.error ||
              `Foto təsdiq xətası (HTTP ${patchRes.status})`
          );
        }
      }

      setManualModalOpen(false);
      setManualTitle("");
      setManualPriceAzn("");
      setManualAreaM2("");
      setManualRooms("");
      setManualDistrict("");
      setManualAddress("");
      setManualFloor("");
      setManualFloors("");
      setManualHasKupca(false);
      setManualOwnerName("");
      setManualOwnerPhone("");
      setManualDescription("");
      setManualFiles([]);

      setFeedback({
        type: "ok",
        text: "Eksklüziv (OFF-MARKET) elan uğurla yaradıldı!",
      });
      router.push(`/listings/${listingId}`);
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Eksklüziv elan xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setManualSubmitting(false);
    }
  }

  const activeFilterCount = [
    editorialFilter,
    availabilityFilter,
    archetypeFilter,
    kupcaFilter,
    duplicateFilter,
    nicheFilter,
  ].filter((v) => v !== "ALL").length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-400">
            Vahid Postgres Reyestri
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Elanlar Reyestri
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-slate-400">
            Göstərilir:{" "}
            <span className="font-semibold text-slate-100">
              {filtered.length}
            </span>{" "}
            / {totalCount} elan
          </p>
          {memberRole !== "SMM" && (
            <button
              type="button"
              onClick={() => setManualModalOpen(true)}
              className="exec-btn-primary text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>+ Eksklüziv Elan Əlavə Et</span>
            </button>
          )}
        </div>
      </div>

      {/* Segmented Top Tabs */}
      <div className="flex flex-wrap items-center gap-2 p-1.5 rounded-2xl border border-slate-800/80 bg-obsidian-900/80 backdrop-blur-md">
        <button
          type="button"
          onClick={() => {
            setActiveTab("ALL");
            setNicheFilter("ALL");
            if (isServerPaginated) navigateWithParams({ tab: null, niche: "ALL" }, true);
          }}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
            activeTab === "ALL"
              ? "bg-gold-500/20 text-gold-300 border border-gold-500/40 shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <Building2 className="h-3.5 w-3.5" />
          <span>Hamısı</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] text-slate-400">
            {counts.all}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab("NO_VIDEO");
            setNicheFilter("ALL");
            if (isServerPaginated)
              navigateWithParams({ tab: "NO_VIDEO", niche: "ALL" }, true);
          }}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
            activeTab === "NO_VIDEO"
              ? "bg-slate-500/20 text-slate-200 border border-slate-500/40 shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <Film className="h-3.5 w-3.5" />
          <span>Videosuz</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-slate-300">
            {counts.noVideo}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab("DRAFTS");
            setNicheFilter("ALL");
            if (isServerPaginated) navigateWithParams({ tab: "DRAFTS", niche: "ALL" }, true);
          }}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
            activeTab === "DRAFTS"
              ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <Film className="h-3.5 w-3.5" />
          <span>Hazır</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-amber-300">
            {counts.drafts}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab("PUBLISHED");
            setNicheFilter("ALL");
            if (isServerPaginated)
              navigateWithParams({ tab: "PUBLISHED", niche: "ALL" }, true);
          }}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
            activeTab === "PUBLISHED"
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm"
              : "text-slate-400 hover:text-slate-200 hover:bg-obsidian-850 border border-transparent"
          }`}
        >
          <Send className="h-3.5 w-3.5" />
          <span>Paylaşıldı</span>
          <span className="rounded-md bg-obsidian-950/80 px-1.5 py-0.5 text-[10px] font-mono text-emerald-300">
            {counts.published}
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (isServerPaginated) {
              navigateWithParams({ search: query.trim() || null }, true);
            }
          }}
          className="flex flex-col gap-2.5 sm:flex-row sm:items-center"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Axtar: bina_id, ünvan, rayon, başlıq..."
              className="exec-input pl-10"
            />
          </div>

          {isServerPaginated && (
            <button type="submit" className="exec-btn-secondary text-xs py-2">
              Axtar
            </button>
          )}

          <div className="flex items-center gap-2 shrink-0">
            <ArrowUpDown className="h-4 w-4 text-gold-400 shrink-0" />
            <select
              aria-label="Sıralama rejimi"
              value={sortMode}
              onChange={(e) => {
                const nextSort = e.target.value as SortMode;
                setSortMode(nextSort);
                if (isServerPaginated) {
                  navigateWithParams({ sort: nextSort }, true);
                }
              }}
              className="exec-select text-xs min-w-[210px]"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setFiltersOpen((prev) => !prev)}
              aria-expanded={filtersOpen}
              className={`exec-btn-secondary text-xs py-2 shrink-0 ${
                activeFilterCount > 0
                  ? "border-gold-500/50 text-gold-300"
                  : ""
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>Ətraflı filtrlər</span>
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-gold-500/20 border border-gold-500/40 px-1.5 py-0.5 text-[10px] font-bold text-gold-300">
                  {activeFilterCount}
                </span>
              )}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${
                  filtersOpen ? "rotate-180" : ""
                }`}
              />
            </button>
          </div>
        </form>

        {filtersOpen && (
          <div className="space-y-3 pt-3 border-t border-slate-800/80">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
              <select
                aria-label="Niş / Kanal"
                value={nicheFilter}
                onChange={(e) => {
                  const val = e.target.value as ChannelNiche | "ALL";
                  setNicheFilter(val);
                  if (isServerPaginated) {
                    navigateWithParams(
                      { niche: val === "ALL" ? null : val },
                      true
                    );
                  }
                }}
                className="exec-select text-xs"
              >
                <option value="ALL">Bütün nişlər ({nicheCounts.all})</option>
                <option value="LUXURY">
                  {channelProfiles?.LUXURY?.handle?.trim() ||
                    "@bakuestate.premium"}{" "}
                  ({nicheCounts.luxury})
                </option>
                <option value="AFFORDABLE">
                  {channelProfiles?.AFFORDABLE?.handle?.trim() ||
                    "@baku.serfeli.evler"}{" "}
                  ({nicheCounts.affordable})
                </option>
                <option value="GENERAL">
                  {channelProfiles?.GENERAL?.handle?.trim() ||
                    "@bakuestate.official"}{" "}
                  ({nicheCounts.general})
                </option>
                <option value="TIKTOK">
                  {channelProfiles?.TIKTOK?.handle?.trim() || "@baku_emlak_ai"}{" "}
                  ({nicheCounts.tiktok})
                </option>
              </select>

              <select
                aria-label="Redaksiya statusu"
                value={editorialFilter}
                onChange={(e) => {
                  const val = e.target.value as EditorialStatus | "ALL";
                  setEditorialFilter(val);
                  if (isServerPaginated) {
                    navigateWithParams({ editorial: val }, true);
                  }
                }}
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
                onChange={(e) => {
                  const val = e.target.value as SourceAvailability | "ALL";
                  setAvailabilityFilter(val);
                  if (isServerPaginated) {
                    navigateWithParams({ availability: val }, true);
                  }
                }}
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
                onChange={(e) => {
                  const val = e.target.value as Archetype | "ALL";
                  setArchetypeFilter(val);
                  if (isServerPaginated) {
                    navigateWithParams({ archetype: val }, true);
                  }
                }}
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
                onChange={(e) => {
                  const val = e.target.value as "ALL" | "YES" | "NO";
                  setKupcaFilter(val);
                  if (isServerPaginated) {
                    navigateWithParams({ kupca: val }, true);
                  }
                }}
                className="exec-select text-xs"
              >
                <option value="ALL">Kupça: Hamısı</option>
                <option value="YES">Kupçalı</option>
                <option value="NO">Kupçasız</option>
              </select>

              <select
                aria-label="Təkrar filtri"
                value={duplicateFilter}
                onChange={(e) => {
                  const val = e.target.value as
                    | "ALL"
                    | "PENDING_REVIEW"
                    | "CONFIRMED_DUPLICATE"
                    | "CLEAN";
                  setDuplicateFilter(val);
                  if (isServerPaginated) {
                    navigateWithParams({ duplicate: val }, true);
                  }
                }}
                className="exec-select text-xs"
              >
                <option value="ALL">Təkrar: Hamısı</option>
                <option value="PENDING_REVIEW">Şübhəli Təkrar</option>
                <option value="CONFIRMED_DUPLICATE">Təsdiqlənmiş Təkrar</option>
                <option value="CLEAN">Yalnız Təkrarsız</option>
              </select>
            </div>

            {activeFilterCount > 0 && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={resetFilters}
                  className="exec-btn-secondary text-xs py-1.5 px-3"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Filtrləri sıfırla</span>
                </button>
              </div>
            )}
          </div>
        )}
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
            const detailSlug = item.bina_id || item.id;
            const displayTag = item.bina_id ? `#${item.bina_id}` : "OFF-MARKET";
            const thumb = Array.isArray(item.photo_urls)
              ? item.photo_urls[0]
              : undefined;
            const unifiedStatus = getUnifiedListingStatus(item);
            const render = item.latestRender;
            const pub = item.publication;
            const isDraftReady =
              render?.status === "COMPLETED" &&
              (!pub ||
                pub.status === "DRAFT_READY" ||
                pub.status === "READY_TO_PUBLISH");
            const isLive = pub?.status === "PUBLISHED";
            const ownerPhone =
              memberRole !== "SMM"
                ? item.owner_phone_raw || item.owner_phone_normalized
                : null;
            const waUrl = getWhatsAppUrl(ownerPhone, item.bina_id);
            const nicheInfo = resolveListingNiche(item);

            return (
              <div
                key={item.id}
                className="exec-card group overflow-hidden flex flex-col transition hover:border-gold-500/45"
              >
                <Link
                  href={`/listings/${detailSlug}`}
                  className="block relative h-44 w-full bg-obsidian-950 overflow-hidden"
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={item.title || `Elan ${displayTag}`}
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-slate-600">
                      <Building2 className="h-10 w-10" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-obsidian-950 via-obsidian-950/20 to-transparent" />

                  <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none z-10">
                    <div className="flex items-center gap-1.5 min-w-0 pointer-events-auto">
                      <span className="rounded-lg bg-obsidian-950/85 px-2 py-0.5 font-mono text-xs font-semibold text-gold-300 border border-gold-500/30">
                        {displayTag}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold backdrop-blur-md truncate ${
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
                    </div>

                    <div className="shrink-0 pointer-events-auto">
                      <StatusBadge
                        label={unifiedStatus.label}
                        tone={unifiedStatus.tone}
                        className="backdrop-blur-md"
                      />
                    </div>
                  </div>

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

                <div className="flex flex-1 flex-col justify-between p-4 space-y-3">
                  <Link
                    href={`/listings/${detailSlug}`}
                    className="space-y-1.5 block"
                  >
                    <h3 className="text-sm font-semibold text-slate-100 line-clamp-2 group-hover:text-gold-300 transition">
                      {item.title || item.address || `Elan ${displayTag}`}
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

                    {isDraftReady && (
                      <div className="space-y-2 mt-2">
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

                    {isLive && pub && (
                      <div className="mt-2 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-950/40 px-3 py-2 text-xs">
                        <span className="inline-flex items-center gap-1.5 text-emerald-300 font-medium">
                          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                          <span>
                            {formatCompactNumber(pub.views_count)} baxış
                          </span>
                          <span className="text-slate-500">•</span>
                          <span>
                            {formatCompactNumber(pub.likes_count)} like
                          </span>
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
                      {ownerPhone &&
                        (waUrl ? (
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
                        ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Server-Side Pagination Controls */}
      {isServerPaginated && (
        <div className="exec-card flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
          <span className="text-slate-400">
            <strong className="text-slate-100">
              {`Səhifə ${currentPage} / ${totalPages}`}
            </strong>{" "}
            • Cəmi {`${totalCount} elan`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => handlePageChange(currentPage - 1)}
              className="exec-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Əvvəlki</span>
            </button>
            <button
              type="button"
              disabled={!hasNextPage && currentPage >= totalPages}
              onClick={() => handlePageChange(currentPage + 1)}
              className="exec-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
            >
              <span>Növbəti</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* OFF_MARKET Manual Listing Modal */}
      {manualModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-obsidian-950/80 p-4 backdrop-blur-md">
          <div className="exec-card w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-start justify-between border-b border-slate-800/80 pb-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-gold-400">
                  Manual Portfel Girişi
                </p>
                <h3 className="mt-1 text-lg font-bold text-slate-100">
                  Yeni Eksklüziv (OFF-MARKET) Elan
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setManualModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-obsidian-850 hover:text-slate-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateManualListing} className="space-y-3.5">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-300">
                  Elan Başlığı *
                </label>
                <input
                  type="text"
                  required
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  placeholder="Ağ Şəhər, 3 otaqlı təmirli mənzil"
                  className="exec-input text-xs"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Qiymət (AZN) *
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={manualPriceAzn}
                    onChange={(e) => setManualPriceAzn(e.target.value)}
                    placeholder="285000"
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Sahə (m²) *
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={manualAreaM2}
                    onChange={(e) => setManualAreaM2(e.target.value)}
                    placeholder="115"
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Otaq Sayı *
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    value={manualRooms}
                    onChange={(e) => setManualRooms(e.target.value)}
                    placeholder="3"
                    className="exec-input text-xs"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Rayon *
                  </label>
                  <input
                    type="text"
                    required
                    value={manualDistrict}
                    onChange={(e) => setManualDistrict(e.target.value)}
                    placeholder="Nəsimi / Xətai / Səbail"
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Ünvan *
                  </label>
                  <input
                    type="text"
                    required
                    value={manualAddress}
                    onChange={(e) => setManualAddress(e.target.value)}
                    placeholder="Mərkəzi Bulvar küç."
                    className="exec-input text-xs"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Mərtəbə
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={manualFloor}
                    onChange={(e) => setManualFloor(e.target.value)}
                    placeholder="6"
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Mərtəbə Sayı
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={manualFloors}
                    onChange={(e) => setManualFloors(e.target.value)}
                    placeholder="16"
                    className="exec-input text-xs"
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={manualHasKupca}
                      onChange={(e) => setManualHasKupca(e.target.checked)}
                      className="accent-gold-400"
                    />
                    <span>Kupçalıdır (Çıxarış var)</span>
                  </label>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Mülkiyyətçi Adı
                  </label>
                  <input
                    type="text"
                    value={manualOwnerName}
                    onChange={(e) => setManualOwnerName(e.target.value)}
                    placeholder="Rəşad m."
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Mülkiyyətçi Telefonu
                  </label>
                  <input
                    type="text"
                    value={manualOwnerPhone}
                    onChange={(e) => setManualOwnerPhone(e.target.value)}
                    placeholder="+994501234567"
                    className="exec-input text-xs font-mono"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-300">
                  Fotolar (4–10 ədəd, JPEG/PNG/WebP, maks 10 MB)
                </label>
                <label className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700 bg-obsidian-950/60 px-4 py-3 text-xs text-slate-300 cursor-pointer hover:border-gold-500/50">
                  <Upload className="h-4 w-4 text-gold-400" />
                  <span>
                    {manualFiles.length > 0
                      ? `${manualFiles.length} foto seçilib`
                      : "Fotoları seçin (Cloudflare R2-yə birbaşa yüklənəcək)"}
                  </span>
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleManualFileChange}
                    className="hidden"
                  />
                </label>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-300">
                  Ətraflı Təsvir
                </label>
                <textarea
                  rows={2}
                  value={manualDescription}
                  onChange={(e) => setManualDescription(e.target.value)}
                  placeholder="Təmir səviyyəsi, mənzərə, açar mövcudluğu..."
                  className="exec-input text-xs"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800/80">
                <button
                  type="button"
                  disabled={manualSubmitting}
                  onClick={() => setManualModalOpen(false)}
                  className="exec-btn-secondary text-xs"
                >
                  Ləğv et
                </button>
                <button
                  type="submit"
                  disabled={manualSubmitting}
                  className="exec-btn-primary text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>
                    {manualSubmitting ? "Yaradılır..." : "Eksklüziv Elanı Yarat"}
                  </span>
                </button>
              </div>
            </form>
          </div>
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
                  🚀 Elan{" "}
                  {selectedListingForPublish.bina_id
                    ? `#${selectedListingForPublish.bina_id}`
                    : "OFF-MARKET"}{" "}
                  Paylaşıldı
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
                  Link daxil edildikdə atomik RPC ilə paylaşım qeydə alınacaq.
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
