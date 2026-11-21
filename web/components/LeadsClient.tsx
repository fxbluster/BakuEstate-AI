"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import {
  AlertOctagon,
  Bot,
  Building2,
  Calendar,
  DollarSign,
  Link2,
  MessageCircle,
  Plus,
  Save,
  Search,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useCopilot } from "@/lib/copilot-context";
import {
  buildWhatsAppUrl,
  formatAzn,
  formatBakuDateTime,
  LEAD_RELATION_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_STAGE_META,
  normalizePhoneInput,
  OWNER_OUTREACH_META,
  SOURCE_AVAILABILITY_META,
} from "@/lib/format";
import type {
  BuyerLeadWithListings,
  LeadListingJoin,
  LeadListingRelation,
  LeadSourceChannel,
  LeadStage,
} from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

export interface ListingPickerOption {
  id: string;
  bina_id: string;
  title: string | null;
  location: string | null;
  price_azn_normalized: number;
  source_availability: string;
  owner_outreach_status: string;
  rooms: number | null;
  area: number | null;
}

interface LeadsClientProps {
  initialLeads: BuyerLeadWithListings[];
  listingOptions: ListingPickerOption[];
}

const STAGE_ORDER: LeadStage[] = [
  "NEW_INQUIRY",
  "QUALIFIED",
  "VIEWING_SCHEDULED",
  "VIEWED",
  "NEGOTIATING",
  "DEPOSIT",
  "WON_CLOSED",
  "LOST",
  "COLD",
];

