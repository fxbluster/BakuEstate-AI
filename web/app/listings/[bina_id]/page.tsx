import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient, getServerSessionMember } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { resolvePlayableRenders } from "@/lib/r2-media";
import { ListingDetailClient } from "@/components/ListingDetailClient";
import type {
  Listing,
  ListingEvent,
  Publication,
  RenderVersion,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const rawParam = decodeURIComponent(bina_id).trim();
  if (!rawParam) {
    notFound();
  }

  const [supabase, member] = await Promise.all([
    createClient(),
    getServerSessionMember(),
  ]);

  const isUuid = UUID_REGEX.test(rawParam);

  let listingQuery = supabase
    .from("listings")
    .select("*")
    .eq(isUuid ? "id" : "bina_id", rawParam);

  if (member?.agency_id) {
    listingQuery = listingQuery.eq("agency_id", member.agency_id);
  }

  const { data: listingData } = await listingQuery.maybeSingle();

  if (!listingData) {
    notFound();
  }

  const baseListing = listingData as Listing;

  const [eventsRes, rendersRes, pubsRes, ownerContactRes] = await Promise.all([
    supabase
      .from("listing_events")
      .select("*")
      .eq("listing_id", baseListing.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("render_versions")
      .select("*")
      .eq("listing_id", baseListing.id)
      .order("version_num", { ascending: false })
      .limit(50),
    supabase
      .from("publications")
      .select("*")
      .eq("listing_id", baseListing.id)
      .order("published_at", { ascending: false })
      .limit(50),
    member?.role !== "SMM"
      ? supabase
          .from("listing_owner_contacts")
          .select("owner_name, owner_phone_raw, owner_phone_normalized")
          .eq("listing_id", baseListing.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const ownerContact = ownerContactRes?.data as {
    owner_name?: string | null;
    owner_phone_raw?: string | null;
    owner_phone_normalized?: string | null;
  } | null;

  const listing: Listing = {
    ...baseListing,
    contact_name: ownerContact?.owner_name ?? baseListing.contact_name,
    owner_phone_raw:
      ownerContact?.owner_phone_raw ?? baseListing.owner_phone_raw,
    owner_phone_normalized:
      ownerContact?.owner_phone_normalized ??
      baseListing.owner_phone_normalized,
  };

  const resolvedRenders = await resolvePlayableRenders(
    (rendersRes.data as RenderVersion[] | null) ?? []
  );

  return (
    <ListingDetailClient
      initialListing={listing}
      initialEvents={(eventsRes.data as ListingEvent[] | null) ?? []}
      initialRenders={resolvedRenders}
      initialPublications={(pubsRes.data as Publication[] | null) ?? []}
      memberRole={member?.role ?? "BROKER"}
      agencyId={member?.agency_id ?? null}
    />
  );
}
