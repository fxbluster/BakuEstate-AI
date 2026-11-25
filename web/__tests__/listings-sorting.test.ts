import { describe, it, expect } from "vitest";
import {
  sortListings,
  getListingRenderTimestamp,
  type SortMode,
} from "@/lib/listing-sorter";
import type { ListingWithLatestRender } from "@/components/ListingsClient";
import type { Listing } from "@/lib/types";

function mockListing(
  overrides: Partial<ListingWithLatestRender>
): ListingWithLatestRender {
  const base: Listing = {
    id: "test-id-" + (overrides.bina_id || "0"),
    bina_id: overrides.bina_id || "1000",
    url: "https://bina.az/items/1000",
    duplicate_of_listing_id: null,
    duplicate_confidence: null,
    duplicate_resolution: "NONE",
    photo_urls_hash: null,
    content_revision: 1,
    last_rendered_revision: null,
    title: "Test Mənzil",
    price: 100000,
    currency: "AZN",
    price_azn_normalized: 100000,
    location: "Nəsimi r.",
    district_normalized: "Nəsimi",
    address: "Nizami küç.",
    rooms: 2,
    area: 75,
    floor: 5,
    floors: 16,
    has_bill_of_sale: true,
    is_owner: true,
    contact_name: "Əli",
    owner_phone_raw: "0501234567",
    owner_phone_normalized: "+994501234567",
    photo_urls: [],
    description: null,
    archetype: "budget",
    source_availability: "ACTIVE",
    first_seen_at: "2026-11-20T10:00:00Z",
    last_seen_at: "2026-11-22T10:00:00Z",
    last_checked_at: null,
    pipeline_status: "NEW",
    editorial_status: "PENDING_REVIEW",
    owner_outreach_status: "NOT_CONTACTED",
    commission_type: null,
    commission_value: null,
    owner_min_price_azn: null,
    owner_last_contacted_at: null,
    owner_next_checkin_at: null,
    owner_notes: null,
    last_auto_rendered_at: null,
    created_at: "2026-11-20T10:00:00Z",
    updated_at: "2026-11-22T10:00:00Z",
  };

  return {
    ...base,
    ...overrides,
    latestRender: overrides.latestRender ?? null,
    publication: overrides.publication ?? null,
  };
}

describe("Listings Sorting System (sortListings)", () => {
  const itemA = mockListing({
    bina_id: "1001",
    price_azn_normalized: 150000,
    created_at: "2026-11-20T12:00:00Z",
    last_seen_at: "2026-11-20T12:00:00Z",
    latestRender: {
      version_num: 1,
      status: "COMPLETED",
      video_cdn_url: "https://example.com/v1.mp4",
      completed_at: "2026-11-21T15:00:00Z",
      created_at: "2026-11-21T14:50:00Z",
    },
  });

  const itemB = mockListing({
    bina_id: "1002",
    price_azn_normalized: 320000,
    created_at: "2026-11-22T08:00:00Z",
    last_seen_at: "2026-11-22T08:00:00Z",
    latestRender: {
      version_num: 2,
      status: "COMPLETED",
      video_cdn_url: "https://example.com/v2.mp4",
      completed_at: "2026-11-22T18:00:00Z", // Newest render
      created_at: "2026-11-22T17:50:00Z",
    },
  });

  const itemC = mockListing({
    bina_id: "1003",
    price_azn_normalized: 85000,
    created_at: "2026-11-21T09:00:00Z",
    last_seen_at: "2026-11-21T09:00:00Z",
    latestRender: null, // No video
  });

  it("sorts by PRICE_DESC (bahadan ucuza)", () => {
    const sorted = sortListings([itemA, itemB, itemC], "PRICE_DESC");
    expect(sorted.map((x) => x.bina_id)).toEqual(["1002", "1001", "1003"]);
    expect(sorted[0].price_azn_normalized).toBe(320000);
    expect(sorted[2].price_azn_normalized).toBe(85000);
  });

  it("sorts by PRICE_ASC (ucuzdan bahaya)", () => {
    const sorted = sortListings([itemA, itemB, itemC], "PRICE_ASC");
    expect(sorted.map((x) => x.bina_id)).toEqual(["1003", "1001", "1002"]);
    expect(sorted[0].price_azn_normalized).toBe(85000);
    expect(sorted[2].price_azn_normalized).toBe(320000);
  });

  it("sorts by RENDER_LATEST (ən son videosu render edilmiş)", () => {
    const sorted = sortListings([itemA, itemB, itemC], "RENDER_LATEST");
    // itemB has newest render (Nov 22 18:00), itemA has older render (Nov 21 15:00), itemC has no render
    expect(sorted.map((x) => x.bina_id)).toEqual(["1002", "1001", "1003"]);
  });

  it("sorts by RENDER_OLDEST (ən köhnə videosu render edilmiş)", () => {
    const sorted = sortListings([itemA, itemB, itemC], "RENDER_OLDEST");
    // itemA has older render (Nov 21 15:00), itemB has newer render (Nov 22 18:00), itemC has no render
    expect(sorted.map((x) => x.bina_id)).toEqual(["1001", "1002", "1003"]);
  });

  it("correctly extracts timestamp from getListingRenderTimestamp", () => {
    expect(getListingRenderTimestamp(itemB)).toBe(
      new Date("2026-11-22T18:00:00Z").getTime()
    );
    expect(getListingRenderTimestamp(itemC)).toBeNull();
  });
});
