export type InventoryLedgerMode = "shadow" | "enforced";

export function parseInventoryLedgerMode(value: string | undefined): InventoryLedgerMode {
  if (value === undefined) return "shadow";
  if (value === "shadow" || value === "enforced") return value;
  throw new Error("INVALID_INVENTORY_LEDGER_MODE");
}

export function getInventoryLedgerMode() {
  return parseInventoryLedgerMode(process.env.INVENTORY_LEDGER_MODE);
}
