import type postgres from "postgres";

export const INVENTORY_SOURCE_KINDS = [
  "website_hold",
  "website_booking",
  "manual_local",
  "airbnb_reservation",
  "airbnb_unavailable",
  "airbnb_unknown",
] as const;

export type InventorySourceKind = typeof INVENTORY_SOURCE_KINDS[number];
export type InventoryTransaction = postgres.TransactionSql;

type BaseClaim = {
  propertyId: string;
  stayDates: string[];
  sourceId: string;
};

export type InventoryClaim =
  | (BaseClaim & { sourceKind: "website_hold"; expiresAt: Date })
  | (BaseClaim & { sourceKind: Exclude<InventorySourceKind, "website_hold">; expiresAt?: never });
