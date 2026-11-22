import type { ListingWithLatestRender } from "@/components/ListingsClient";

export type SortMode =
  | "DEFAULT"
  | "PRICE_DESC"
  | "PRICE_ASC"
  | "RENDER_LATEST"
  | "RENDER_OLDEST"
  | "DATE_ASC";

export const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "DEFAULT", label: "Ən son əlavə edilən" },
  { value: "PRICE_DESC", label: "💰 Bahadan ucuza" },
  { value: "PRICE_ASC", label: "🏷️ Ucuzdan bahaya" },
  { value: "RENDER_LATEST", label: "🎬 Ən son render edilmiş video" },
  { value: "RENDER_OLDEST", label: "📼 Ən köhnə render edilmiş video" },
  { value: "DATE_ASC", label: "📅 Ən köhnə elanlar" },
];

export function getListingRenderTimestamp(
  item: ListingWithLatestRender
): number | null {
  const dateStr =
    item.latestRender?.completed_at ||
    item.latestRender?.created_at ||
    item.last_auto_rendered_at;
  if (!dateStr) return null;
  const time = new Date(dateStr).getTime();
  return Number.isNaN(time) ? null : time;
}

export function sortListings(
  items: ListingWithLatestRender[],
  mode: SortMode
): ListingWithLatestRender[] {
  const result = [...items];

  switch (mode) {
    case "PRICE_DESC":
      return result.sort((a, b) => {
        const pA = a.price_azn_normalized ?? 0;
        const pB = b.price_azn_normalized ?? 0;
        if (pB !== pA) return pB - pA;
        return Number(b.bina_id || 0) - Number(a.bina_id || 0);
      });

    case "PRICE_ASC":
      return result.sort((a, b) => {
        const pA = a.price_azn_normalized ?? 0;
        const pB = b.price_azn_normalized ?? 0;
        if (pA !== pB) return pA - pB;
        return Number(b.bina_id || 0) - Number(a.bina_id || 0);
      });

    case "RENDER_LATEST":
      return result.sort((a, b) => {
        const rA = getListingRenderTimestamp(a);
        const rB = getListingRenderTimestamp(b);

        // If both have renders, sort by newest render timestamp first
        if (rA !== null && rB !== null) {
          if (rB !== rA) return rB - rA;
          return Number(b.bina_id || 0) - Number(a.bina_id || 0);
        }
        // Listing with render always comes before listing without render
        if (rA !== null && rB === null) return -1;
        if (rA === null && rB !== null) return 1;

        // Fallback for items with no renders: sort by latest seen
        const tA = new Date(a.last_seen_at || a.created_at).getTime() || 0;
        const tB = new Date(b.last_seen_at || b.created_at).getTime() || 0;
        return tB - tA;
      });

    case "RENDER_OLDEST":
      return result.sort((a, b) => {
        const rA = getListingRenderTimestamp(a);
        const rB = getListingRenderTimestamp(b);

        // If both have renders, sort by oldest render timestamp first
        if (rA !== null && rB !== null) {
          if (rA !== rB) return rA - rB;
          return Number(b.bina_id || 0) - Number(a.bina_id || 0);
        }
        // Listing with render always comes before listing without render
        if (rA !== null && rB === null) return -1;
        if (rA === null && rB !== null) return 1;

        // Fallback for items with no renders
        const tA = new Date(a.last_seen_at || a.created_at).getTime() || 0;
        const tB = new Date(b.last_seen_at || b.created_at).getTime() || 0;
        return tB - tA;
      });

    case "DATE_ASC":
      return result.sort((a, b) => {
        const tA = new Date(a.first_seen_at || a.created_at).getTime() || 0;
        const tB = new Date(b.first_seen_at || b.created_at).getTime() || 0;
        if (tA !== tB) return tA - tB;
        return Number(a.bina_id || 0) - Number(b.bina_id || 0);
      });

    case "DEFAULT":
    default:
      return result.sort((a, b) => {
        const tA = new Date(a.last_seen_at || a.created_at).getTime() || 0;
        const tB = new Date(b.last_seen_at || b.created_at).getTime() || 0;
        if (tB !== tA) return tB - tA;
        return Number(b.bina_id || 0) - Number(a.bina_id || 0);
      });
  }
}
