import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  ListingsClient,
  type ListingWithLatestRender,
} from "@/components/ListingsClient";
import type { Listing, Publication, RenderStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ListingsPage() {
  if (!isSupabaseConfigured()) {
    return <ListingsClient initialListings={[]} />;
  }

  const supabase = await createClient();

  const [listingsRes, rendersRes, pubsRes] = await Promise.all([
    supabase
      .from("listings")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(200),
    supabase
      .from("render_versions")
      .select("id, listing_id, version_num, status, video_cdn_url, hook_type, duration_bucket")
      .order("version_num", { ascending: false })
      .limit(500),
    supabase
      .from("publications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const latestByListing = new Map<
    string,
    {
      id?: string;
      version_num: number;
      status: RenderStatus;
      video_cdn_url: string | null;
      hook_type?: string | null;
      duration_bucket?: string | null;
    }
  >();

  for (const r of rendersRes.data ?? []) {
    const lid = r.listing_id as string;
    if (!latestByListing.has(lid)) {
      latestByListing.set(lid, {
        id: r.id as string | undefined,
        version_num: r.version_num as number,
        status: r.status as RenderStatus,
        video_cdn_url: (r.video_cdn_url as string | null) ?? null,
        hook_type: (r.hook_type as string | null) ?? null,
        duration_bucket: (r.duration_bucket as string | null) ?? null,
      });
    }
  }

  const latestPubByListing = new Map<string, Publication>();
  for (const p of (pubsRes.data as Publication[] | null) ?? []) {
    const lid = p.listing_id;
    if (!latestPubByListing.has(lid)) {
      latestPubByListing.set(lid, p);
    }
  }

  const merged: ListingWithLatestRender[] = (
    (listingsRes.data as Listing[] | null) ?? []
  ).map((l) => ({
    ...l,
    latestRender: latestByListing.get(l.id) ?? null,
    publication: latestPubByListing.get(l.id) ?? null,
  }));

  return <ListingsClient initialListings={merged} />;
}
