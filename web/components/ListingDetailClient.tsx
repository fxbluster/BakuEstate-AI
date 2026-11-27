"use client";

import { useState } from "react";
import Link from "next/link";
import { resolveClientVideoSrc } from "@/lib/r2-media-client";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileCheck2,
  Film,
  History,
  Image as ImageIcon,
  MessageCircle,
  Phone,
  Plus,
  RefreshCw,
  Save,
  Share2,
  Sliders,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  ARCHETYPE_LABELS,
  type BadgeTone,
  buildWhatsAppUrl,
  EVENT_ACTOR_LABELS,
  EVENT_TYPE_META,
  formatAzn,
  formatBakuDateTime,
  formatListingEventSummary,
  formatPrice,
  formatVoiceEngineLabel,
  formatVoiceLabel,
  getUnifiedListingStatus,
  OWNER_OUTREACH_META,
  PUBLICATION_CHANNEL_LABELS,
  RENDER_STATUS_META,
  RENDER_TRIGGER_LABELS,
} from "@/lib/format";
import type {
  AgencyRole,
  ChannelNiche,
  CommissionType,
  HookType,
  Listing,
  ListingEvent,
  OwnerOutreachStatus,
  Publication,
  PublicationChannel,
  RenderVersion,
} from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

interface ListingDetailClientProps {
  initialListing: Listing;
  initialEvents: ListingEvent[];
  initialRenders: RenderVersion[];
  initialPublications: Publication[];
  memberRole?: AgencyRole;
  agencyId?: string | null;
}

const SCRIPT_ANGLES = [
  { value: "default", label: "Standart (Balanslı)" },
  { value: "investment", label: "İnvestisiya / Gəlir Bucağı" },
  { value: "family", label: "Ailəvi & Rahatlıq" },
  { value: "price_drop", label: "Təcili Endirim / Fürsət" },
  { value: "luxury", label: "Lüks & Eksklüziv" },
];

const VOICE_OPTIONS = [
  {
    engine: "elevenlabs_v4",
    voiceId: "arif",
    preset: "Arif",
    label: "ElevenLabs v4 — Arif (Kişi, Premium)",
  },
  {
    engine: "elevenlabs_v4",
    voiceId: "leyla",
    preset: "Leyla",
    label: "ElevenLabs v4 — Leyla (Qadın, Səmimi)",
  },
  {
    engine: "elevenlabs_v4",
    voiceId: "kamran",
    preset: "Kamran",
    label: "ElevenLabs v4 — Kamran (Dinamik)",
  },
  {
    engine: "openai",
    voiceId: "nova",
    preset: "Nova",
    label: "OpenAI TTS — Nova (Ehtiyat)",
  },
  {
    engine: "openai",
    voiceId: "onyx",
    preset: "Onyx",
    label: "OpenAI TTS — Onyx (Ehtiyat)",
  },
];

const TARGET_ACCOUNTS: Array<{
  handle: string;
  niche: ChannelNiche;
  label: string;
}> = [
  {
    handle: "@bakuestate.official",
    niche: "GENERAL",
    label: "🏢 @bakuestate.official (Ümumi)",
  },
  {
    handle: "@bakuestate.premium",
    niche: "LUXURY",
    label: "💎 @bakuestate.premium (Lüks)",
  },
  {
    handle: "@baku.serfeli.evler",
    niche: "AFFORDABLE",
    label: "🏠 @baku.serfeli.evler (Sərfəli)",
  },
  {
    handle: "@baku_emlak_ai",
    niche: "TIKTOK",
    label: "🔥 @baku_emlak_ai (TikTok / Viral)",
  },
];

const MIN_STUDIO_PHOTOS = 4;
const MAX_STUDIO_PHOTOS = 10;
const MAX_SCRIPT_CHARS = 1000;

function toLocalDateTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const bakuMs = d.getTime() + 4 * 60 * 60 * 1000;
  return new Date(bakuMs).toISOString().slice(0, 16);
}

