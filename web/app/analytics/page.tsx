import { createClient, getServerSessionMember } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  AnalyticsClient,
  type AnalyticsSummary,
  type EnrichedComment,
  type EnrichedPublication,
  type NicheFilter,
} from "@/components/AnalyticsClient";
import type {
  Listing,
  PaginatedResult,
  Publication,
  RenderVersion,
  SocialComment,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 24;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    page?: string;
    pageSize?: string;
    days?: string;
    niche?: string;
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
  const days = Math.min(
    365,
    Math.max(1, Number.parseInt(params.days ?? "30", 10) || 30)
  );
  const rawNiche = (params.niche ?? "ALL").toUpperCase();
  const initialNiche: NicheFilter = ["LUXURY", "AFFORDABLE", "GENERAL", "TIKTOK"].includes(
    rawNiche
  )
    ? (rawNiche as NicheFilter)
    : "ALL";

  if (!isSupabaseConfigured()) {
    return (
      <AnalyticsClient
        publications={[]}
        comments={[]}
        snapshots={[]}
        summary={null}
        pagination={{
          items: [],
          totalCount: 0,
          page: 1,
          pageSize,
          hasNextPage: false,
        }}
        initialDays={days}
        initialNiche={initialNiche}
      />
    );
  }

  const [supabase, member] = await Promise.all([
    createClient(),
    getServerSessionMember(),
  ]);

  let pubsQuery = supabase
    .from("publications")
    .select("*", { count: "exact" })
    .order("views_count", { ascending: false })
    .order("published_at", { ascending: false });

  if (member?.agency_id) {
    pubsQuery = pubsQuery.eq("agency_id", member.agency_id);
  }
  if (initialNiche !== "ALL") {
    pubsQuery = pubsQuery.eq("channel_niche", initialNiche);
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const [summaryRes, pubsRes] = await Promise.all([
    supabase.rpc("get_analytics_summary", { p_days: days }),
    pubsQuery.range(from, to),
  ]);

  const rawSummary = summaryRes.data as
    | (AnalyticsSummary & { ok?: boolean })
    | null;
  const summary =
    rawSummary && rawSummary.ok !== false ? rawSummary : null;

  const rawPubs = (pubsRes.data as Publication[] | null) ?? [];
  const totalCount = pubsRes.count ?? rawPubs.length;

  const pagePubIds = rawPubs.map((p) => p.id);
  const pageListingIds = Array.from(
    new Set(rawPubs.map((p) => p.listing_id).filter(Boolean))
  );
  const pageRenderIds = Array.from(
    new Set(
      rawPubs
        .map((p) => p.render_version_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  const listingsMap = new Map<string, Listing>();
  const rendersMap = new Map<string, RenderVersion>();
  let rawComments: SocialComment[] = [];

  if (pagePubIds.length > 0) {
    const [listingsRes, rendersRes, commentsRes] = await Promise.all([
      pageListingIds.length > 0
        ? supabase
            .from("listings")
            .select(
              "id, bina_id, title, price_azn_normalized, location, photo_urls"
            )
            .in("id", pageListingIds)
        : Promise.resolve({ data: [], error: null }),
      pageRenderIds.length > 0
        ? supabase
            .from("render_versions")
            .select(
              "id, listing_id, version_num, status, hook_type, duration_bucket, duration_seconds, video_cdn_url"
            )
            .in("id", pageRenderIds)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from("social_comments")
        .select("*")
        .in("publication_id", pagePubIds)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    for (const l of (listingsRes.data as Listing[] | null) ?? []) {
      listingsMap.set(l.id, l);
    }
    for (const r of (rendersRes.data as RenderVersion[] | null) ?? []) {
      rendersMap.set(r.id, r);
    }
    rawComments = (commentsRes.data as SocialComment[] | null) ?? [];
  }

  const pubsMap = new Map<string, Publication>();
  for (const p of rawPubs) {
    pubsMap.set(p.id, p);
  }

  const enrichedPublications: EnrichedPublication[] = rawPubs.map((p) => ({
    ...p,
    listing: listingsMap.get(p.listing_id) ?? null,
    render: p.render_version_id
      ? rendersMap.get(p.render_version_id) ?? null
      : null,
  }));

  const enrichedComments: EnrichedComment[] = rawComments.map((c) => {
    const pub = pubsMap.get(c.publication_id) ?? null;
    const listing = pub ? listingsMap.get(pub.listing_id) ?? null : null;
    return {
      ...c,
      publication: pub
        ? { id: pub.id, post_url: pub.post_url, channel: pub.channel }
        : null,
      listing: listing
        ? {
            id: listing.id,
            bina_id: listing.bina_id,
            title: listing.title,
            price_azn_normalized: listing.price_azn_normalized,
            location: listing.location,
          }
        : null,
      buyer_lead: null,
    };
  });

  const pagination: PaginatedResult<EnrichedPublication> = {
    items: enrichedPublications,
    totalCount,
    page,
    pageSize,
    hasNextPage: from + enrichedPublications.length < totalCount,
  };

  return (
    <AnalyticsClient
      publications={enrichedPublications}
      comments={enrichedComments}
      snapshots={[]}
      summary={summary}
      pagination={pagination}
      initialDays={days}
      initialNiche={initialNiche}
    />
  );
}
