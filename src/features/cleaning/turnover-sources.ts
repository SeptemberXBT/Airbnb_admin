export const externalTurnoverTypes = ["reservation", "unavailable"] as const;

export function isExternalTurnoverType(value: string) {
  return externalTurnoverTypes.some((type) => type === value);
}
