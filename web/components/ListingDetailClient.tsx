"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  FileCheck2,
  Film,
  History,
  MessageCircle,
  Phone,
  Plus,
  RefreshCw,
  Save,
  Share2,
  Sliders,
  Video,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  ARCHETYPE_LABELS,
  type BadgeTone,
  buildWhatsAppUrl,
  DUPLICATE_RESOLUTION_META,
  EDITORIAL_STATUS_META,
  EVENT_TYPE_META,
  formatAzn,
  formatBakuDateTime,
  formatPrice,
  OWNER_OUTREACH_META,
  PIPELINE_STATUS_META,
  PUBLICATION_CHANNEL_LABELS,
  RENDER_STATUS_META,
  RENDER_TRIGGER_LABELS,
  SOURCE_AVAILABILITY_META,
} from "@/lib/format";
import type {
  CommissionType,
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
}

const SCRIPT_ANGLES = [
  { value: "default", label: "Standart (Balanslı)" },
  { value: "investment", label: "İnvestisiya / Gəlir Bucağı" },
  { value: "family", label: "Ailəvi & Rahatlıq" },
  { value: "price_drop", label: "Təcili Endirim / Fürsət" },
  { value: "luxury", label: "Lüks & Eksklüziv" },
];

const VOICE_OPTIONS = [
  { engine: "elevenlabs_v4", voiceId: "arif", label: "ElevenLabs v4 — Arif (Kişi, Premium)" },
  { engine: "elevenlabs_v4", voiceId: "leyla", label: "ElevenLabs v4 — Leyla (Qadın, Səmimi)" },
  { engine: "elevenlabs_v4", voiceId: "kamran", label: "ElevenLabs v4 — Kamran (Dinamik)" },
  { engine: "openai", voiceId: "nova", label: "OpenAI TTS — Nova (Ehtiyat)" },
  { engine: "openai", voiceId: "onyx", label: "OpenAI TTS — Onyx (Ehtiyat)" },
];

function toLocalDateTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Format in Asia/Baku (+04:00) for datetime-local input
  const bakuMs = d.getTime() + 4 * 60 * 60 * 1000;
  return new Date(bakuMs).toISOString().slice(0, 16);
}

