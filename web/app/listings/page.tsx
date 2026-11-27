import { createClient, getServerSessionMember } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  ListingsClient,
  escapePostgrestSearch,
  type ListingWithLatestRender,
  type ListingsFilterState,
} from "@/components/ListingsClient";
import type {
  ChannelNiche,
  Listing,
  PaginatedResult,
  Publication,
  RenderStatus,
  SocialChannelProfile,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 24;

export default async function ListingsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    page?: string;
    pageSize?: string;
    search?: string;
    niche?: string;
    editorial?: string;
    availability?: string;
    archetype?: string;
    kupca?: string;
    duplicate?: string;
    tab?: string;
    sort?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(params.pageSize ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  );
  const search = (params.search ?? "").trim();
  const niche = (params.niche ?? "ALL").toUpperCase();
  const editorial = (params.editorial ?? "ALL").toUpperCase();
  const availability = (params.availability ?? "ALL").toUpperCase();
  const archetype = (params.archetype ?? "ALL").toLowerCase();
  const kupca = (params.kupca ?? "ALL").toUpperCase();
  const duplicate = (params.duplicate ?? "ALL").toUpperCase();
  const tab = (params.tab ?? "ALL").toUpperCase();
  const sort = (params.sort ?? "DEFAULT").toUpperCase();

  const initialFilters: ListingsFilterState = {
    search,
    niche,
    editorial,
    availability,
    archetype: archetype === "all" ? "ALL" : archetype,
    kupca,
    duplicate,
    tab,
    sort,
  };

  if (!isSupabaseConfigured()) {
    return (
      <ListingsClient
        initialListings={[]}
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

  let summaryQuery = supabase
    .from("listings")
    .select("id, canonical_niche, pipeline_status, editorial_status");
  if (member?.agency_id) {
    summaryQuery = summaryQuery.eq("agency_id", member.agency_id);
  }

  let completedRendersQuery = supabase
    .from("render_versions")
    .select("listing_id, video_cdn_url, storage_object_path, storage_pruned_at")
    .eq("status", "COMPLETED");
  if (member?.agency_id) {
    completedRendersQuery = completedRendersQuery.eq("agency_id", member.agency_id);
  }

  let activeJobsQuery = supabase
    .from("pipeline_jobs")
    .select("listing_id, status")
    .in("status", ["QUEUED", "RUNNING"]);
  if (member?.agency_id) {
    activeJobsQuery = activeJobsQuery.eq("agency_id", member.agency_id);
  }

  let publishedPubsQuery = supabase
    .from("publications")
    .select("listing_id")
    .eq("status", "PUBLISHED");
  if (member?.agency_id) {
    publishedPubsQuery = publishedPubsQuery.eq("agency_id", member.agency_id);
  }

  const [summaryRes, completedRendersRes, activeJobsRes, publishedPubsRes, settingsRes] = await Promise.all([
    summaryQuery,
    completedRendersQuery,
    activeJobsQuery,
    publishedPubsQuery,
    member?.agency_id
      ? supabase
          .from("agency_settings")
          .select("niche_rules_json")
          .eq("agency_id", member.agency_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const summaryRows =
    (summaryRes.data as Array<{
      id: string;
      canonical_niche?: string | null;
      pipeline_status?: string | null;
      editorial_status?: string | null;
    }> | null) ?? [];

  const activeJobStatusByListing = new Map<string, "QUEUED" | "RUNNING">();
  for (const job of (activeJobsRes.data as Array<{ listing_id: string | null; status: string }> | null) ?? []) {
    if (!job.listing_id) continue;
    const prev = activeJobStatusByListing.get(job.listing_id);
    if (job.status === "RUNNING" || !prev) {
      activeJobStatusByListing.set(
        job.listing_id,
        job.status === "RUNNING" ? "RUNNING" : "QUEUED"
      );
    }
  }

  const completedListingIdSet = new Set(
    ((completedRendersRes.data as Array<{
      listing_id: string;
      video_cdn_url?: string | null;
      storage_object_path?: string | null;
      storage_pruned_at?: string | null;
    }> | null) ?? [])
      .filter(
        (r) =>
          !r.storage_pruned_at &&
          (Boolean(r.video_cdn_url) || Boolean(r.storage_object_path))
      )
      .map((r) => r.listing_id)
  );

  const publishedListingIdSet = new Set(
    ((publishedPubsRes.data as Array<{ listing_id: string }> | null) ?? []).map(
      (p) => p.listing_id
    )
  );

  const publishedListingIds = summaryRows
    .filter((r) => publishedListingIdSet.has(r.id))
    .map((r) => r.id);

  const draftListingIds = summaryRows
    .filter(
      (r) =>
        completedListingIdSet.has(r.id) &&
        !publishedListingIdSet.has(r.id) &&
        !activeJobStatusByListing.has(r.id)
    )
    .map((r) => r.id);

  const noVideoListingIds = summaryRows
    .filter(
      (r) =>
        !publishedListingIdSet.has(r.id) &&
        (!completedListingIdSet.has(r.id) || activeJobStatusByListing.has(r.id))
    )
    .map((r) => r.id);

  const serverTabCounts = {
    all: summaryRows.length,
    noVideo: noVideoListingIds.length,
    drafts: draftListingIds.length,
    published: publishedListingIds.length,
  };

  const serverNicheCounts = {
    all: summaryRows.length,
    luxury: summaryRows.filter((r) => r.canonical_niche === "LUXURY").length,
    affordable: summaryRows.filter((r) => r.canonical_niche === "AFFORDABLE").length,
    general: summaryRows.filter((r) => r.canonical_niche === "GENERAL").length,
    tiktok: summaryRows.filter((r) => r.canonical_niche === "TIKTOK").length,
  };

  const rawChannels = (
    settingsRes.data?.niche_rules_json as
      | { channels?: Partial<Record<ChannelNiche, SocialChannelProfile>> }
      | null
      | undefined
  )?.channels;
  const channelProfiles: Partial<Record<ChannelNiche, SocialChannelProfile>> =
    rawChannels && typeof rawChannels === "object" ? rawChannels : {};

  let query = supabase.from("listings").select("*", { count: "exact" });

  if (member?.agency_id) {
    query = query.eq("agency_id", member.agency_id);
  }

  if (tab === "PUBLISHED") {
    if (publishedListingIds.length > 0) {
      query = query.in("id", publishedListingIds);
    }
  } else if (tab === "DRAFTS") {
    if (draftListingIds.length > 0) {
      query = query.in("id", draftListingIds);
    }
  } else if (tab === "NO_VIDEO") {
    if (noVideoListingIds.length > 0) {
      const excludeIds = Array.from(
        new Set([...completedListingIdSet, ...publishedListingIdSet])
      );
      if (excludeIds.length === 0) {
        // All listings have no video and are not published
      } else if (noVideoListingIds.length <= excludeIds.length) {
        query = query.in("id", noVideoListingIds);
      } else {
        query = query.not("id", "in", `(${excludeIds.join(",")})`);
      }
    }
  }

  if (["LUXURY", "AFFORDABLE", "GENERAL", "TIKTOK"].includes(niche)) {
    query = query.eq("canonical_niche", niche);
  }

  if (editorial !== "ALL") {
    query = query.eq("editorial_status", editorial);
  }

  if (availability !== "ALL") {
    query = query.eq("source_availability", availability);
  }

  if (["budget", "luxury", "villa", "commercial"].includes(archetype)) {
    query = query.eq("archetype", archetype);
  }

  if (kupca === "YES") {
    query = query.eq("has_bill_of_sale", true);
  } else if (kupca === "NO") {
    query = query.eq("has_bill_of_sale", false);
  }

  if (duplicate === "PENDING_REVIEW" || duplicate === "CONFIRMED_DUPLICATE") {
    query = query.eq("duplicate_resolution", duplicate);
  } else if (duplicate === "CLEAN") {
    query = query.in("duplicate_resolution", ["NONE", "FALSE_POSITIVE"]);
  }

  if (search) {
    const escaped = escapePostgrestSearch(search);
    if (escaped) {
      query = query.or(
        `bina_id.ilike.%${escaped}%,title.ilike.%${escaped}%,address.ilike.%${escaped}%,location.ilike.%${escaped}%,district_normalized.ilike.%${escaped}%`
      );
    }
  }

  if (sort === "PRICE_DESC") {
    query = query.order("price_azn_normalized", { ascending: false });
  } else if (sort === "PRICE_ASC") {
    query = query.order("price_azn_normalized", { ascending: true });
  } else {
    query = query.order("created_at", { ascending: false });
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const listingsRes =
    (tab === "PUBLISHED" && publishedListingIds.length === 0) ||
    (tab === "DRAFTS" && draftListingIds.length === 0) ||
    (tab === "NO_VIDEO" && noVideoListingIds.length === 0)
      ? { data: [] as Listing[], count: 0 }
      : await query.range(from, to);

  const pageListings = (listingsRes.data as Listing[] | null) ?? [];
  const totalCount = listingsRes.count ?? pageListings.length;
  const pageIds = pageListings.map((l) => l.id);

  const latestByListing = new Map<
    string,
    {
      id?: string;
      version_num: number;
      status: RenderStatus;
      video_cdn_url: string | null;
      hook_type?: string | null;
      duration_bucket?: string | null;
      created_at?: string | null;
      completed_at?: string | null;
    }
  >();
  const latestPubByListing = new Map<string, Publication>();
  const ownerContactByListing = new Map<
    string,
    {
      owner_name?: string | null;
      owner_phone_raw?: string | null;
      owner_phone_normalized?: string | null;
    }
  >();

  if (pageIds.length > 0) {
    const [rendersRes, pubsRes, contactsRes] = await Promise.all([
      supabase
        .from("render_versions")
        .select(
          "id, listing_id, version_num, status, video_cdn_url, storage_object_path, storage_pruned_at, hook_type, duration_bucket, created_at, completed_at"
        )
        .in("listing_id", pageIds)
        .order("version_num", { ascending: false }),
      supabase
        .from("publications")
        .select("*")
        .in("listing_id", pageIds)
        .order("created_at", { ascending: false }),
      member?.role !== "SMM"
        ? supabase
            .from("listing_owner_contacts")
            .select(
              "listing_id, owner_name, owner_phone_raw, owner_phone_normalized"
            )
            .in("listing_id", pageIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    for (const r of rendersRes.data ?? []) {
      const lid = r.listing_id as string;
      if (!latestByListing.has(lid)) {
        const hasCloudVideo =
          !r.storage_pruned_at &&
          (Boolean(r.video_cdn_url) || Boolean(r.storage_object_path));
        latestByListing.set(lid, {
          id: r.id as string | undefined,
          version_num: r.version_num as number,
          status: r.status as RenderStatus,
          video_cdn_url: hasCloudVideo
            ? ((r.video_cdn_url as string | null) ??
              (r.storage_object_path as string | null) ??
              null)
            : null,
          hook_type: (r.hook_type as string | null) ?? null,
          duration_bucket: (r.duration_bucket as string | null) ?? null,
          created_at: (r.created_at as string | null) ?? null,
          completed_at: (r.completed_at as string | null) ?? null,
        });
      }
    }

    for (const p of (pubsRes.data as Publication[] | null) ?? []) {
      if (!latestPubByListing.has(p.listing_id)) {
        latestPubByListing.set(p.listing_id, p);
      }
    }

    for (const c of (contactsRes.data as Array<{
      listing_id: string;
      owner_name?: string | null;
      owner_phone_raw?: string | null;
      owner_phone_normalized?: string | null;
    }> | null) ?? []) {
      ownerContactByListing.set(c.listing_id, c);
    }
  }

  const merged: ListingWithLatestRender[] = pageListings.map((l) => {
    const contact = ownerContactByListing.get(l.id);
    const activeJob = activeJobStatusByListing.get(l.id);
    return {
      ...l,
      pipeline_status:
        activeJob === "RUNNING"
          ? "RENDERING"
          : activeJob === "QUEUED"
            ? "QUEUED"
            : l.pipeline_status,
      contact_name: contact?.owner_name ?? l.contact_name,
      owner_phone_raw: contact?.owner_phone_raw ?? l.owner_phone_raw,
      owner_phone_normalized:
        contact?.owner_phone_normalized ?? l.owner_phone_normalized,
      latestRender: latestByListing.get(l.id) ?? null,
      publication: latestPubByListing.get(l.id) ?? null,
    };
  });

  const pagination: PaginatedResult<ListingWithLatestRender> = {
    items: merged,
    totalCount,
    page,
    pageSize,
    hasNextPage: from + merged.length < totalCount,
  };

  return (
    <ListingsClient
      initialListings={merged}
      pagination={pagination}
      initialFilters={initialFilters}
      memberRole={member?.role ?? "BROKER"}
      serverTabCounts={serverTabCounts}
      serverNicheCounts={serverNicheCounts}
      channelProfiles={channelProfiles}
    />
  );
}
