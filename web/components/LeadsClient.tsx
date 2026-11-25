"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  AlertOctagon,
  Bot,
  Building2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Download,
  Link2,
  MessageCircle,
  Plus,
  Save,
  Search,
  Sparkles,
  UserCheck,
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
  AgencyMember,
  AgencyRole,
  BuyerLeadWithListings,
  LeadListingJoin,
  LeadListingRelation,
  LeadSourceChannel,
  LeadStage,
  Listing,
  PaginatedResult,
} from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

export interface ListingPickerOption {
  id: string;
  bina_id: string | null;
  title: string | null;
  location: string | null;
  price_azn_normalized: number;
  source_availability: string;
  owner_outreach_status: string;
  rooms: number | null;
  area: number | null;
}

export interface AgencyCrmKpis {
  ok?: boolean;
  agency_id?: string;
  role_scope?: string;
  broker_split_pct?: number;
  total_leads: number;
  active_leads?: number;
  won_leads?: number;
  lost_leads?: number;
  overdue_followups?: number;
  open_tasks?: number;
  stage_counts?: Partial<Record<LeadStage, number>>;
  expected_commission_total_azn: number;
  expected_broker_commission_azn: number;
  expected_agency_commission_azn: number;
  actual_commission_total_azn: number;
  actual_broker_commission_azn: number;
  actual_agency_commission_azn: number;
  by_broker?: Array<{
    user_id: string;
    display_name: string;
    commission_split_pct: number;
    lead_count: number;
    won_count: number;
    expected_total_azn: number;
    expected_broker_azn: number;
    expected_agency_azn: number;
    actual_total_azn: number;
    actual_broker_azn: number;
    actual_agency_azn: number;
  }>;
  generated_at?: string;
}

export interface LeadsFilterState {
  search?: string;
  stage?: string;
  agent?: string;
}

export interface LeadListingMatchItem {
  id: string;
  lead_id?: string;
  listing_id: string;
  match_score: number;
  status: "NEW" | "NOTIFIED" | "DISMISSED" | string;
  notified_at?: string | null;
  created_at?: string;
  listings?: Pick<
    Listing,
    | "id"
    | "bina_id"
    | "title"
    | "location"
    | "price_azn_normalized"
    | "rooms"
    | "area"
    | "has_bill_of_sale"
    | "source_availability"
  > | null;
}

type LeadWithAgent = BuyerLeadWithListings & {
  assigned_agent_id?: string | null;
  lead_listing_matches?: LeadListingMatchItem[];
};