function bakuLocalInputToIso(localValue: string): string | null {
  if (!localValue) return null;
  const parsed = new Date(`${localValue}:00+04:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function ListingDetailClient({
  initialListing,
  initialEvents,
  initialRenders,
  initialPublications,
}: ListingDetailClientProps) {
  const [listing, setListing] = useState<Listing>(initialListing);
  const [events, setEvents] = useState<ListingEvent[]>(initialEvents);
  const [renders] = useState<RenderVersion[]>(initialRenders);
  const [publications, setPublications] =
    useState<Publication[]>(initialPublications);

  const playableDefault =
    initialRenders.find((r) => r.video_cdn_url && !r.storage_pruned_at) ??
    initialRenders[0] ??
    null;
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(
    playableDefault?.id ?? null
  );

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

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

  const selectedRender =
    renders.find((r) => r.id === selectedRenderId) ?? renders[0] ?? null;

  const waUrl = buildWhatsAppUrl(
    listing.owner_phone_normalized || listing.owner_phone_raw,
    `Salam! bina.az-dakı #${listing.bina_id} nömrəli elanınız (${listing.location || "Bakı"}, ${formatAzn(listing.price_azn_normalized)}) ilə bağlı əlaqə saxlayıram. Mənzil hələ aktualdırmı?`
  );

  async function enqueueRenderJob(params: Record<string, unknown>, label: string) {
    setBusyAction(label);
    setFeedback(null);
    const supabase = createClient();

    try {
      const idempotencyKey = `web_rerender:${listing.bina_id}:${Date.now()}`;
      const { data: job, error: jobErr } = await supabase
        .from("pipeline_jobs")
        .insert({
          idempotency_key: idempotencyKey,
          job_type: "RERENDER",
          listing_id: listing.id,
          trigger_source: "WEB_UI",
          params_json: params,
          status: "QUEUED",
        })
        .select("id")
        .single();

      if (jobErr) throw jobErr;

      await supabase
        .from("listings")
        .update({
          pipeline_status: "QUEUED",
          editorial_status: "NEEDS_RERENDER",
        })
        .eq("id", listing.id);

      const { data: ev } = await supabase
        .from("listing_events")
        .insert({
          listing_id: listing.id,
          event_type: "STATUS_CHANGED",
          old_value_json: {
            pipeline_status: listing.pipeline_status,
            editorial_status: listing.editorial_status,
          },
          new_value_json: {
            pipeline_status: "QUEUED",
            editorial_status: "NEEDS_RERENDER",
            ...params,
          },
          triggered_job_id: job?.id ?? null,
          actor: "web_user",
        })
        .select("*")
        .single();

      setListing((prev) => ({
        ...prev,
        pipeline_status: "QUEUED",
        editorial_status: "NEEDS_RERENDER",
      }));
      if (ev) {
        setEvents((prev) => [ev as ListingEvent, ...prev]);
      }

      setRerenderModalOpen(false);
      setFeedback({
        type: "ok",
        text: "Render işi pipeline_jobs növbəsinə əlavə edildi. Lokal worker aktiv olan kimi icra olunacaq.",
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

  async function handleQuickStatus(mode: "publish" | "sold_archive") {
    setBusyAction(mode);
    setFeedback(null);
    const supabase = createClient();

    try {
      if (mode === "publish") {
        const { error } = await supabase
          .from("listings")
          .update({ editorial_status: "PUBLISHED" })
          .eq("id", listing.id);
        if (error) throw error;

        const { data: ev } = await supabase
          .from("listing_events")
          .insert({
            listing_id: listing.id,
            event_type: "STATUS_CHANGED",
            old_value_json: { editorial_status: listing.editorial_status },
            new_value_json: { editorial_status: "PUBLISHED" },
            actor: "web_user",
          })
          .select("*")
          .single();

        setListing((prev) => ({ ...prev, editorial_status: "PUBLISHED" }));
        if (ev) setEvents((prev) => [ev as ListingEvent, ...prev]);
        setFeedback({
          type: "ok",
          text: "Elan statusu PAYLAŞILDI olaraq yeniləndi.",
        });
      } else {
        const { error } = await supabase
          .from("listings")
          .update({
            editorial_status: "ARCHIVED",
            owner_outreach_status: "OWNER_SOLD",
            source_availability: "CONFIRMED_SOLD",
          })
          .eq("id", listing.id);
        if (error) throw error;

        const { data: ev } = await supabase
          .from("listing_events")
          .insert({
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
          })
          .select("*")
          .single();

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
          ownerStatus !== "NOT_CONTACTED" ? nowIso : listing.owner_last_contacted_at,
        owner_next_checkin_at: nextCheckinIso,
        owner_notes: ownerNotes.trim() || null,
      };

      const { error } = await supabase
        .from("listings")
        .update(patch)
        .eq("id", listing.id);
      if (error) throw error;

      const { data: ev } = await supabase
        .from("listing_events")
        .insert({
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
        })
        .select("*")
        .single();

      // Create an OWNER_OUTREACH follow-up task if next check-in was set
      if (nextCheckinIso && nextCheckinIso !== listing.owner_next_checkin_at) {
        await supabase.from("follow_up_tasks").insert({
          entity_type: "OWNER_OUTREACH",
          listing_id: listing.id,
          title: `Mülkiyyətçi yoxlaması — #${listing.bina_id} (${listing.contact_name || listing.owner_phone_raw || "Elan"})`,
          due_at: nextCheckinIso,
          priority: "NORMAL",
          status: "OPEN",
        });
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

      const { data: pub, error } = await supabase
        .from("publications")
        .insert({
          listing_id: listing.id,
          render_version_id: pubRenderId || null,
          channel: pubChannel,
          post_url: pubUrl.trim() || null,
          status: "PUBLISHED",
          published_at: publishedAtIso,
          notes: pubNotes.trim() || null,
        })
        .select("*")
        .single();

      if (error) throw error;

      // Also advance editorial_status to PUBLISHED if not archived
      if (
        listing.editorial_status !== "PUBLISHED" &&
        listing.editorial_status !== "ARCHIVED"
      ) {
        await supabase
          .from("listings")
          .update({ editorial_status: "PUBLISHED" })
          .eq("id", listing.id);
        setListing((prev) => ({ ...prev, editorial_status: "PUBLISHED" }));
      }

      if (pub) {
        setPublications((prev) => [pub as Publication, ...prev]);
      }
      setPubUrl("");
      setPubNotes("");
      setFeedback({
        type: "ok",
        text: `${PUBLICATION_CHANNEL_LABELS[pubChannel]} paylaşımı qeydə alındı.`,
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

  const edMeta = EDITORIAL_STATUS_META[listing.editorial_status] ?? {
    label: listing.editorial_status || "Baxış gözləyir",
    tone: "amber" as BadgeTone,
  };
  const avMeta = SOURCE_AVAILABILITY_META[listing.source_availability] ?? {
    label: listing.source_availability || "Aktiv",
    tone: "emerald" as BadgeTone,
  };
  const pipeMeta = PIPELINE_STATUS_META[listing.pipeline_status] ?? {
    label: listing.pipeline_status || "Yeni",
    tone: "sky" as BadgeTone,
  };
  const ownerMeta = OWNER_OUTREACH_META[listing.owner_outreach_status] ?? {
    label: listing.owner_outreach_status || "Əlaqə yoxdur",
    tone: "neutral" as BadgeTone,
  };
  const dupMeta = DUPLICATE_RESOLUTION_META[listing.duplicate_resolution] ?? {
    label: listing.duplicate_resolution || "Təkrarsız",
    tone: "neutral" as BadgeTone,
  };

  const photos = Array.isArray(listing.photo_urls) ? listing.photo_urls : [];

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
                #{listing.bina_id}
              </span>
              <StatusBadge label={edMeta.label} tone={edMeta.tone} />
              <StatusBadge label={avMeta.label} tone={avMeta.tone} />
              <StatusBadge label={pipeMeta.label} tone={pipeMeta.tone} />
              <StatusBadge label={ownerMeta.label} tone={ownerMeta.tone} />
              {listing.duplicate_resolution !== "NONE" && (
                <StatusBadge label={dupMeta.label} tone={dupMeta.tone} />
              )}
            </div>

            <h1 className="text-xl font-bold tracking-tight text-slate-50 sm:text-2xl">
              {listing.title || listing.address || `Elan #${listing.bina_id}`}
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
              <span>• {listing.location || listing.district_normalized || "Bakı"}</span>
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

          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            className="exec-btn-secondary shrink-0 text-xs"
          >
            <span>bina.az-da Aç</span>
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {/* Action Buttons Bar */}
      <div className="exec-card flex flex-wrap items-center gap-2.5 p-4">
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() =>
            enqueueRenderJob(
              { trigger_reason: "MANUAL_RERENDER" },
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
        {/* Left 7 cols: Video Player + Render Versions + Publications + Photos */}
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
                  tone={(RENDER_STATUS_META[selectedRender.status] ?? { tone: "neutral" as BadgeTone }).tone}
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
                        src={selectedRender.video_cdn_url}
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
                          ? "Bu versiyanın MP4 faylı buluddan təmizlənib (14 gün qaydası)"
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
                  <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                    {renders.map((ver) => {
                      const active = ver.id === selectedRender.id;
                      const stMeta = RENDER_STATUS_META[ver.status] ?? {
                        label: ver.status,
                        tone: "neutral" as BadgeTone,
                      };
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
                            {RENDER_TRIGGER_LABELS[ver.trigger_reason] ?? ver.trigger_reason}
                            {ver.voice_id ? ` • ${ver.voice_id}` : ""}
                            {ver.duration_seconds
                              ? ` • ${Math.round(ver.duration_seconds)}s`
                              : ""}
                          </p>
                          <p className="mt-0.5 text-[10px] text-slate-500">
                            {formatBakuDateTime(ver.created_at)}
                          </p>
                        </button>
                      );
                    })}
                  </div>

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

                  {selectedRender.error_message && (
                    <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-200">
                      Xəta: {selectedRender.error_message}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-400">
                Bu elan üçün hələ video render versiyası yaradılmayıb. Yuxarıdakı
                &ldquo;Yeni Render&rdquo; düyməsi ilə növbəyə sala bilərsiniz.
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
                  {renders.map((r) => (
                    <option key={r.id} value={r.id}>
                      v{r.version_num} ({RENDER_STATUS_META[r.status].label})
                    </option>
                  ))}
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
                          {formatBakuDateTime(pub.published_at || pub.created_at)}
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

          {/* Photo Gallery Strip */}
          {photos.length > 0 && (
            <section className="exec-card p-5 space-y-3">
              <h2 className="text-sm font-semibold text-slate-200">
                Elan Fotoları ({photos.length})
              </h2>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photos.slice(0, 8).map((src, idx) => (
                  <a
                    key={`${src}-${idx}`}
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block overflow-hidden rounded-lg border border-slate-800 aspect-[4/3] bg-obsidian-950"
                  >
                    <img
                      src={src}
                      alt={`Foto ${idx + 1}`}
                      loading="lazy"
                      className="h-full w-full object-cover hover:scale-105 transition"
                    />
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right 5 cols: Owner Outreach & Commission + Event Timeline */}
        <div className="space-y-6 lg:col-span-5">
          {/* Owner Outreach & Commission Editor */}
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
                    placeholder={commissionType === "PERCENT" ? "1.5" : "2000"}
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

          {/* Listing Events Audit Timeline */}
          <section className="exec-card p-5 space-y-4">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
              <History className="h-4 w-4 text-gold-400" />
              <span>Dəyişiklik Tarixçəsi ({events.length})</span>
            </h2>

            {events.length === 0 ? (
              <p className="text-xs text-slate-400">
                Hələ dəyişiklik qeydi yoxdur.
              </p>
            ) : (
              <ol className="relative space-y-4 border-l border-slate-800 pl-4">
                {events.map((ev) => {
                  const meta = EVENT_TYPE_META[ev.event_type] ?? {
                    label: ev.event_type,
                    tone: "neutral" as BadgeTone,
                  };
                  return (
                    <li key={ev.id} className="relative space-y-1">
                      <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-obsidian-900 bg-gold-400" />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <StatusBadge label={meta.label} tone={meta.tone} />
                        <span className="text-[11px] text-slate-500">
                          {formatBakuDateTime(ev.created_at)}
                        </span>
                      </div>

                      {ev.price_delta_pct !== null && (
                        <p className="text-xs font-semibold text-emerald-300">
                          Qiymət fərqi:{" "}
                          {Number(ev.price_delta_pct) > 0 ? "+" : ""}
                          {Number(ev.price_delta_pct).toFixed(2)}%
                        </p>
                      )}

                      {(ev.old_value_json || ev.new_value_json) && (
                        <div className="rounded-lg border border-slate-800/80 bg-obsidian-950/70 p-2 font-mono text-[11px] text-slate-400 overflow-x-auto">
                          {ev.old_value_json && (
                            <div className="text-slate-500">
                              Köhnə: {JSON.stringify(ev.old_value_json)}
                            </div>
                          )}
                          {ev.new_value_json && (
                            <div className="text-slate-200">
                              Yeni: {JSON.stringify(ev.new_value_json)}
                            </div>
                          )}
                        </div>
                      )}

                      <p className="text-[10px] uppercase tracking-wider text-slate-500">
                        Mənbə: {ev.actor}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </div>

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
                      trigger_reason: "SCRIPT_ANGLE",
                      script_angle: scriptAngle,
                      voice_engine: chosen.engine,
                      voice_id: chosen.voiceId,
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
