import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { ListingDetailClient } from "@/components/ListingDetailClient";
import type {
  Listing,
  ListingEvent,
  Publication,
  RenderVersion,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ListingDetailPage({
  params,
}: {
  params: Promise<{ bina_id: string }>;
}) {
  const { bina_id } = await params;

  if (!isSupabaseConfigured()) {
    return (
      <div className="exec-card p-8 text-center space-y-3">
        <p className="text-sm text-slate-300">
          Supabase bağlantısı konfiqurasiya edilməyib.
        </p>
        <Link href="/listings" className="exec-btn-secondary text-xs">
          Elanlara qayıt
        </Link>
      </div>
    );
  }

  const supabase = await createClient();

  const { data: listingData } = await supabase
    .from("listings")
    .select("*")
    .eq("bina_id", bina_id)
    .maybeSingle();

  if (!listingData) {
    notFound();
  }

  const listing = listingData as Listing;

  const [eventsRes, rendersRes, pubsRes] = await Promise.all([
    supabase
      .from("listing_events")
      .select("*")
      .eq("listing_id", listing.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("render_versions")
      .select("*")
      .eq("listing_id", listing.id)
      .order("version_num", { ascending: false })
      .limit(50),
    supabase
      .from("publications")
      .select("*")
      .eq("listing_id", listing.id)
      .order("published_at", { ascending: false })
      .limit(50),
  ]);

  return (
    <ListingDetailClient
      initialListing={listing}
      initialEvents={(eventsRes.data as ListingEvent[] | null) ?? []}
      initialRenders={(rendersRes.data as RenderVersion[] | null) ?? []}
      initialPublications={(pubsRes.data as Publication[] | null) ?? []}
    />
  );
}