interface LeadsClientProps {
  initialLeads: BuyerLeadWithListings[];
  listingOptions: ListingPickerOption[];
  pagination?: PaginatedResult<BuyerLeadWithListings>;
  kpis?: AgencyCrmKpis | null;
  agencyMembers?: AgencyMember[];
  memberRole?: AgencyRole;
  initialFilters?: LeadsFilterState;
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

function defaultExportRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().slice(0, 10);
  return { from, to };
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
  pagination,
  kpis = null,
  agencyMembers = [],
  memberRole = "BROKER",
  initialFilters,
}: LeadsClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { openAgentHub } = useCopilot();

  const [leads, setLeads] = useState<LeadWithAgent[]>(
    initialLeads as LeadWithAgent[]
  );

  useEffect(() => {
    setLeads(initialLeads as LeadWithAgent[]);
  }, [initialLeads]);

  useEffect(() => {
    if (!initialLeads || initialLeads.length === 0) return;
    const missingMatchLeads = (initialLeads as LeadWithAgent[]).filter(
      (l) => !Array.isArray(l.lead_listing_matches)
    );
    if (missingMatchLeads.length === 0) return;

    let cancelled = false;
    async function loadMatchesForPage() {
      try {
        const supabase = createClient();
        const tableApi = supabase.from?.("lead_listing_matches");
        if (!tableApi || typeof tableApi.select !== "function") return;

        const leadIds = missingMatchLeads.map((l) => l.id).slice(0, 24);
        const query = tableApi
          .select(
            "id, lead_id, listing_id, match_score, status, notified_at, created_at, listings(id, bina_id, title, location, price_azn_normalized, rooms, area, has_bill_of_sale, source_availability)"
          )
          .in("lead_id", leadIds)
          .neq("status", "DISMISSED")
          .order("match_score", { ascending: false })
          .limit(120);

        const res = await query;
        if (cancelled || !res?.data || !Array.isArray(res.data)) return;

        const byLead = new Map<string, LeadListingMatchItem[]>();
        for (const row of res.data as LeadListingMatchItem[]) {
          const lid = row.lead_id;
          if (!lid) continue;
          const bucket = byLead.get(lid) ?? [];
          bucket.push(row);
          byLead.set(lid, bucket);
        }

        setLeads((prev) =>
          prev.map((lead) => {
            if (Array.isArray(lead.lead_listing_matches)) return lead;
            return {
              ...lead,
              lead_listing_matches: byLead.get(lead.id) ?? [],
            };
          })
        );
      } catch {
        // Non-fatal: SSR or tests may omit lead_listing_matches table
      }
    }

    loadMatchesForPage();
    return () => {
      cancelled = true;
    };
  }, [initialLeads]);

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

  const [stageFilter, setStageFilter] = useState<LeadStage | "ALL">(
    (initialFilters?.stage as LeadStage | "ALL") || "ALL"
  );
  const [search, setSearch] = useState(initialFilters?.search ?? "");
  const [agentFilter, setAgentFilter] = useState(
    initialFilters?.agent ?? "ALL"
  );
  const [exportingCsv, setExportingCsv] = useState(false);
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
  const [editingLead, setEditingLead] = useState<LeadWithAgent | null>(null);
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

  const isServerPaginated = Boolean(pagination);
  const currentPage = pagination?.page ?? 1;
  const pageSize = pagination?.pageSize ?? 24;
  const totalCount = pagination?.totalCount ?? kpis?.total_leads ?? leads.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasNextPage = pagination?.hasNextPage ?? false;

  const assignableBrokers = useMemo(
    () =>
      agencyMembers.filter(
        (m) => m.is_active && (m.role === "BROKER" || m.role === "ADMIN")
      ),
    [agencyMembers]
  );

  function navigateWithParams(
    updates: Record<string, string | null>,
    resetPage: boolean
  ) {
    const next = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : ""
    );
    for (const [k, v] of Object.entries(updates)) {
      if (!v || v === "ALL") {
        next.delete(k);
      } else {
        next.set(k, v);
      }
    }
    if (resetPage) {
      next.set("page", "1");
    }
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const stageCounts = useMemo(() => {
    if (kpis?.stage_counts) {
      const map: Record<string, number> = { ALL: kpis.total_leads };
      for (const s of STAGE_ORDER) {
        map[s] = Number(kpis.stage_counts[s] ?? 0);
      }
      return map;
    }
    const map: Record<string, number> = { ALL: leads.length };
    for (const s of STAGE_ORDER) map[s] = 0;
    for (const l of leads) {
      map[l.stage] = (map[l.stage] ?? 0) + 1;
    }
    return map;
  }, [kpis, leads]);

  const commissionTotals = useMemo(() => {
    if (kpis) {
      return {
        totalLeads: kpis.total_leads,
        expected: kpis.expected_commission_total_azn,
        actual: kpis.actual_commission_total_azn,
        actualBroker: kpis.actual_broker_commission_azn,
        actualAgency: kpis.actual_agency_commission_azn,
        expectedBroker: kpis.expected_broker_commission_azn,
        expectedAgency: kpis.expected_agency_commission_azn,
      };
    }

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
    return {
      totalLeads: leads.length,
      expected,
      actual,
      actualBroker: null as number | null,
      actualAgency: null as number | null,
      expectedBroker: null as number | null,
      expectedAgency: null as number | null,
    };
  }, [kpis, leads]);

  const filteredLeads = useMemo(() => {
    if (isServerPaginated) return leads;

    const q = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (stageFilter !== "ALL" && lead.stage !== stageFilter) return false;
      if (agentFilter !== "ALL" && lead.assigned_agent_id !== agentFilter)
        return false;
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
  }, [isServerPaginated, leads, stageFilter, agentFilter, search]);

  async function handleExportCommissionsCsv() {
    setExportingCsv(true);
    setFeedback(null);
    try {
      const { from, to } = defaultExportRange();
      const headers: Record<string, string> = {};
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

      const res = await fetch(
        `/api/export/commissions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        {
          method: "GET",
          headers,
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          errData?.error || `CSV ixrac xətası (HTTP ${res.status})`
        );
      }

      const blob = await res.blob();
      if (typeof window !== "undefined" && typeof URL.createObjectURL === "function") {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `bakuestate-commissions-${from}-${to}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }

      setFeedback({
        type: "ok",
        text: `Komissiya hesabatı (${from} – ${to}) CSV formatında yükləndi.`,
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: err instanceof Error ? err.message : "CSV ixrac xətası",
      });
    } finally {
      setExportingCsv(false);
    }
  }

  async function handleAssignBroker(lead: LeadWithAgent, nextAgentId: string) {
    const supabase = createClient();
    const assignedValue = nextAgentId || null;
    const { error } = await supabase
      .from("buyer_leads")
      .update({ assigned_agent_id: assignedValue })
      .eq("id", lead.id);

    if (error) {
      setFeedback({
        type: "err",
        text: `Broker təhkimi xətası: ${error.message}`,
      });
      return;
    }

    setLeads((prev) =>
      prev.map((l) =>
        l.id === lead.id ? { ...l, assigned_agent_id: assignedValue } : l
      )
    );
    setFeedback({
      type: "ok",
      text: `${lead.client_name} üçün məsul broker yeniləndi.`,
    });
  }

  async function handleQuickAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!clientName.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    const supabase = createClient();

    try {
      const contactTrim = phoneOrHandle.trim();
      const isHandle =
        contactTrim.startsWith("@") || /[a-zA-Z]/.test(contactTrim);
      const phoneNormalized =
        contactTrim && !isHandle ? normalizePhoneInput(contactTrim) : null;
      const socialHandle = contactTrim && isHandle ? contactTrim : null;
      const followupIso = bakuLocalInputToIso(nextFollowupLocal);

      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        "create_buyer_lead_atomic",
        {
          p_client_name: clientName.trim(),
          p_phone_normalized: phoneNormalized,
          p_social_handle: socialHandle,
          p_source_channel: sourceChannel,
          p_stage: initialStage,
          p_budget_max_azn: budgetMax.trim() ? Number(budgetMax) : null,
          p_expected_commission_azn: expectedComm.trim()
            ? Number(expectedComm)
            : null,
          p_notes: notes.trim() || null,
          p_next_followup_at: followupIso,
          p_listing_id: linkedListingId || null,
          p_relation: "INQUIRED",
          p_task_title: followupIso
            ? `Müştəri follow-up: ${clientName.trim()} (${LEAD_STAGE_META[initialStage].label})`
            : null,
          p_task_priority:
            initialStage === "VIEWING_SCHEDULED" || initialStage === "DEPOSIT"
              ? "HIGH"
              : "NORMAL",
        }
      );

      if (rpcErr) throw rpcErr;

      if (
        rpcResult &&
        typeof rpcResult === "object" &&
        "ok" in rpcResult &&
        (rpcResult as { ok?: boolean }).ok === false
      ) {
        throw new Error(
          (rpcResult as { error?: string }).error || "Müştəri yaradıla bilmədi."
        );
      }

      const createdLead =
        rpcResult && typeof rpcResult === "object" && "lead" in rpcResult
          ? (rpcResult as { lead: BuyerLeadWithListings }).lead
          : (rpcResult as BuyerLeadWithListings | null);

      if (!createdLead || !createdLead.id) {
        throw new Error("Müştəri yaradılarkən cavab alınmadı.");
      }

      let linkedJoin: LeadListingJoin[] = [];
      if (linkedListingId) {
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
                bina_id: opt.bina_id || "",
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

      const fullLead: LeadWithAgent = {
        ...(createdLead as LeadWithAgent),
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

  async function handleQuickStageChange(
    lead: LeadWithAgent,
    nextStage: LeadStage
  ) {
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

  function openEditModal(lead: LeadWithAgent) {
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
            bina_id: opt.bina_id || "",
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

  async function handlePitchMatch(
    leadId: string,
    match: LeadListingMatchItem
  ) {
    const supabase = createClient();
    try {
      const { error } = await supabase.from("lead_listings").upsert({
        lead_id: leadId,
        listing_id: match.listing_id,
        relation: "PITCHED",
      });
      if (error) throw error;

      const opt = listingOptions.find((o) => o.id === match.listing_id);
      const listingInfo = match.listings ?? (opt
        ? {
            id: opt.id,
            bina_id: opt.bina_id || "",
            title: opt.title,
            location: opt.location,
            price_azn_normalized: opt.price_azn_normalized,
            source_availability: opt.source_availability as NonNullable<
              LeadListingJoin["listings"]
            >["source_availability"],
            owner_outreach_status: opt.owner_outreach_status as NonNullable<
              LeadListingJoin["listings"]
            >["owner_outreach_status"],
            editorial_status: "PENDING_REVIEW" as const,
            rooms: opt.rooms,
            area: opt.area,
          }
        : undefined);

      setLeads((prev) =>
        prev.map((l) => {
          if (l.id !== leadId) return l;
          const alreadyLinked = l.lead_listings.some(
            (ll) => ll.listing_id === match.listing_id
          );
          const nextLinked: LeadListingJoin[] = alreadyLinked
            ? l.lead_listings
            : [
                {
                  lead_id: leadId,
                  listing_id: match.listing_id,
                  relation: "PITCHED",
                  notes: null,
                  updated_at: new Date().toISOString(),
                  listings: listingInfo
                    ? {
                        id: listingInfo.id,
                        bina_id: listingInfo.bina_id || "",
                        title: listingInfo.title,
                        location: listingInfo.location,
                        price_azn_normalized: listingInfo.price_azn_normalized,
                        source_availability:
                          listingInfo.source_availability || "ACTIVE",
                        owner_outreach_status:
                          "owner_outreach_status" in listingInfo
                            ? listingInfo.owner_outreach_status
                            : "NOT_CONTACTED",
                        editorial_status:
                          "editorial_status" in listingInfo
                            ? listingInfo.editorial_status
                            : "APPROVED",
                        rooms: listingInfo.rooms,
                        area: listingInfo.area,
                      }
                    : null,
                },
                ...l.lead_listings,
              ];
          return { ...l, lead_listings: nextLinked };
        })
      );
      setFeedback({
        type: "ok",
        text: "Uyğun mənzil müştəriyə təklif olunan elanlara əlavə edildi.",
      });
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Təklif bağlama xətası: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
    }
  }

  async function handleDismissMatch(leadId: string, matchId: string) {
    const supabase = createClient();
    try {
      const { error } = await supabase
        .from("lead_listing_matches")
        .update({ status: "DISMISSED" })
        .eq("id", matchId);
      if (error) throw error;

      setLeads((prev) =>
        prev.map((l) =>
          l.id !== leadId
            ? l
            : {
                ...l,
                lead_listing_matches: (l.lead_listing_matches ?? []).filter(
                  (m) => m.id !== matchId
                ),
              }
        )
      );
    } catch (err) {
      setFeedback({
        type: "err",
        text: `Uyğunluq gizlədilə bilmədi: ${err instanceof Error ? err.message : "Naməlum xəta"}`,
      });
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

        <div className="flex flex-wrap items-center gap-2">
          {memberRole !== "SMM" && (
            <button
              type="button"
              disabled={exportingCsv}
              onClick={handleExportCommissionsCsv}
              className="exec-btn-secondary text-xs"
            >
              <Download className="h-3.5 w-3.5 text-gold-400" />
              <span>
                {exportingCsv ? "Yüklənir..." : "Komissiya CSV İxrac"}
              </span>
            </button>
          )}

          {memberRole !== "SMM" && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="exec-btn-primary"
            >
              <UserPlus className="h-4 w-4" />
              <span>10-San Müştəri Əlavə Et</span>
            </button>
          )}
        </div>
      </div>

      {/* Commission KPI Strip (SQL get_agency_crm_kpis) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Ümumi Müştəri</p>
          <p className="mt-1.5 text-2xl font-bold text-slate-50">
            {commissionTotals.totalLeads}
          </p>
          {kpis && (
            <p className="mt-1 text-[11px] text-slate-400">
              {kpis.active_leads ?? 0} aktiv • {kpis.won_leads ?? 0} bağlı
            </p>
          )}
        </div>
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Gözlənilən Komissiya (Aktiv)</p>
          <p className="mt-1.5 text-2xl font-bold text-gold-300">
            {formatAzn(commissionTotals.expected)}
          </p>
          {commissionTotals.expectedBroker !== null && (
            <p className="mt-1 text-[11px] text-slate-400">
              Broker: {formatAzn(commissionTotals.expectedBroker)} • Agentlik:{" "}
              {formatAzn(commissionTotals.expectedAgency)}
            </p>
          )}
        </div>
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">
            Qazanılmış Komissiya (Bağlı)
          </p>
          <p className="mt-1.5 text-2xl font-bold text-emerald-300">
            {formatAzn(commissionTotals.actual)}
          </p>
          {commissionTotals.actualBroker !== null && (
            <p className="mt-1 text-[11px] text-slate-400">
              Broker: {formatAzn(commissionTotals.actualBroker)} • Agentlik:{" "}
              {formatAzn(commissionTotals.actualAgency)}
            </p>
          )}
        </div>
        <div className="exec-card p-4">
          <p className="text-xs text-slate-400">Gecikmiş / Açıq Follow-Up</p>
          <p className="mt-1.5 text-2xl font-bold text-amber-300">
            {kpis ? kpis.overdue_followups ?? 0 : 0}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            {kpis ? `${kpis.open_tasks ?? 0} açıq tapşırıq` : "SQL KPI"}
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

      {/* Stage Funnel Filter Strip + Search + Broker Filter */}
      <div className="exec-card p-4 space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (isServerPaginated) {
              navigateWithParams({ search: search.trim() || null }, true);
            }
          }}
          className="flex flex-col gap-2.5 sm:flex-row sm:items-center"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Müştəri adı, telefon, @handle və ya bağlı bina_id axtar..."
              className="exec-input pl-10"
            />
          </div>

          {assignableBrokers.length > 0 && memberRole === "ADMIN" && (
            <select
              aria-label="Broker filtri"
              value={agentFilter}
              onChange={(e) => {
                const nextAgent = e.target.value;
                setAgentFilter(nextAgent);
                if (isServerPaginated) {
                  navigateWithParams({ agent: nextAgent }, true);
                }
              }}
              className="exec-select text-xs min-w-[180px]"
            >
              <option value="ALL">Bütün Brokerlər</option>
              {assignableBrokers.map((b) => (
                <option key={b.user_id} value={b.user_id}>
                  {b.display_name} ({b.commission_split_pct}%)
                </option>
              ))}
            </select>
          )}

          {isServerPaginated && (
            <button type="submit" className="exec-btn-secondary text-xs py-2">
              Axtar
            </button>
          )}
        </form>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => {
              setStageFilter("ALL");
              if (isServerPaginated) navigateWithParams({ stage: null }, true);
            }}
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
              onClick={() => {
                setStageFilter(stage);
                if (isServerPaginated)
                  navigateWithParams({ stage }, true);
              }}
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
            const activeMatches = (lead.lead_listing_matches ?? [])
              .filter((m) => m.status !== "DISMISSED")
              .slice()
              .sort((a, b) => b.match_score - a.match_score)
              .slice(0, 3);

            return (
              <div key={lead.id} className="exec-card p-5 space-y-4">
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
                            .map((s) =>
                              s.listings?.bina_id
                                ? `#${s.listings.bina_id}`
                                : "OFF-MARKET"
                            )
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

                  {/* Quick Stage, Broker Assignment & Action Controls */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {assignableBrokers.length > 0 && memberRole === "ADMIN" && (
                      <div className="inline-flex items-center gap-1">
                        <UserCheck className="h-3.5 w-3.5 text-gold-400" />
                        <select
                          aria-label={`Məsul Broker — ${lead.client_name}`}
                          value={lead.assigned_agent_id ?? ""}
                          onChange={(e) =>
                            handleAssignBroker(lead, e.target.value)
                          }
                          className="exec-select py-1.5 text-xs"
                        >
                          <option value="">Təhkim edilməyib</option>
                          {assignableBrokers.map((b) => (
                            <option key={b.user_id} value={b.user_id}>
                              {b.display_name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

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
                        const slug = l.bina_id || l.id;
                        return (
                          <Link
                            key={`${ll.lead_id}-${ll.listing_id}`}
                            href={`/listings/${slug}`}
                            className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs transition ${
                              dead
                                ? "border-rose-500/50 bg-rose-950/30 hover:border-rose-400"
                                : "border-slate-800 bg-obsidian-950/70 hover:border-gold-500/40"
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-100 truncate">
                                {l.bina_id ? `#${l.bina_id}` : "OFF-MARKET"} •{" "}
                                {l.title || l.location || "Elan"}
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

                {/* Smart Property Recommendations (lead_listing_matches) */}
                {activeMatches.length > 0 && (
                  <div className="space-y-2 border-t border-slate-800/70 pt-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-gold-300">
                        <Sparkles className="h-3.5 w-3.5 text-gold-400" />
                        <span>
                          Ağıllı Uyğunluq Tövsiyələri ({activeMatches.length})
                        </span>
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {activeMatches.map((match) => {
                        const opt = listingOptions.find(
                          (o) => o.id === match.listing_id
                        );
                        const ml = match.listings ?? opt ?? null;
                        const slug = ml?.bina_id || match.listing_id;
                        const alreadyLinked = lead.lead_listings.some(
                          (ll) => ll.listing_id === match.listing_id
                        );
                        return (
                          <div
                            key={match.id}
                            className="flex flex-col justify-between gap-2 rounded-xl border border-gold-500/30 bg-gold-500/5 px-3 py-2.5 text-xs"
                          >
                            <div className="space-y-1">
                              <div className="flex items-center justify-between gap-1.5">
                                <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                                  {match.match_score}% uyğun
                                </span>
                                <span className="text-[10px] text-slate-400">
                                  {match.status === "NOTIFIED"
                                    ? "Bildirilib"
                                    : "Yeni"}
                                </span>
                              </div>
                              <Link
                                href={`/listings/${slug}`}
                                className="block font-semibold text-slate-100 hover:text-gold-300 truncate"
                              >
                                {ml?.bina_id ? `#${ml.bina_id}` : "OFF-MARKET"}{" "}
                                • {ml?.title || ml?.location || "Elan"}
                              </Link>
                              {ml && (
                                <p className="text-[11px] text-slate-400">
                                  {formatAzn(ml.price_azn_normalized)} •{" "}
                                  {ml.rooms ?? "?"} otaq • {ml.area ?? "?"} m²
                                </p>
                              )}
                            </div>
                            <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-800/60">
                              {!alreadyLinked && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handlePitchMatch(lead.id, match)
                                  }
                                  className="text-[11px] font-semibold text-gold-300 hover:underline"
                                >
                                  + Təklif Et
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  handleDismissMatch(lead.id, match.id)
                                }
                                className="text-[11px] text-slate-400 hover:text-rose-300"
                              >
                                Gizlət
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
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
            • Cəmi {`${totalCount} müştəri`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() =>
                navigateWithParams(
                  { page: String(Math.max(1, currentPage - 1)) },
                  false
                )
              }
              className="exec-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Əvvəlki</span>
            </button>
            <button
              type="button"
              disabled={!hasNextPage && currentPage >= totalPages}
              onClick={() =>
                navigateWithParams(
                  { page: String(Math.min(totalPages, currentPage + 1)) },
                  false
                )
              }
              className="exec-btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
            >
              <span>Növbəti</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
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
                      {opt.bina_id ? `#${opt.bina_id}` : "OFF-MARKET"} —{" "}
                      {formatAzn(opt.price_azn_normalized)} •{" "}
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
                        {opt.bina_id ? `#${opt.bina_id}` : "OFF-MARKET"} —{" "}
                        {formatAzn(opt.price_azn_normalized)} •{" "}
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