function bakuLocalInputToIso(localValue: string): string | null {
  if (!localValue) return null;
  const parsed = new Date(`${localValue}:00+04:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function defaultFollowupLocalBaku(): string {
  const bakuMs = Date.now() + (4 + 24) * 60 * 60 * 1000;
  return `${new Date(bakuMs).toISOString().slice(0, 10)}T11:00`;
}

function isListingUnavailable(
  item: NonNullable<LeadListingJoin["listings"]>
): boolean {
  return (
    item.owner_outreach_status === "OWNER_SOLD" ||
    item.source_availability === "REMOVED_ON_BINA" ||
    item.source_availability === "CONFIRMED_SOLD"
  );
}

export function LeadsClient({
  initialLeads,
  listingOptions,
}: LeadsClientProps) {
  const { openAgentHub } = useCopilot();
  const [leads, setLeads] = useState<BuyerLeadWithListings[]>(initialLeads);

  // Sync leads to localStorage cache for Tier 0 0ms Cockpit HUD rendering
  useEffect(() => {
    if (typeof window !== "undefined" && leads && leads.length > 0) {
      try {
        localStorage.setItem(
          "bakuestate_cached_leads_v1",
          JSON.stringify(leads.slice(0, 20))
        );
      } catch {
        // Suppress localStorage quota or serialization issues
      }
    }
  }, [leads]);

  const [stageFilter, setStageFilter] = useState<LeadStage | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [feedback, setFeedback] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  // Quick-Add Modal State
  const [addOpen, setAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [clientName, setClientName] = useState("");
  const [phoneOrHandle, setPhoneOrHandle] = useState("");
  const [sourceChannel, setSourceChannel] =
    useState<LeadSourceChannel>("IG_DM");
  const [initialStage, setInitialStage] = useState<LeadStage>("NEW_INQUIRY");
  const [linkedListingId, setLinkedListingId] = useState("");
  const [nextFollowupLocal, setNextFollowupLocal] = useState(
    defaultFollowupLocalBaku()
  );
  const [budgetMax, setBudgetMax] = useState("");
  const [expectedComm, setExpectedComm] = useState("");
  const [notes, setNotes] = useState("");

  // Inline Commission / Outcome Editor Modal
  const [editingLead, setEditingLead] = useState<BuyerLeadWithListings | null>(
    null
  );
  const [editStage, setEditStage] = useState<LeadStage>("NEW_INQUIRY");
  const [editExpected, setEditExpected] = useState("");
  const [editActual, setEditActual] = useState("");
  const [editLostReason, setEditLostReason] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // Link Alternative Apartment Modal
  const [linkingLeadId, setLinkingLeadId] = useState<string | null>(null);
  const [altListingId, setAltListingId] = useState("");
  const [altRelation, setAltRelation] =
    useState<LeadListingRelation>("PITCHED");

  const stageCounts = useMemo(() => {
    const map: Record<string, number> = { ALL: leads.length };
    for (const s of STAGE_ORDER) map[s] = 0;
    for (const l of leads) {
      map[l.stage] = (map[l.stage] ?? 0) + 1;
    }
    return map;
  }, [leads]);

  const commissionTotals = useMemo(() => {
    let expected = 0;
    let actual = 0;
    for (const l of leads) {
      if (l.stage !== "LOST" && l.stage !== "COLD") {
        expected += Number(l.expected_commission_azn ?? 0);
      }
      if (l.stage === "WON_CLOSED") {
        actual += Number(l.actual_commission_azn ?? 0);
      }
    }
    return { expected, actual };
  }, [leads]);

  const filteredLeads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (stageFilter !== "ALL" && lead.stage !== stageFilter) return false;
      if (q) {
        const hay = [
          lead.client_name,
          lead.phone_normalized,
          lead.social_handle,
          lead.notes,
          ...lead.lead_listings.map(
            (ll) => `${ll.listings?.bina_id ?? ""} ${ll.listings?.title ?? ""}`
          ),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [leads, stageFilter, search]);

  async function handleQuickAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!clientName.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    const supabase = createClient();

    try {
      const contactTrim = phoneOrHandle.trim();
      const isHandle = contactTrim.startsWith("@") || /[a-zA-Z]/.test(contactTrim);
      const phoneNormalized =
        contactTrim && !isHandle ? normalizePhoneInput(contactTrim) : null;
      const socialHandle = contactTrim && isHandle ? contactTrim : null;
      const followupIso = bakuLocalInputToIso(nextFollowupLocal);

      const { data: createdLead, error: leadErr } = await supabase
        .from("buyer_leads")
        .insert({
          client_name: clientName.trim(),
          phone_normalized: phoneNormalized,
          social_handle: socialHandle,
          source_channel: sourceChannel,
          stage: initialStage,
          budget_max_azn: budgetMax.trim() ? Number(budgetMax) : null,
          expected_commission_azn: expectedComm.trim()
            ? Number(expectedComm)
            : null,
          notes: notes.trim() || null,
          next_followup_at: followupIso,
        })
        .select("*")
        .single();

      if (leadErr) throw leadErr;

      let linkedJoin: LeadListingJoin[] = [];
      if (linkedListingId && createdLead) {
        const { error: linkErr } = await supabase.from("lead_listings").insert({
          lead_id: createdLead.id,
          listing_id: linkedListingId,
          relation: "INQUIRED",
        });
        if (linkErr) throw linkErr;

        const opt = listingOptions.find((o) => o.id === linkedListingId);
        if (opt) {
          linkedJoin = [
            {
              lead_id: createdLead.id,
              listing_id: opt.id,
              relation: "INQUIRED",
              notes: null,
              updated_at: new Date().toISOString(),
              listings: {
                id: opt.id,
                bina_id: opt.bina_id,
                title: opt.title,
                location: opt.location,
                price_azn_normalized: opt.price_azn_normalized,
                source_availability: opt.source_availability as NonNullable<
                  LeadListingJoin["listings"]
                >["source_availability"],
                owner_outreach_status: opt.owner_outreach_status as NonNullable<
                  LeadListingJoin["listings"]
                >["owner_outreach_status"],
                editorial_status: "PENDING_REVIEW",
                rooms: opt.rooms,
                area: opt.area,
              },
            },
          ];
        }
      }

      if (followupIso && createdLead) {
        await supabase.from("follow_up_tasks").insert({
          entity_type: "BUYER_LEAD",
          lead_id: createdLead.id,
          listing_id: linkedListingId || null,
          title: `Müştəri follow-up: ${clientName.trim()} (${LEAD_STAGE_META[initialStage].label})`,
          due_at: followupIso,
          priority:
            initialStage === "VIEWING_SCHEDULED" || initialStage === "DEPOSIT"
              ? "HIGH"
              : "NORMAL",
          status: "OPEN",
        });
      }

      const fullLead: BuyerLeadWithListings = {
        ...(createdLead as BuyerLeadWithListings),
        lead_listings: linkedJoin,
      };
      setLeads((prev) => [fullLead, ...prev]);
      setAddOpen(false);
      setClientName("");
      setPhoneOrHandle("");
      setLinkedListingId("");
      setBudgetMax("");
      setExpectedComm("");
      setNotes("");
      setNextFollowupLocal(defaultFollowupLocalBaku());
      setFeedback({
        type: "ok",
        text: `${fullLead.client_name} CRM-ə əlavə edildi və follow-up xatırlatması yaradıldı.`,
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Müştəri əlavə xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleQuickStageChange(lead: BuyerLeadWithListings, nextStage: LeadStage) {
    const supabase = createClient();
    const { error } = await supabase
      .from("buyer_leads")
      .update({ stage: nextStage })
      .eq("id", lead.id);
    if (error) {
      setFeedback({ type: "err", text: `Mərhələ xətası: ${error.message}` });
      return;
    }
    setLeads((prev) =>
      prev.map((l) => (l.id === lead.id ? { ...l, stage: nextStage } : l))
    );
  }

  function openEditModal(lead: BuyerLeadWithListings) {
    setEditingLead(lead);
    setEditStage(lead.stage);
    setEditExpected(
      lead.expected_commission_azn !== null
        ? String(lead.expected_commission_azn)
        : ""
    );
    setEditActual(
      lead.actual_commission_azn !== null
        ? String(lead.actual_commission_azn)
        : ""
    );
    setEditLostReason(lead.lost_reason ?? "");
    setEditNotes(lead.notes ?? "");
  }

  async function handleSaveEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editingLead) return;
    setSubmitting(true);
    const supabase = createClient();

    try {
      const patch = {
        stage: editStage,
        expected_commission_azn: editExpected.trim()
          ? Number(editExpected)
          : null,
        actual_commission_azn: editActual.trim() ? Number(editActual) : null,
        lost_reason: editLostReason.trim() || null,
        notes: editNotes.trim() || null,
      };

      const { error } = await supabase
        .from("buyer_leads")
        .update(patch)
        .eq("id", editingLead.id);
      if (error) throw error;

      setLeads((prev) =>
        prev.map((l) => (l.id === editingLead.id ? { ...l, ...patch } : l))
      );
      setEditingLead(null);
      setFeedback({
        type: "ok",
        text: "Müştəri nəticə və komissiya məlumatı yeniləndi.",
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Yeniləmə xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLinkAlternative(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!linkingLeadId || !altListingId) return;
    setSubmitting(true);
    const supabase = createClient();

    try {
      const { error } = await supabase.from("lead_listings").upsert({
        lead_id: linkingLeadId,
        listing_id: altListingId,
        relation: altRelation,
      });
      if (error) throw error;

      const opt = listingOptions.find((o) => o.id === altListingId);
      if (opt) {
        const newLink: LeadListingJoin = {
          lead_id: linkingLeadId,
          listing_id: opt.id,
          relation: altRelation,
          notes: null,
          updated_at: new Date().toISOString(),
          listings: {
            id: opt.id,
            bina_id: opt.bina_id,
            title: opt.title,
            location: opt.location,
            price_azn_normalized: opt.price_azn_normalized,
            source_availability: opt.source_availability as NonNullable<
              LeadListingJoin["listings"]
            >["source_availability"],
            owner_outreach_status: opt.owner_outreach_status as NonNullable<
              LeadListingJoin["listings"]
            >["owner_outreach_status"],
            editorial_status: "PENDING_REVIEW",
            rooms: opt.rooms,
            area: opt.area,
          },
        };
        setLeads((prev) =>
          prev.map((l) => {
            if (l.id !== linkingLeadId) return l;
            const exists = l.lead_listings.some(
              (ll) => ll.listing_id === opt.id
            );
            return {
              ...l,
              lead_listings: exists
                ? l.lead_listings.map((ll) =>
                    ll.listing_id === opt.id ? newLink : ll
                  )
                : [newLink, ...l.lead_listings],
            };
          })
        );
      }

      setLinkingLeadId(null);
      setAltListingId("");
      setFeedback({
        type: "ok",
        text: "Alternativ mənzil müştəri profilinə bağlandı.",
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Əlaqələndirmə xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-400">
            Satış Qıfı &amp; Komissiya Uçotu
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Müştəri CRM &amp; Follow-Up
          </h1>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="exec-btn-primary"
        >
          <UserPlus className="h-4 w-4" />
          <span>10-San Müştəri Əlavə Et</span>
        </button>
      </div>

      {/* Commission KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Ümumi Müştəri</p>
          <p className="mt-1.5 text-2xl font-bold text-slate-50">
            {leads.length}
          </p>
        </div>
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Gözlənilən Komissiya (Aktiv)</p>
          <p className="mt-1.5 text-2xl font-bold text-gold-300">
            {formatAzn(commissionTotals.expected)}
          </p>
        </div>
        <div className="exec-card p-4 col-span-2 sm:col-span-1">
          <p className="text-xs text-slate-400">Qazanılmış Komissiya (Bağlı)</p>
          <p className="mt-1.5 text-2xl font-bold text-emerald-300">
            {formatAzn(commissionTotals.actual)}
          </p>
        </div>
      </div>

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

      {/* Stage Funnel Filter Strip + Search */}
      <div className="exec-card p-4 space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Müştəri adı, telefon, @handle və ya bağlı bina_id axtar..."
            className="exec-input pl-10"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setStageFilter("ALL")}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              stageFilter === "ALL"
                ? "border-gold-500/60 bg-gold-500/15 text-gold-300"
                : "border-slate-800 bg-obsidian-950 text-slate-400 hover:text-slate-200"
            }`}
          >
            Hamısı ({stageCounts.ALL ?? 0})
          </button>
          {STAGE_ORDER.map((stage) => (
            <button
              key={stage}
              type="button"
              onClick={() => setStageFilter(stage)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                stageFilter === stage
                  ? "border-gold-500/60 bg-gold-500/15 text-gold-300"
                  : "border-slate-800 bg-obsidian-950 text-slate-400 hover:text-slate-200"
              }`}
            >
              {LEAD_STAGE_META[stage].label} ({stageCounts[stage] ?? 0})
            </button>
          ))}
        </div>
      </div>

      {/* Leads List */}
      {filteredLeads.length === 0 ? (
        <div className="exec-card flex flex-col items-center justify-center py-14 text-center px-6">
          <Users className="h-10 w-10 text-slate-600" />
          <p className="mt-3 text-sm font-medium text-slate-200">
            Bu filtr üzrə müştəri tapılmadı
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Yuxarıdakı düymədən 10 saniyəyə yeni müştəri əlavə edə bilərsiniz.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredLeads.map((lead) => {
            const stageMeta = LEAD_STAGE_META[lead.stage];
            const waUrl = buildWhatsAppUrl(
              lead.phone_normalized,
              `Salam ${lead.client_name}! BakuEstate-AI-dan əlaqə saxlayıram.`
            );
            const soldLinked = lead.lead_listings.filter(
              (ll) => ll.listings && isListingUnavailable(ll.listings)
            );

            return (
              <div key={lead.id} className="exec-card p-5 space-y-4">
                {/* RED ALERT BANNER if any linked listing is OWNER_SOLD or REMOVED_ON_BINA */}
                {soldLinked.length > 0 && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-rose-500/60 bg-rose-600/20 px-4 py-3 text-xs text-rose-100">
                    <div className="flex items-start gap-2.5">
                      <AlertOctagon className="h-4 w-4 shrink-0 mt-0.5 text-rose-300" />
                      <div>
                        <p className="font-bold text-rose-100">
                          DİQQƏT: Bağlı elan satılıb və ya bina.az-dan silinib!
                        </p>
                        <p className="mt-0.5 text-rose-200/90">
                          {soldLinked
                            .map((s) => `#${s.listings?.bina_id}`)
                            .join(", ")}{" "}
                          aktual deyil — müştəriyə dərhal alternativ mənzil
                          təklif edin.
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setLinkingLeadId(lead.id);
                        setAltRelation("PITCHED");
                      }}
                      className="rounded-lg border border-rose-300/40 bg-rose-950/60 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-rose-950 shrink-0"
                    >
                      + Alternativ Təklif Bağla
                    </button>
                  </div>
                )}

                {/* Top Row */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-slate-50">
                        {lead.client_name}
                      </h3>
                      <StatusBadge
                        label={stageMeta.label}
                        tone={stageMeta.tone}
                      />
                      <StatusBadge
                        label={LEAD_SOURCE_LABELS[lead.source_channel]}
                        tone="neutral"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                      {lead.phone_normalized && (
                        <span className="font-mono text-slate-200">
                          {lead.phone_normalized}
                        </span>
                      )}
                      {lead.social_handle && (
                        <span className="text-sky-300">
                          {lead.social_handle}
                        </span>
                      )}
                      {lead.budget_max_azn !== null && (
                        <span>Büdcə: {formatAzn(lead.budget_max_azn)}</span>
                      )}
                      {lead.next_followup_at && (
                        <span className="inline-flex items-center gap-1 text-gold-300">
                          <Calendar className="h-3.5 w-3.5" />
                          Follow-up: {formatBakuDateTime(lead.next_followup_at)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Quick Stage & Action Controls */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <select
                      aria-label="Mərhələ"
                      value={lead.stage}
                      onChange={(e) =>
                        handleQuickStageChange(
                          lead,
                          e.target.value as LeadStage
                        )
                      }
                      className="exec-select py-1.5 text-xs"
                    >
                      {STAGE_ORDER.map((s) => (
                        <option key={s} value={s}>
                          {LEAD_STAGE_META[s].label}
                        </option>
                      ))}
                    </select>

                    {waUrl && (
                      <a
                        href={waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25"
                      >
                        <MessageCircle className="h-3.5 w-3.5" />
                        <span>WA</span>
                      </a>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        const linkedListingId =
                          lead.lead_listings?.[0]?.listings?.bina_id ||
                          lead.lead_listings?.[0]?.listing_id ||
                          undefined;
                        openAgentHub("musteri_psixologiyasi", {
                          leadId: lead.id,
                          listingId: linkedListingId,
                        });
                      }}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-gold-500/40 bg-gold-500/15 hover:bg-gold-500/25 px-3 py-1.5 text-xs font-semibold text-gold-200 transition"
                      title="Müştəri Psixologiyası ilə Danışıq və Komissiya Qalxanını Aç"
                    >
                      <Bot className="h-3.5 w-3.5 text-gold-400" />
                      <span>🤖 Copilot</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => openEditModal(lead)}
                      className="exec-btn-secondary py-1.5 text-xs"
                    >
                      <DollarSign className="h-3.5 w-3.5 text-gold-400" />
                      <span>Nəticə / Komissiya</span>
                    </button>
                  </div>
                </div>

                {/* Commission & Notes Summary */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs border-t border-slate-800/70 pt-3">
                  <span className="text-slate-400">
                    Gözlənilən komissiya:{" "}
                    <strong className="text-gold-300">
                      {formatAzn(lead.expected_commission_azn)}
                    </strong>
                  </span>
                  <span className="text-slate-400">
                    Faktiki komissiya:{" "}
                    <strong className="text-emerald-300">
                      {formatAzn(lead.actual_commission_azn)}
                    </strong>
                  </span>
                  {lead.lost_reason && (
                    <span className="text-rose-300">
                      İtirilmə səbəbi: {lead.lost_reason}
                    </span>
                  )}
                </div>

                {lead.notes && (
                  <p className="text-xs text-slate-300 bg-obsidian-950/70 rounded-xl border border-slate-800/80 px-3.5 py-2.5">
                    {lead.notes}
                  </p>
                )}

                {/* Linked Listings */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                      <Building2 className="h-3.5 w-3.5 text-gold-400" />
                      <span>
                        Bağlı Mənzillər ({lead.lead_listings.length})
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setLinkingLeadId(lead.id);
                        setAltRelation("PITCHED");
                      }}
                      className="inline-flex items-center gap-1 text-xs text-gold-300 hover:underline"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      <span>Elan Bağla</span>
                    </button>
                  </div>

                  {lead.lead_listings.length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {lead.lead_listings.map((ll) => {
                        const l = ll.listings;
                        if (!l) return null;
                        const dead = isListingUnavailable(l);
                        return (
                          <Link
                            key={`${ll.lead_id}-${ll.listing_id}`}
                            href={`/listings/${l.bina_id}`}
                            className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs transition ${
                              dead
                                ? "border-rose-500/50 bg-rose-950/30 hover:border-rose-400"
                                : "border-slate-800 bg-obsidian-950/70 hover:border-gold-500/40"
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-100 truncate">
                                #{l.bina_id} • {l.title || l.location || "Elan"}
                              </p>
                              <p className="text-[11px] text-slate-400">
                                {formatAzn(l.price_azn_normalized)} •{" "}
                                {LEAD_RELATION_LABELS[ll.relation]}
                              </p>
                            </div>
                            <StatusBadge
                              label={
                                l.owner_outreach_status === "OWNER_SOLD"
                                  ? OWNER_OUTREACH_META.OWNER_SOLD.label
                                  : SOURCE_AVAILABILITY_META[
                                      l.source_availability
                                    ].label
                              }
                              tone={dead ? "rose" : "emerald"}
                            />
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 10-Second Quick-Add Lead Modal */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="exec-card w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-50">
                  Sürətli Müştəri Əlavəsi (10 san)
                </h2>
                <p className="text-xs text-slate-400">
                  Müştəri, bağlı elan və follow-up xatırlatması bir addımda
                  yaradılır.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-obsidian-800 hover:text-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleQuickAdd} className="space-y-3.5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Müştəri Adı *
                  </label>
                  <input
                    type="text"
                    required
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="Elvin Məmmədov"
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Telefon və ya @Handle
                  </label>
                  <input
                    type="text"
                    value={phoneOrHandle}
                    onChange={(e) => setPhoneOrHandle(e.target.value)}
                    placeholder="+994501234567 və ya @elvin_baku"
                    className="exec-input text-xs"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    Mənbə Kanalı
                  </label>
                  <select
                    value={sourceChannel}
                    onChange={(e) =>
                      setSourceChannel(e.target.value as LeadSourceChannel)
                    }
                    className="exec-select w-full text-xs"
                  >
                    {Object.entries(LEAD_SOURCE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-300">
                    İlkin Mərhələ
                  </label>
                  <select
                    value={initialStage}
                    onChange={(e) =>
                      setInitialStage(e.target.value as LeadStage)
                    }
                    className="exec-select w-full text-xs"
                  >
                    {STAGE_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {LEAD_STAGE_META[s].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-300">
                  Bağlı Elan (Mənzil)
                </label>
                <select
                  value={linkedListingId}
                  onChange={(e) => setLinkedListingId(e.target.value)}
                  className="exec-select w-full text-xs"
                >
                  <option value="">Elan seçin (opsional)</option>
                  {listingOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      #{opt.bina_id} — {formatAzn(opt.price_azn_normalized)} •{" "}
                      {opt.location || opt.title || "Bakı"}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1 sm:col-span-1">
                  <label className="text-xs font-medium text-slate-300">
                    Maks. Büdcə (AZN)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={budgetMax}
                    onChange={(e) => setBudgetMax(e.target.value)}
                    placeholder="180000"
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1 sm:col-span-1">
                  <label className="text-xs font-medium text-slate-300">
                    Gözl. Komissiya
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={expectedComm}
                    onChange={(e) => setExpectedComm(e.target.value)}
                    placeholder="2500"
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1 sm:col-span-1">
                  <label className="text-xs font-medium text-slate-300">
                    Follow-Up Tarixi
                  </label>
                  <input
                    type="datetime-local"
                    value={nextFollowupLocal}
                    onChange={(e) => setNextFollowupLocal(e.target.value)}
                    className="exec-input text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-300">
                  Qısa Qeyd
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Sabah 14:00 baxış istəyir, kupçalı olmalıdır..."
                  className="exec-input text-xs"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  className="exec-btn-secondary text-xs"
                >
                  Ləğv et
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="exec-btn-primary text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>{submitting ? "Saxlanır..." : "Müştərini Yarat"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Commission & Outcome Edit Modal */}
      {editingLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="exec-card w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-100">
                Nəticə &amp; Komissiya — {editingLead.client_name}
              </h3>
              <button
                type="button"
                onClick={() => setEditingLead(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-obsidian-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-slate-300">Mərhələ</label>
                <select
                  value={editStage}
                  onChange={(e) => setEditStage(e.target.value as LeadStage)}
                  className="exec-select w-full text-xs"
                >
                  {STAGE_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {LEAD_STAGE_META[s].label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-slate-300">
                    Gözlənilən (AZN)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={editExpected}
                    onChange={(e) => setEditExpected(e.target.value)}
                    className="exec-input text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-slate-300">
                    Faktiki (AZN)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={editActual}
                    onChange={(e) => setEditActual(e.target.value)}
                    className="exec-input text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-slate-300">
                  İtirilmə Səbəbi (əgər LOST)
                </label>
                <input
                  type="text"
                  value={editLostReason}
                  onChange={(e) => setEditLostReason(e.target.value)}
                  placeholder="Büdcə çatmadı / başqa ev aldı..."
                  className="exec-input text-xs"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-slate-300">Qeydlər</label>
                <textarea
                  rows={3}
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  className="exec-input text-xs"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingLead(null)}
                  className="exec-btn-secondary text-xs"
                >
                  Bağla
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="exec-btn-primary text-xs"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>Yadda Saxla</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Link Alternative Listing Modal */}
      {linkingLeadId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="exec-card w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-100">
                Mənzil Bağla / Alternativ Təklif
              </h3>
              <button
                type="button"
                onClick={() => setLinkingLeadId(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-obsidian-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleLinkAlternative} className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-slate-300">Elan Seçin *</label>
                <select
                  required
                  value={altListingId}
                  onChange={(e) => setAltListingId(e.target.value)}
                  className="exec-select w-full text-xs"
                >
                  <option value="">Aktiv elan seçin...</option>
                  {listingOptions
                    .filter(
                      (o) =>
                        o.source_availability === "ACTIVE" &&
                        o.owner_outreach_status !== "OWNER_SOLD"
                    )
                    .map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        #{opt.bina_id} — {formatAzn(opt.price_azn_normalized)} •{" "}
                        {opt.location || opt.title || "Bakı"}
                      </option>
                    ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-slate-300">Əlaqə Növü</label>
                <select
                  value={altRelation}
                  onChange={(e) =>
                    setAltRelation(e.target.value as LeadListingRelation)
                  }
                  className="exec-select w-full text-xs"
                >
                  {Object.entries(LEAD_RELATION_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setLinkingLeadId(null)}
                  className="exec-btn-secondary text-xs"
                >
                  Ləğv et
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="exec-btn-primary text-xs"
                >
                  Bağla
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
