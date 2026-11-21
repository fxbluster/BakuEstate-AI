import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  LeadsClient,
  type ListingPickerOption,
} from "@/components/LeadsClient";
import type { BuyerLeadWithListings } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  if (!isSupabaseConfigured()) {
    return <LeadsClient initialLeads={[]} listingOptions={[]} />;
  }

  const supabase = await createClient();

  const [leadsRes, listingsRes] = await Promise.all([
    supabase
      .from("buyer_leads")
      .select(
        "*, lead_listings(lead_id, listing_id, relation, notes, updated_at, listings(id, bina_id, title, location, price_azn_normalized, source_availability, owner_outreach_status, editorial_status, rooms, area))"
      )
      .order("updated_at", { ascending: false })
      .limit(200),
    supabase
      .from("listings")
      .select(
        "id, bina_id, title, location, price_azn_normalized, source_availability, owner_outreach_status, rooms, area"
      )
      .order("last_seen_at", { ascending: false })
      .limit(200),
  ]);

  return (
    <LeadsClient
      initialLeads={(leadsRes.data as BuyerLeadWithListings[] | null) ?? []}
      listingOptions={(listingsRes.data as ListingPickerOption[] | null) ?? []}
    />
  );
}
