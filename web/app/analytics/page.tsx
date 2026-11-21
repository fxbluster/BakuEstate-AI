import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  AnalyticsClient,
  type EnrichedComment,
  type EnrichedPublication,
} from "@/components/AnalyticsClient";
import type {
  BuyerLead,
  LeadTimelineEvent,
  Listing,
  Publication,
  RenderVersion,
  SocialComment,
  TelemetrySnapshot,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <AnalyticsClient
        publications={[]}
        comments={[]}
        snapshots={[]}
        leads={[]}
        timelineEvents={[]}
      />
    );
  }

  const supabase = await createClient();

  const [
    pubsRes,
    listingsRes,
    rendersRes,
    commentsRes,
    leadsRes,
    snapshotsRes,
    timelineEventsRes,
  ] = await Promise.all([
    supabase
      .from("publications")
      .select("*")
      .order("published_at", { ascending: false })
      .limit(200),
    supabase
      .from("listings")
      .select(
        "id, bina_id, title, price_azn_normalized, location, photo_urls"
      )
      .limit(500),
    supabase
      .from("render_versions")
      .select(
        "id, listing_id, version_num, status, hook_type, duration_bucket, duration_seconds, video_cdn_url"
      )
      .limit(500),
    supabase
      .from("social_comments")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("buyer_leads")
      .select(
        "id, client_name, phone_normalized, stage, actual_commission_azn, attributed_channel_niche, attributed_publication_id"
      )
      .limit(500),
    supabase
      .from("publication_telemetry_snapshots")
      .select("*")
      .order("captured_at", { ascending: false })
      .limit(500),
    supabase
      .from("lead_timeline_events")
      .select(
        "id, lead_id, listing_id, actor, event_type, summary, metadata, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const rawPubs = (pubsRes.data as Publication[] | null) ?? [];
  const rawListings = (listingsRes.data as Listing[] | null) ?? [];
  const rawRenders = (rendersRes.data as RenderVersion[] | null) ?? [];
  const rawComments = (commentsRes.data as SocialComment[] | null) ?? [];
  const rawLeads = (leadsRes.data as BuyerLead[] | null) ?? [];
  const rawSnapshots =
    (snapshotsRes.data as TelemetrySnapshot[] | null) ?? [];
  const rawTimelineEvents =
    (timelineEventsRes.data as LeadTimelineEvent[] | null) ?? [];

  const listingsMap = new Map<string, Listing>();
  for (const l of rawListings) {
    listingsMap.set(l.id, l);
  }

  const rendersMap = new Map<string, RenderVersion>();
  for (const r of rawRenders) {
    rendersMap.set(r.id, r);
  }

  const pubsMap = new Map<string, Publication>();
  for (const p of rawPubs) {
    pubsMap.set(p.id, p);
  }

  const leadsMap = new Map<string, BuyerLead>();
  for (const lead of rawLeads) {
    leadsMap.set(lead.id, lead);
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
    const buyerLead = c.buyer_lead_id
      ? leadsMap.get(c.buyer_lead_id) ?? null
      : null;

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
      buyer_lead: buyerLead
        ? {
            id: buyerLead.id,
            client_name: buyerLead.client_name,
            phone_normalized: buyerLead.phone_normalized,
            stage: buyerLead.stage,
          }
        : null,
    };
  });

  return (
    <AnalyticsClient
      publications={enrichedPublications}
      comments={enrichedComments}
      snapshots={rawSnapshots}
      leads={rawLeads}
      timelineEvents={rawTimelineEvents}
    />
  );
}