function bakuLocalInputToIso(localValue: string): string | null {
  if (!localValue) return null;
  const parsed = new Date(`${localValue}:00+04:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

async function getBearerHeaders(): Promise<Record<string, string>> {
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
    // Cookie fallback
  }
  return headers;
}

function inferNicheFromListing(listing: Listing): {
  niche: ChannelNiche;
  handle: string;
} {
  const canonical = (listing as Listing & { canonical_niche?: ChannelNiche })
    .canonical_niche;
  if (canonical === "LUXURY")
    return { niche: "LUXURY", handle: "@bakuestate.premium" };
  if (canonical === "AFFORDABLE")
    return { niche: "AFFORDABLE", handle: "@baku.serfeli.evler" };
  if (canonical === "TIKTOK")
    return { niche: "TIKTOK", handle: "@baku_emlak_ai" };
  if (canonical === "GENERAL")
    return { niche: "GENERAL", handle: "@bakuestate.official" };

  const price = listing.price_azn_normalized || 0;
  if (price >= 250000)
    return { niche: "LUXURY", handle: "@bakuestate.premium" };
  if (price > 0 && price <= 120000)
    return { niche: "AFFORDABLE", handle: "@baku.serfeli.evler" };
  return { niche: "GENERAL", handle: "@bakuestate.official" };
}

export function ListingDetailClient({
  initialListing,
  initialEvents,
  initialRenders,
  initialPublications,
  memberRole = "BROKER",
  agencyId = null,
}: ListingDetailClientProps) {
  const [listing, setListing] = useState<Listing>(initialListing);
  const [events, setEvents] = useState<ListingEvent[]>(initialEvents);
  const [renders] = useState<RenderVersion[]>(initialRenders);
  const [publications, setPublications] =
    useState<Publication[]>(initialPublications);

  const photos = Array.isArray(listing.photo_urls) ? listing.photo_urls : [];
  const defaultNiche = inferNicheFromListing(initialListing);

  const sortedRenders = [...renders].sort(
    (a, b) => b.version_num - a.version_num
  );
  const primaryRender =
    sortedRenders.find(
      (r) =>
        r.status === "COMPLETED" &&
        r.video_cdn_url &&
        !r.storage_pruned_at
    ) ??
    sortedRenders.find((r) => r.status === "COMPLETED") ??
    sortedRenders.find(
      (r) => r.status === "RUNNING" || r.status === "QUEUED"
    ) ??
    sortedRenders[0] ??
    null;
  const olderRenders = sortedRenders.filter(
    (r) => r.id !== primaryRender?.id
  );
  const playableDefault = primaryRender;
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(
    playableDefault?.id ?? null
  );
  const [showOlderVersions, setShowOlderVersions] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  // Pre-Render Studio State
  const [selectedPhotos, setSelectedPhotos] = useState<string[]>(() =>
    photos.slice(0, Math.min(photos.length, MAX_STUDIO_PHOTOS))
  );
  const [customScriptText, setCustomScriptText] = useState<string>("");
  const [studioHookType, setStudioHookType] =
    useState<HookType>("PRICE_FIRST");
  const [studioTargetAccount, setStudioTargetAccount] = useState<string>(
    defaultNiche.handle
  );
  const [studioVoiceIdx, setStudioVoiceIdx] = useState<number>(0);
  const [generatingScript, setGeneratingScript] = useState(false);

  // Script/Voice Rerender Modal
  const [rerenderModalOpen, setRerenderModalOpen] = useState(false);
  const [scriptAngle, setScriptAngle] = useState("investment");
  const [voiceChoiceIdx, setVoiceChoiceIdx] = useState(0);

  // Owner Outreach Form State
  const [ownerStatus, setOwnerStatus] = useState<OwnerOutreachStatus>(
    listing.owner_outreach_status
  );
  const [commissionType, setCommissionType] = useState<CommissionType>(
    listing.commission_type ?? "PERCENT"
  );
  const [commissionValue, setCommissionValue] = useState<string>(
    listing.commission_value !== null ? String(listing.commission_value) : ""
  );
  const [ownerMinPrice, setOwnerMinPrice] = useState<string>(
    listing.owner_min_price_azn !== null
      ? String(listing.owner_min_price_azn)
      : ""
  );
  const [ownerNextCheckin, setOwnerNextCheckin] = useState<string>(
    toLocalDateTimeInput(listing.owner_next_checkin_at)
  );
  const [ownerNotes, setOwnerNotes] = useState<string>(
    listing.owner_notes ?? ""
  );

  // Publication Logger State
  const [pubChannel, setPubChannel] =
    useState<PublicationChannel>("INSTAGRAM_REELS");
  const [pubUrl, setPubUrl] = useState("");
  const [pubRenderId, setPubRenderId] = useState<string>(
    playableDefault?.id ?? ""
  );
  const [pubPublishedAt, setPubPublishedAt] = useState<string>(
    toLocalDateTimeInput(new Date().toISOString())
  );
  const [pubNotes, setPubNotes] = useState("");

  const isOffMarket =
    !listing.bina_id ||
    (listing as Listing & { source_type?: string }).source_type ===
      "OFF_MARKET";
  const displayCode = listing.bina_id ? `#${listing.bina_id}` : "OFF-MARKET";

  const selectedRender =
    sortedRenders.find((r) => r.id === selectedRenderId) ?? primaryRender;

  const waUrl =
    memberRole !== "SMM"
      ? buildWhatsAppUrl(
          listing.owner_phone_normalized || listing.owner_phone_raw,
          listing.bina_id
            ? `Salam! bina.az-dakı #${listing.bina_id} nömrəli elanınız (${listing.location || "Bakı"}, ${formatAzn(listing.price_azn_normalized)}) ilə bağlı əlaqə saxlayıram. Mənzil hələ aktualdırmı?`
            : `Salam! Eksklüziv elanınız (${listing.title || listing.location || "Bakı"}, ${formatAzn(listing.price_azn_normalized)}) ilə bağlı əlaqə saxlayıram.`
        )
      : null;

  const hasEnoughPhotos =
    photos.length >= MIN_STUDIO_PHOTOS &&
    selectedPhotos.length >= MIN_STUDIO_PHOTOS &&
    selectedPhotos.length <= MAX_STUDIO_PHOTOS;
  const scriptTooLong = customScriptText.length > MAX_SCRIPT_CHARS;

  function togglePhotoSelection(url: string) {
    setSelectedPhotos((prev) => {
      if (prev.includes(url)) {
        return prev.filter((u) => u !== url);
      }
      if (prev.length >= MAX_STUDIO_PHOTOS) {
        return prev;
      }
      return [...prev, url];
    });
  }

  function moveSelectedPhoto(index: number, direction: -1 | 1) {
    setSelectedPhotos((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      const temp = copy[index];
      copy[index] = copy[target];
      copy[target] = temp;
      return copy;
    });
  }

  async function handleGenerateRenderScript() {
    setGeneratingScript(true);
    setFeedback(null);

    try {
      const headers = await getBearerHeaders();
      const res = await fetch("/api/ai/copilot", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "generate_render_script",
          listing_id: listing.id,
          hook_type: studioHookType,
          target_account: studioTargetAccount,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok === false) {
        throw new Error(
          payload?.error || `AI ssenari yaradıla bilmədi (HTTP ${res.status})`
        );
      }

      const draft =
        payload?.data?.draft_script ||
        payload?.data?.script ||
        payload?.draft_script ||
        "";

      if (payload?.data?.hook_type) {
        setStudioHookType(payload.data.hook_type as HookType);
      }

      setCustomScriptText(String(draft).slice(0, MAX_SCRIPT_CHARS));
      setFeedback({
        type: "ok",
        text: "AI video ssenari qaralaması yaradıldı. İstəsəniz redaktə edib renderə göndərə bilərsiniz.",
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Ssenari xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setGeneratingScript(false);
    }
  }

  async function enqueueRenderJob(
    options: {
      jobType?: "RENDER_INITIAL" | "RERENDER";
      targetAccount?: string;
      voicePreset?: string;
      selectedPhotoUrls?: string[];
      customScript?: string;
    },
    label: string
  ) {
    setBusyAction(label);
    setFeedback(null);

    try {
      const headers = await getBearerHeaders();
      const res = await fetch("/api/pipeline/queue-render", {
        method: "POST",
        headers,
        body: JSON.stringify({
          listing_id: listing.id,
          bina_id: listing.bina_id || undefined,
          job_type: options.jobType ?? (renders.length > 0 ? "RERENDER" : "RENDER_INITIAL"),
          target_account: options.targetAccount ?? studioTargetAccount,
          voice_preset:
            options.voicePreset ?? VOICE_OPTIONS[studioVoiceIdx]?.preset,
          selected_photo_urls: options.selectedPhotoUrls,
          custom_script_text: options.customScript?.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false || data?.ok === false) {
        throw new Error(
          data?.error || `Render növbə xətası (HTTP ${res.status})`
        );
      }

      setListing((prev) => ({
        ...prev,
        pipeline_status: "QUEUED",
        editorial_status:
          options.jobType === "RERENDER"
            ? "NEEDS_RERENDER"
            : prev.editorial_status,
      }));
      setRerenderModalOpen(false);
      setFeedback({
        type: "ok",
        text: data?.already_queued
          ? "Bu elan artıq bulud render növbəsindədir (dublikat bloklandı)."
          : "Render işi atomik olaraq bulud növbəsinə salındı. Railway worker icra edəcək.",
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Növbə xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleStudioRenderSubmit() {
    if (!hasEnoughPhotos) {
      setFeedback({
        type: "err",
        text: `Render üçün ən azı ${MIN_STUDIO_PHOTOS}, ən çox ${MAX_STUDIO_PHOTOS} foto seçilməlidir.`,
      });
      return;
    }
    if (scriptTooLong) {
      setFeedback({
        type: "err",
        text: `Ssenari maksimum ${MAX_SCRIPT_CHARS} simvol ola bilər.`,
      });
      return;
    }

    await enqueueRenderJob(
      {
        jobType: renders.length > 0 ? "RERENDER" : "RENDER_INITIAL",
        targetAccount: studioTargetAccount,
        voicePreset: VOICE_OPTIONS[studioVoiceIdx]?.preset,
        selectedPhotoUrls: selectedPhotos,
        customScript: customScriptText,
      },
      "studio_render"
    );
  }

  async function handleQuickStatus(mode: "publish" | "sold_archive") {
    setBusyAction(mode);
    setFeedback(null);
    const supabase = createClient();

    try {
      if (mode === "publish") {
        const latestPub = publications[0];
        const { data: rpcData, error: rpcErr } = await supabase.rpc(
          "confirm_publication_atomic",
          {
            p_listing_id: listing.id,
            p_channel: latestPub?.channel ?? pubChannel,
            p_post_url: latestPub?.post_url ?? null,
            p_render_version_id: playableDefault?.id ?? null,
            p_published_at: new Date().toISOString(),
            p_notes: "Sürətli paylaşım statusu",
            p_target_account_handle: studioTargetAccount,
            p_channel_niche: defaultNiche.niche,
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
            (rpcData as { error?: string }).error ||
              "Paylaşım statusu yenilənə bilmədi."
          );
        }

        const pubRow =
          rpcData && typeof rpcData === "object" && "publication" in rpcData
            ? ((rpcData as { publication?: Publication }).publication ?? null)
            : null;

        setListing((prev) => ({ ...prev, editorial_status: "PUBLISHED" }));
        if (pubRow) {
          setPublications((prev) => [
            pubRow,
            ...prev.filter((p) => p.id !== pubRow.id),
          ]);
        }
        setFeedback({
          type: "ok",
          text: "Elan statusu atomik RPC ilə PAYLAŞILDI olaraq yeniləndi.",
        });
      } else {
        const { error: updateErr } = await supabase
          .from("listings")
          .update({
            editorial_status: "ARCHIVED",
            owner_outreach_status: "OWNER_SOLD",
            source_availability: "CONFIRMED_SOLD",
          })
          .eq("id", listing.id);
        if (updateErr) throw updateErr;

        const eventInsert: Record<string, unknown> = {
          listing_id: listing.id,
          event_type: "STATUS_CHANGED",
          old_value_json: {
            editorial_status: listing.editorial_status,
            owner_outreach_status: listing.owner_outreach_status,
            source_availability: listing.source_availability,
          },
          new_value_json: {
            editorial_status: "ARCHIVED",
            owner_outreach_status: "OWNER_SOLD",
            source_availability: "CONFIRMED_SOLD",
          },
          actor: "web_user",
        };
        if (agencyId) eventInsert.agency_id = agencyId;

        const { data: ev, error: evErr } = await supabase
          .from("listing_events")
          .insert(eventInsert)
          .select("*")
          .single();
        if (evErr) throw evErr;

        setListing((prev) => ({
          ...prev,
          editorial_status: "ARCHIVED",
          owner_outreach_status: "OWNER_SOLD",
          source_availability: "CONFIRMED_SOLD",
        }));
        setOwnerStatus("OWNER_SOLD");
        if (ev) setEvents((prev) => [ev as ListingEvent, ...prev]);
        setFeedback({
          type: "ok",
          text: "Elan Satıldı / Arxivləndi kimi işarələndi. Avto-render bloklandı.",
        });
      }
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Status yeniləmə xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveOwner(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusyAction("owner");
    setFeedback(null);
    const supabase = createClient();

    try {
      const nextCheckinIso = bakuLocalInputToIso(ownerNextCheckin);
      const parsedCommission =
        commissionValue.trim() === "" ? null : Number(commissionValue);
      const parsedMinPrice =
        ownerMinPrice.trim() === "" ? null : Number(ownerMinPrice);
      const nowIso = new Date().toISOString();

      const patch = {
        owner_outreach_status: ownerStatus,
        commission_type: commissionType,
        commission_value: Number.isNaN(parsedCommission)
          ? null
          : parsedCommission,
        owner_min_price_azn: Number.isNaN(parsedMinPrice)
          ? null
          : parsedMinPrice,
        owner_last_contacted_at:
          ownerStatus !== "NOT_CONTACTED"
            ? nowIso
            : listing.owner_last_contacted_at,
        owner_next_checkin_at: nextCheckinIso,
        owner_notes: ownerNotes.trim() || null,
      };

      const { error } = await supabase
        .from("listings")
        .update(patch)
        .eq("id", listing.id);
      if (error) throw error;

      const eventPayload: Record<string, unknown> = {
        listing_id: listing.id,
        event_type: "OWNER_UPDATED",
        old_value_json: {
          owner_outreach_status: listing.owner_outreach_status,
          commission_type: listing.commission_type,
          commission_value: listing.commission_value,
        },
        new_value_json: {
          owner_outreach_status: patch.owner_outreach_status,
          commission_type: patch.commission_type,
          commission_value: patch.commission_value,
          owner_min_price_azn: patch.owner_min_price_azn,
        },
        actor: "web_user",
      };
      if (agencyId) eventPayload.agency_id = agencyId;

      const { data: ev, error: evErr } = await supabase
        .from("listing_events")
        .insert(eventPayload)
        .select("*")
        .single();
      if (evErr) throw evErr;

      if (nextCheckinIso && nextCheckinIso !== listing.owner_next_checkin_at) {
        const taskPayload: Record<string, unknown> = {
          entity_type: "OWNER_OUTREACH",
          listing_id: listing.id,
          title: `Mülkiyyətçi yoxlaması — ${displayCode} (${listing.contact_name || listing.owner_phone_raw || "Elan"})`,
          due_at: nextCheckinIso,
          priority: "NORMAL",
          status: "OPEN",
        };
        if (agencyId) taskPayload.agency_id = agencyId;

        const { error: taskErr } = await supabase
          .from("follow_up_tasks")
          .insert(taskPayload);
        if (taskErr) throw taskErr;
      }

      setListing((prev) => ({ ...prev, ...patch }));
      if (ev) setEvents((prev) => [ev as ListingEvent, ...prev]);
      setFeedback({
        type: "ok",
        text: "Mülkiyyətçi əlaqə və komissiya məlumatları yadda saxlanıldı.",
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Saxlama xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleAddPublication(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusyAction("publication");
    setFeedback(null);
    const supabase = createClient();

    try {
      const publishedAtIso =
        bakuLocalInputToIso(pubPublishedAt) ?? new Date().toISOString();

      const { data: rpcData, error: rpcErr } = await supabase.rpc(
        "confirm_publication_atomic",
        {
          p_listing_id: listing.id,
          p_channel: pubChannel,
          p_post_url: pubUrl.trim() || null,
          p_render_version_id: pubRenderId || null,
          p_published_at: publishedAtIso,
          p_notes: pubNotes.trim() || null,
          p_target_account_handle: studioTargetAccount,
          p_channel_niche: defaultNiche.niche,
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
          (rpcData as { error?: string }).error || "Paylaşım qeyd edilə bilmədi."
        );
      }

      const pub =
        rpcData && typeof rpcData === "object" && "publication" in rpcData
          ? ((rpcData as { publication?: Publication }).publication ?? null)
          : null;

      if (
        listing.editorial_status !== "PUBLISHED" &&
        listing.editorial_status !== "ARCHIVED"
      ) {
        setListing((prev) => ({ ...prev, editorial_status: "PUBLISHED" }));
      }

      if (pub) {
        setPublications((prev) => [
          pub,
          ...prev.filter((item) => item.id !== pub.id),
        ]);
      }
      setPubUrl("");
      setPubNotes("");
      setFeedback({
        type: "ok",
        text: `${PUBLICATION_CHANNEL_LABELS[pubChannel]} paylaşımı atomik olaraq qeydə alındı.`,
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Paylaşım qeyd xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setBusyAction(null);
    }
  }

  const unifiedStatus = getUnifiedListingStatus(listing, renders, publications);

  return (
    <div className="space-y-6">
      {/* Back + Title */}
      <div className="space-y-3">
        <Link
          href="/listings"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-gold-300"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Elanlar Reyestrinə qayıt</span>
        </Link>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-lg border border-gold-500/40 bg-gold-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-gold-300">
                {displayCode}
              </span>
              {isOffMarket && (
                <StatusBadge label="Eksklüziv Portfel" tone="gold" />
              )}
              <StatusBadge
                label={unifiedStatus.label}
                tone={unifiedStatus.tone}
              />
            </div>

            <h1 className="text-xl font-bold tracking-tight text-slate-50 sm:text-2xl">
              {listing.title || listing.address || `Elan ${displayCode}`}
            </h1>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-300">
              <span className="text-lg font-bold text-gold-300">
                {formatAzn(listing.price_azn_normalized)}
              </span>
              {listing.currency !== "AZN" && listing.price !== null && (
                <span className="text-xs text-slate-400">
                  ({formatPrice(listing.price, listing.currency)})
                </span>
              )}
              <span>
                • {listing.location || listing.district_normalized || "Bakı"}
              </span>
              <span>• {listing.rooms ?? "?"} otaq</span>
              <span>• {listing.area ?? "?"} m²</span>
              {listing.floor !== null && (
                <span>
                  • {listing.floor}/{listing.floors ?? "?"} mərtəbə
                </span>
              )}
              <span>• {ARCHETYPE_LABELS[listing.archetype]}</span>
              {listing.has_bill_of_sale && (
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <FileCheck2 className="h-4 w-4" />
                  Kupçalı
                </span>
              )}
            </div>
          </div>

          {listing.url && (
            <a
              href={listing.url}
              target="_blank"
              rel="noopener noreferrer"
              className="exec-btn-secondary shrink-0 text-xs"
            >
              <span>bina.az-da Aç</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* Action Buttons Bar */}
      <div className="exec-card flex flex-wrap items-center gap-2.5 p-4">
        <button
          type="button"
          disabled={busyAction !== null || !hasEnoughPhotos}
          onClick={() =>
            enqueueRenderJob(
              {
                jobType: "RERENDER",
                selectedPhotoUrls: hasEnoughPhotos ? selectedPhotos : undefined,
                customScript: customScriptText || undefined,
              },
              "rerender"
            )
          }
          className="exec-btn-primary text-xs"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${busyAction === "rerender" ? "animate-spin" : ""}`}
          />
          <span>Yeni Render</span>
        </button>

        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => setRerenderModalOpen(true)}
          className="exec-btn-secondary text-xs"
        >
          <Sliders className="h-3.5 w-3.5 text-gold-400" />
          <span>Ssenari / Səs Dəyiş</span>
        </button>

        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => handleQuickStatus("publish")}
          className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>Paylaşıldı</span>
        </button>

        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => handleQuickStatus("sold_archive")}
          className="exec-btn-danger text-xs"
        >
          <Archive className="h-3.5 w-3.5" />
          <span>Satıldı / Arxivlə</span>
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

      {/* Main 2-column Layout */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left 7 cols: Video Player + Render Versions + Publications */}
        <div className="space-y-6 lg:col-span-7">
          {/* Render Versions + HTML5 MP4 Video Player */}
          <section className="exec-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
                <Film className="h-5 w-5 text-gold-400" />
                <span>Render Versiyaları ({renders.length})</span>
              </h2>
              {selectedRender && (
                <StatusBadge
                  label={`v${selectedRender.version_num} • ${(RENDER_STATUS_META[selectedRender.status] ?? { label: selectedRender.status }).label}`}
                  tone={
                    (
                      RENDER_STATUS_META[selectedRender.status] ?? {
                        tone: "neutral" as BadgeTone,
                      }
                    ).tone
                  }
                />
              )}
            </div>

            {selectedRender ? (
              <div className="grid gap-4 sm:grid-cols-12">
                {/* Embedded HTML5 MP4 Player */}
                <div className="sm:col-span-6">
                  {selectedRender.video_cdn_url &&
                  !selectedRender.storage_pruned_at ? (
                    <div className="overflow-hidden rounded-xl border border-slate-700/80 bg-black aspect-[9/16] max-h-[420px] mx-auto flex items-center justify-center">
                      <video
                        key={selectedRender.id}
                        src={
                          resolveClientVideoSrc(selectedRender) ??
                          selectedRender.video_cdn_url
                        }
                        controls
                        playsInline
                        preload="metadata"
                        className="h-full w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="flex aspect-[9/16] max-h-[340px] mx-auto flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-obsidian-950/70 p-4 text-center">
                      <Video className="h-8 w-8 text-slate-600" />
                      <p className="mt-2 text-xs font-medium text-slate-300">
                        {selectedRender.storage_pruned_at
                          ? "Bu versiyanın MP4 faylı buluddan təmizlənib"
                          : "Video CDN linki hələ hazır deyil"}
                      </p>
                      {selectedRender.local_video_path && (
                        <p className="mt-1 font-mono text-[10px] text-slate-500 break-all">
                          Lokal: {selectedRender.local_video_path}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Version Selector List & Metadata */}
                <div className="sm:col-span-6 space-y-2.5">
                  {(() => {
                    const renderVersionCard = (ver: RenderVersion) => {
                      const active = ver.id === selectedRender.id;
                      const stMeta = RENDER_STATUS_META[ver.status] ?? {
                        label: ver.status,
                        tone: "neutral" as BadgeTone,
                      };
                      const voiceLabel = formatVoiceLabel(ver.voice_id);
                      return (
                        <button
                          key={ver.id}
                          type="button"
                          onClick={() => setSelectedRenderId(ver.id)}
                          className={`w-full rounded-xl border p-3 text-left transition ${
                            active
                              ? "border-gold-500/60 bg-gold-500/10"
                              : "border-slate-800 bg-obsidian-950/70 hover:border-slate-700"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-100">
                              Versiya v{ver.version_num}
                            </span>
                            <StatusBadge
                              label={stMeta.label}
                              tone={stMeta.tone}
                            />
                          </div>
                          <p className="mt-1 text-[11px] text-slate-400">
                            {RENDER_TRIGGER_LABELS[ver.trigger_reason] ??
                              ver.trigger_reason}
                            {voiceLabel ? ` • ${voiceLabel}` : ""}
                            {ver.duration_seconds
                              ? ` • ${Math.round(ver.duration_seconds)}s`
                              : ""}
                          </p>
                          <p className="mt-0.5 text-[10px] text-slate-500">
                            {formatBakuDateTime(ver.created_at)}
                          </p>
                        </button>
                      );
                    };

                    return (
                      <>
                        {primaryRender && renderVersionCard(primaryRender)}

                        {olderRenders.length > 0 && (
                          <div className="space-y-2">
                            <button
                              type="button"
                              onClick={() =>
                                setShowOlderVersions((prev) => !prev)
                              }
                              aria-expanded={showOlderVersions}
                              className="flex w-full items-center justify-between rounded-xl border border-slate-800 bg-obsidian-950/70 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-700 hover:text-slate-100"
                            >
                              <span>
                                Köhnə versiyalar ({olderRenders.length})
                              </span>
                              {showOlderVersions ? (
                                <ChevronUp className="h-4 w-4 text-slate-400" />
                              ) : (
                                <ChevronDown className="h-4 w-4 text-slate-400" />
                              )}
                            </button>

                            {showOlderVersions && (
                              <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                                {olderRenders.map(renderVersionCard)}
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {selectedRender.script_text && (
                    <div className="rounded-xl border border-slate-800 bg-obsidian-950/80 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        Ssenari Mətni
                      </p>
                      <p className="mt-1.5 text-xs text-slate-300 whitespace-pre-wrap max-h-32 overflow-y-auto">
                        {selectedRender.script_text}
                      </p>
                    </div>
                  )}

                  {/* Video System Metadata */}
                  {(() => {
                    const abMeta =
                      selectedRender.ab_metadata &&
                      typeof selectedRender.ab_metadata === "object"
                        ? (selectedRender.ab_metadata as Record<string, unknown>)
                        : null;
                    const visualProfile =
                      abMeta?.visual_profile &&
                      typeof abMeta.visual_profile === "object"
                        ? (abMeta.visual_profile as Record<string, unknown>)
                        : null;
                    const renovationLabel =
                      typeof visualProfile?.renovation_quality === "string"
                        ? visualProfile.renovation_quality
                        : null;

                    return (
                      <div className="rounded-xl border border-slate-800 bg-obsidian-950/80 p-3 space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                          Sistem Video Məlumatları
                        </p>
                        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                          <div>
                            <dt className="text-slate-500">Diktor</dt>
                            <dd className="font-medium text-slate-200 truncate">
                              {formatVoiceLabel(selectedRender.voice_id) ?? "Standart"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-slate-500">Səs Mühərriki</dt>
                            <dd className="font-medium text-slate-200 truncate">
                              {formatVoiceEngineLabel(
                                selectedRender.voice_engine,
                                selectedRender.model_id
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-slate-500">Müddət / Reviziya</dt>
                            <dd className="font-medium text-slate-200">
                              {selectedRender.duration_seconds
                                ? `${Math.round(selectedRender.duration_seconds)} san`
                                : "—"}{" "}
                              • Rev #{selectedRender.content_revision ?? 1}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-slate-500">Render Qiyməti</dt>
                            <dd className="font-medium text-slate-200">
                              {selectedRender.rendered_price
                                ? formatPrice(
                                    selectedRender.rendered_price,
                                    (selectedRender.rendered_currency as "AZN" | "USD") ??
                                      "AZN"
                                  )
                                : formatPrice(listing.price, listing.currency)}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-slate-500">R2 Saxlanc</dt>
                            <dd className="font-medium text-slate-200">
                              {selectedRender.storage_pruned_at
                                ? "Təmizlənib"
                                : selectedRender.storage_object_path ||
                                    selectedRender.video_cdn_url
                                  ? "R2 Aktiv"
                                  : "Gözləyir"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-slate-500">Telegram</dt>
                            <dd className="font-medium text-slate-200">
                              {selectedRender.telegram_message_id
                                ? `Göndərilib (#${selectedRender.telegram_message_id})`
                                : "Göndərilməyib"}
                            </dd>
                          </div>
                          {selectedRender.script_angle && (
                            <div>
                              <dt className="text-slate-500">Ssenari Bucağı</dt>
                              <dd className="font-medium text-slate-200 truncate">
                                {selectedRender.script_angle}
                              </dd>
                            </div>
                          )}
                          {renovationLabel && (
                            <div>
                              <dt className="text-slate-500">AI Təmir Analizi</dt>
                              <dd className="font-medium text-slate-200 truncate">
                                {renovationLabel}
                              </dd>
                            </div>
                          )}
                          <div className="col-span-2">
                            <dt className="text-slate-500">Tamamlanma Tarixi</dt>
                            <dd className="font-medium text-slate-200">
                              {selectedRender.completed_at
                                ? formatBakuDateTime(selectedRender.completed_at)
                                : "Davam edir / Gözləyir"}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    );
                  })()}

                  {selectedRender.error_message && (
                    <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-200">
                      Xəta: {selectedRender.error_message}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-400">
                Bu elan üçün hələ video render versiyası yaradılmayıb. Aşağıdakı
                Pre-Render Studiyasından növbəyə sala bilərsiniz.
              </div>
            )}
          </section>

          {/* Publications Logger */}
          <section className="exec-card p-5 space-y-4">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
              <Share2 className="h-5 w-5 text-gold-400" />
              <span>Paylaşım Jurnalı ({publications.length})</span>
            </h2>

            <form
              onSubmit={handleAddPublication}
              className="rounded-xl border border-slate-800 bg-obsidian-950/70 p-4 space-y-3"
            >
              <p className="text-xs font-semibold text-slate-300">
                Yeni Paylaşım Qeyd Et
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <select
                  aria-label="Platforma"
                  value={pubChannel}
                  onChange={(e) =>
                    setPubChannel(e.target.value as PublicationChannel)
                  }
                  className="exec-select text-xs"
                >
                  {Object.entries(PUBLICATION_CHANNEL_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Render versiyası"
                  value={pubRenderId}
                  onChange={(e) => setPubRenderId(e.target.value)}
                  className="exec-select text-xs"
                >
                  <option value="">Versiya seç (opsional)</option>
                  {sortedRenders.map((r) => {
                    const voiceLabel = formatVoiceLabel(r.voice_id);
                    return (
                      <option key={r.id} value={r.id}>
                        v{r.version_num} ({RENDER_STATUS_META[r.status].label})
                        {voiceLabel ? ` • ${voiceLabel}` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="grid gap-2.5 sm:grid-cols-2">
                <input
                  type="url"
                  value={pubUrl}
                  onChange={(e) => setPubUrl(e.target.value)}
                  placeholder="https://instagram.com/reel/... və ya TikTok/Shorts URL"
                  className="exec-input text-xs"
                />
                <input
                  type="datetime-local"
                  aria-label="Paylaşım vaxtı (Bakı)"
                  value={pubPublishedAt}
                  onChange={(e) => setPubPublishedAt(e.target.value)}
                  className="exec-input text-xs"
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={pubNotes}
                  onChange={(e) => setPubNotes(e.target.value)}
                  placeholder="Qısa qeyd (məs: 1-ci hook yaxşı işlədi)"
                  className="exec-input text-xs flex-1"
                />
                <button
                  type="submit"
                  disabled={busyAction === "publication"}
                  className="exec-btn-primary text-xs shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Paylaşımı Qeyd Et</span>
                </button>
              </div>
            </form>

            {publications.length > 0 && (
              <div className="space-y-2">
                {publications.map((pub) => (
                  <div
                    key={pub.id}
                    className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-slate-800/80 bg-obsidian-950/60 px-3.5 py-2.5 text-xs"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusBadge
                          label={PUBLICATION_CHANNEL_LABELS[pub.channel]}
                          tone="gold"
                        />
                        <span className="text-slate-400">
                          {formatBakuDateTime(
                            pub.published_at || pub.created_at
                          )}
                        </span>
                      </div>
                      {pub.notes && (
                        <p className="text-slate-300">{pub.notes}</p>
                      )}
                    </div>
                    {pub.post_url && (
                      <a
                        href={pub.post_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-gold-300 hover:underline shrink-0"
                      >
                        <span>Linkə bax</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right 5 cols: Owner Outreach & Commission + Event Timeline */}
        <div className="space-y-6 lg:col-span-5">
          {/* Owner Outreach & Commission Editor (hidden PII for SMM) */}
          {memberRole !== "SMM" && (
            <section className="exec-card p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
                    <Phone className="h-4 w-4 text-gold-400" />
                    <span>Mülkiyyətçi &amp; Komissiya</span>
                  </h2>
                  <p className="mt-1 text-xs text-slate-400">
                    {listing.contact_name || "Ad qeyd edilməyib"} •{" "}
                    <span className="font-mono text-slate-200">
                      {listing.owner_phone_raw ||
                        listing.owner_phone_normalized ||
                        "Nömrə yoxdur"}
                    </span>
                  </p>
                </div>

                {waUrl && (
                  <a
                    href={waUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25 shrink-0"
                  >
                    <MessageCircle className="h-4 w-4" />
                    <span>WhatsApp</span>
                  </a>
                )}
              </div>

              <form onSubmit={handleSaveOwner} className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                    Əlaqə Statusu
                  </label>
                  <select
                    value={ownerStatus}
                    onChange={(e) =>
                      setOwnerStatus(e.target.value as OwnerOutreachStatus)
                    }
                    className="exec-select w-full text-xs"
                  >
                    {Object.entries(OWNER_OUTREACH_META).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Komissiya Növü
                    </label>
                    <select
                      value={commissionType}
                      onChange={(e) =>
                        setCommissionType(e.target.value as CommissionType)
                      }
                      className="exec-select w-full text-xs"
                    >
                      <option value="PERCENT">Faiz (%)</option>
                      <option value="FIXED_AZN">Sabit (AZN)</option>
                      <option value="NONE">Komissiyasız</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Komissiya Dəyəri
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={commissionValue}
                      onChange={(e) => setCommissionValue(e.target.value)}
                      placeholder={
                        commissionType === "PERCENT" ? "1.5" : "2000"
                      }
                      className="exec-input text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Son Qiymət (AZN)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={ownerMinPrice}
                      onChange={(e) => setOwnerMinPrice(e.target.value)}
                      placeholder="160000"
                      className="exec-input text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Növbəti Yoxlama (Bakı)
                    </label>
                    <input
                      type="datetime-local"
                      value={ownerNextCheckin}
                      onChange={(e) => setOwnerNextCheckin(e.target.value)}
                      className="exec-input text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                    Mülkiyyətçi Qeydləri
                  </label>
                  <textarea
                    rows={3}
                    value={ownerNotes}
                    onChange={(e) => setOwnerNotes(e.target.value)}
                    placeholder="Mülkiyyətçi ilə danışığın nəticəsi, baxış saatları, endirim şərtləri..."
                    className="exec-input text-xs"
                  />
                </div>

                <button
                  type="submit"
                  disabled={busyAction === "owner"}
                  className="exec-btn-primary w-full text-xs"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>
                    {busyAction === "owner"
                      ? "Yadda saxlanır..."
                      : "Mülkiyyətçi Məlumatını Saxla"}
                  </span>
                </button>
              </form>
            </section>
          )}

          {/* Listing Events Audit Timeline */}
          {(() => {
            type TimelineEntry = {
              id: string;
              label: string;
              tone: BadgeTone;
              timestamp: string;
              summary: string | null;
              actorLabel: string;
              priceDeltaPct?: number | null;
            };

            const timelineItems: TimelineEntry[] = [
              ...events.map((ev) => {
                const meta = EVENT_TYPE_META[ev.event_type] ?? {
                  label: ev.event_type,
                  tone: "neutral" as BadgeTone,
                };
                return {
                  id: `ev-${ev.id}`,
                  label: meta.label,
                  tone: meta.tone,
                  timestamp: ev.created_at,
                  summary: formatListingEventSummary(ev),
                  actorLabel: EVENT_ACTOR_LABELS[ev.actor] ?? ev.actor,
                  priceDeltaPct: ev.price_delta_pct,
                };
              }),
              ...renders.map((r) => {
                const st = RENDER_STATUS_META[r.status] ?? {
                  label: r.status,
                  tone: "neutral" as BadgeTone,
                };
                const voice = formatVoiceLabel(r.voice_id);
                const trigger =
                  RENDER_TRIGGER_LABELS[r.trigger_reason] ?? r.trigger_reason;
                const parts = [
                  trigger,
                  voice,
                  r.duration_seconds
                    ? `${Math.round(r.duration_seconds)}s`
                    : null,
                ].filter(Boolean);
                return {
                  id: `render-${r.id}`,
                  label: `Video v${r.version_num} • ${st.label}`,
                  tone: st.tone,
                  timestamp: r.completed_at ?? r.created_at,
                  summary: parts.length > 0 ? parts.join(" • ") : null,
                  actorLabel: "Video Worker",
                };
              }),
              ...publications.map((pub) => ({
                id: `pub-${pub.id}`,
                label: `${PUBLICATION_CHANNEL_LABELS[pub.channel] ?? pub.channel} Paylaşımı`,
                tone: "emerald" as BadgeTone,
                timestamp: pub.published_at ?? pub.created_at,
                summary: pub.notes || pub.post_url || "Elan yayımlandı",
                actorLabel: "Veb İstifadəçi",
              })),
            ].sort(
              (a, b) =>
                new Date(b.timestamp).getTime() -
                new Date(a.timestamp).getTime()
            );

            return (
              <section className="exec-card p-5 space-y-4">
                <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
                  <History className="h-4 w-4 text-gold-400" />
                  <span>Dəyişiklik Tarixçəsi ({timelineItems.length})</span>
                </h2>

                {timelineItems.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    Hələ dəyişiklik qeydi yoxdur.
                  </p>
                ) : (
                  <ol className="relative space-y-3.5 border-l border-slate-800 pl-4 max-h-[380px] overflow-y-auto pr-1">
                    {timelineItems.map((item) => (
                      <li key={item.id} className="relative space-y-1">
                        <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-obsidian-900 bg-gold-400" />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <StatusBadge label={item.label} tone={item.tone} />
                          <span className="text-[11px] text-slate-500">
                            {formatBakuDateTime(item.timestamp)}
                          </span>
                        </div>

                        {item.priceDeltaPct !== null &&
                          item.priceDeltaPct !== undefined && (
                            <p className="text-xs font-semibold text-emerald-300">
                              Qiymət fərqi:{" "}
                              {Number(item.priceDeltaPct) > 0 ? "+" : ""}
                              {Number(item.priceDeltaPct).toFixed(2)}%
                            </p>
                          )}

                        {item.summary && (
                          <p className="text-xs text-slate-300 leading-relaxed">
                            {item.summary}
                          </p>
                        )}

                        <p className="text-[10px] text-slate-500">
                          Mənbə: {item.actorLabel}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            );
          })()}
        </div>
      </div>

      {/* Pre-Render Media & Script Studio (moved below main video & CRM sections) */}
      <section
        id="pre-render-studio"
        className="exec-card p-5 space-y-4 border-gold-500/30"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-gold-400" />
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Pre-Render Media &amp; Ssenari Studiyası
              </h2>
              <p className="text-xs text-slate-400">
                4–10 foto seçib sıralayın, AI ssenari yaradın (&lt;= 1,000
                simvol) və bulud Railway worker-ə göndərin.
              </p>
            </div>
          </div>
          <span
            className={`rounded-full border px-2.5 py-0.5 font-mono text-xs font-semibold ${
              hasEnoughPhotos
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-amber-500/40 bg-amber-500/15 text-amber-300"
            }`}
          >
            {selectedPhotos.length} / {MAX_STUDIO_PHOTOS} foto seçilib
          </span>
        </div>

        {!hasEnoughPhotos && (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <p className="font-semibold">
                Render üçün ən azı 4 foto tələb olunur (min 4, maks 10).
              </p>
              <p className="mt-0.5 text-amber-100/80">
                Hazırda elanda {photos.length} foto var, {selectedPhotos.length}{" "}
                ədəd seçilib.
              </p>
            </div>
          </div>
        )}

        {/* Photo Selector Grid */}
        {photos.length > 0 && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
              <ImageIcon className="h-3.5 w-3.5 text-gold-400" />
              <span>Foto Seçimi və Sıralama</span>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-5">
              {photos.map((src, idx) => {
                const selectedIdx = selectedPhotos.indexOf(src);
                const isSelected = selectedIdx !== -1;

                return (
                  <div
                    key={`${src}-${idx}`}
                    className={`rounded-xl border overflow-hidden transition ${
                      isSelected
                        ? "border-gold-400/70 bg-gold-500/10"
                        : "border-slate-800 bg-obsidian-950/70 opacity-75 hover:opacity-100"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => togglePhotoSelection(src)}
                      className="relative block w-full aspect-[4/3] bg-obsidian-950"
                    >
                      <img
                        src={src}
                        alt={`Foto ${idx + 1}`}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                      <span
                        className={`absolute top-1.5 left-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${
                          isSelected
                            ? "bg-gold-400 text-obsidian-950"
                            : "bg-obsidian-950/80 text-slate-300 border border-slate-700"
                        }`}
                      >
                        {isSelected ? (
                          <span className="inline-flex items-center gap-0.5">
                            <Check className="h-3 w-3" />
                            {selectedIdx + 1}
                          </span>
                        ) : (
                          "+"
                        )}
                      </span>
                    </button>

                    {isSelected && (
                      <div className="flex items-center justify-between gap-1 px-2 py-1 bg-obsidian-950/90 border-t border-slate-800/80">
                        <button
                          type="button"
                          aria-label={`Foto ${selectedIdx + 1} sola`}
                          disabled={selectedIdx === 0}
                          onClick={() => moveSelectedPhoto(selectedIdx, -1)}
                          className="rounded p-0.5 text-slate-300 hover:bg-obsidian-800 disabled:opacity-30"
                        >
                          <ArrowLeft className="h-3 w-3" />
                        </button>
                        <span className="font-mono text-[10px] text-gold-300">
                          #{selectedIdx + 1}
                        </span>
                        <button
                          type="button"
                          aria-label={`Foto ${selectedIdx + 1} sağa`}
                          disabled={selectedIdx === selectedPhotos.length - 1}
                          onClick={() => moveSelectedPhoto(selectedIdx, 1)}
                          className="rounded p-0.5 text-slate-300 hover:bg-obsidian-800 disabled:opacity-30"
                        >
                          <ArrowRight className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Script Editor + Target Account + Voice Preset */}
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="space-y-2 lg:col-span-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="studio-script-textarea"
                className="text-xs font-semibold text-slate-300"
              >
                Video Ssenarisi (İxtiyari / Redaktə Oluna Bilən)
              </label>
              <div className="flex items-center gap-2">
                <span
                  className={`font-mono text-[11px] ${
                    scriptTooLong ? "text-rose-400 font-bold" : "text-slate-400"
                  }`}
                >
                  {customScriptText.length} / {MAX_SCRIPT_CHARS}
                </span>
                <button
                  type="button"
                  disabled={generatingScript}
                  onClick={handleGenerateRenderScript}
                  className="exec-btn-secondary py-1 px-2.5 text-xs"
                >
                  <Sparkles className="h-3.5 w-3.5 text-gold-400" />
                  <span>
                    {generatingScript ? "Yaradılır..." : "AI Ssenari Yarat"}
                  </span>
                </button>
              </div>
            </div>

            <textarea
              id="studio-script-textarea"
              rows={4}
              value={customScriptText}
              onChange={(e) => setCustomScriptText(e.target.value)}
              placeholder="AI Ssenari Yarat düyməsini sıxın və ya öz ssenarinizi yazın (maksimum 1,000 simvol)..."
              className={`exec-input text-xs ${
                scriptTooLong ? "border-rose-500/70" : ""
              }`}
            />
            {scriptTooLong && (
              <p className="text-[11px] text-rose-400">
                Ssenari 1,000 simvol limitini aşır. Zəhmət olmasa qısaldın.
              </p>
            )}
          </div>

          <div className="space-y-3 lg:col-span-4">
            <div className="space-y-1">
              <label
                htmlFor="studio-target-account"
                className="text-xs font-medium text-slate-300"
              >
                Hədəf Kanal / Hesab
              </label>
              <select
                id="studio-target-account"
                value={studioTargetAccount}
                onChange={(e) => setStudioTargetAccount(e.target.value)}
                className="exec-select w-full text-xs"
              >
                {TARGET_ACCOUNTS.map((acc) => (
                  <option key={acc.handle} value={acc.handle}>
                    {acc.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="studio-voice-select"
                className="text-xs font-medium text-slate-300"
              >
                Diktor Səsi
              </label>
              <select
                id="studio-voice-select"
                value={studioVoiceIdx}
                onChange={(e) => setStudioVoiceIdx(Number(e.target.value))}
                className="exec-select w-full text-xs"
              >
                {VOICE_OPTIONS.map((v, idx) => (
                  <option key={v.label} value={idx}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              disabled={
                busyAction !== null || !hasEnoughPhotos || scriptTooLong
              }
              onClick={handleStudioRenderSubmit}
              className="exec-btn-primary w-full text-xs"
            >
              <Film className="h-3.5 w-3.5" />
              <span>
                {busyAction === "studio_render"
                  ? "Növbəyə salınır..."
                  : "Renderə Göndər"}
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* Script / Voice Rerender Modal */}
      {rerenderModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="exec-card w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-100">
                Ssenari və Səs Dəyişikliyi
              </h3>
              <button
                type="button"
                onClick={() => setRerenderModalOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-obsidian-800 hover:text-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  Ssenari Bucağı (Script Angle)
                </label>
                <select
                  value={scriptAngle}
                  onChange={(e) => setScriptAngle(e.target.value)}
                  className="exec-select w-full text-xs"
                >
                  {SCRIPT_ANGLES.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  Səs Mühərriki və Diktor
                </label>
                <select
                  value={voiceChoiceIdx}
                  onChange={(e) => setVoiceChoiceIdx(Number(e.target.value))}
                  className="exec-select w-full text-xs"
                >
                  {VOICE_OPTIONS.map((v, idx) => (
                    <option key={v.label} value={idx}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRerenderModalOpen(false)}
                className="exec-btn-secondary text-xs"
              >
                Ləğv et
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => {
                  const chosen = VOICE_OPTIONS[voiceChoiceIdx];
                  enqueueRenderJob(
                    {
                      jobType: "RERENDER",
                      targetAccount: studioTargetAccount,
                      voicePreset: chosen?.preset ?? "Arif",
                      selectedPhotoUrls: hasEnoughPhotos
                        ? selectedPhotos
                        : undefined,
                      customScript: customScriptText || undefined,
                    },
                    "custom_rerender"
                  );
                }}
                className="exec-btn-primary text-xs"
              >
                Növbəyə Sal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
