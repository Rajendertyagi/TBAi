/**
 * Suppresses server preference patches while applying server-authoritative
 * appearance state locally (prevents sync loops / redundant no-op requests).
 */
let suppress = 0;
export function suppressAppearancePatch(): void {
  suppress++;
}
export function consumeAppearancePatchSuppression(): boolean {
  if (suppress > 0) {
    suppress--;
    return true;
  }
  return false;
}
