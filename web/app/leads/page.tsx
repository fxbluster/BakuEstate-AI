import { createClient, getServerSessionMember } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  LeadsClient,
  type AgencyCrmKpis,
  type LeadsFilterState,
  type ListingPickerOption,
} from "@/components/LeadsClient";
import { escapePostgrestSearch } from "@/components/ListingsClient";
import type {
  AgencyMember,
  BuyerLeadWithListings,
  PaginatedResult,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 24;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    page?: string;
    pageSize?: string;
    search?: string;
    stage?: string;
    agent?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(
      1,
      Number.parseInt(params.pageSize ?? String(DEFAULT_PAGE_SIZE), 10) ||
        DEFAULT_PAGE_SIZE
    )
  );
  const search = (params.search ?? "").trim();
  const stage = (params.stage ?? "ALL").toUpperCase();
  const agent = (params.agent ?? "ALL").trim();

  const initialFilters: LeadsFilterState = {
    search,
    stage,
    agent,
  };

  if (!isSupabaseConfigured()) {
    return (
      <LeadsClient
        initialLeads={[]}
        listingOptions={[]}
        pagination={{
          items: [],
          totalCount: 0,
          page: 1,
          pageSize,
          hasNextPage: false,
        }}
        initialFilters={initialFilters}
      />
    );
  }

  const [supabase, member] = await Promise.all([
    createClient(),
    getServerSessionMember(),
  ]);

  let leadsQuery = supabase
    .from("buyer_leads")
    .select(
      "*, lead_listings(lead_id, listing_id, relation, notes, updated_at, listings(id, bina_id, title, location, price_azn_normalized, source_availability, owner_outreach_status, editorial_status, rooms, area))",
      { count: "exact" }
    )
    .order("updated_at", { ascending: false });

  if (member?.agency_id) {
    leadsQuery = leadsQuery.eq("agency_id", member.agency_id);
  }

  if (stage !== "ALL") {
    leadsQuery = leadsQuery.eq("stage", stage);
  }

  if (agent && agent !== "ALL") {
    leadsQuery = leadsQuery.eq("assigned_agent_id", agent);
  }

  if (search) {
    const escaped = escapePostgrestSearch(search);
    if (escaped) {
      leadsQuery = leadsQuery.or(
        `client_name.ilike.%${escaped}%,phone_normalized.ilike.%${escaped}%,social_handle.ilike.%${escaped}%`
      );
    }
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const [leadsRes, kpisRes, listingsRes, membersRes] = await Promise.all([
    leadsQuery.range(from, to),
    member?.role !== "SMM"
      ? supabase.rpc("get_agency_crm_kpis")
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("listings")
      .select(
        "id, bina_id, title, location, price_azn_normalized, source_availability, owner_outreach_status, rooms, area"
      )
      .order("last_seen_at", { ascending: false })
      .limit(100),
    member?.agency_id
      ? supabase
          .from("agency_members")
          .select(
            "user_id, agency_id, role, display_name, whatsapp_phone, telegram_chat_id, commission_split_pct, is_active, created_at"
          )
          .eq("agency_id", member.agency_id)
          .eq("is_active", true)
          .order("display_name", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);

  const pageLeads = (leadsRes.data as BuyerLeadWithListings[] | null) ?? [];
  const totalCount = leadsRes.count ?? pageLeads.length;

  const rawKpis = kpisRes?.data as (AgencyCrmKpis & { ok?: boolean }) | null;
  const kpis = rawKpis && rawKpis.ok !== false ? rawKpis : null;

  const pagination: PaginatedResult<BuyerLeadWithListings> = {
    items: pageLeads,
    totalCount,
    page,
    pageSize,
    hasNextPage: from + pageLeads.length < totalCount,
  };

  return (
    <LeadsClient
      initialLeads={pageLeads}
      listingOptions={(listingsRes.data as ListingPickerOption[] | null) ?? []}
      pagination={pagination}
      kpis={kpis}
      agencyMembers={(membersRes.data as AgencyMember[] | null) ?? []}
      memberRole={member?.role ?? "BROKER"}
      initialFilters={initialFilters}
    />
  );
}
