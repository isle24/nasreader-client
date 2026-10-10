// One-use handoff held only in memory, never in the URL or browser storage.
export interface IdentitySelectionScope {server: string; userId: number}
let pending: {scope: string; ids: number[]} | null = null;
const key = (scope: IdentitySelectionScope) => JSON.stringify([scope.server, scope.userId]);
export function syncIdentitySelectionScope(scope: IdentitySelectionScope): void {
  if (pending && pending.scope !== key(scope)) pending = null;
}
export function handoffIdentitySelection(scope: IdentitySelectionScope, ids: readonly number[]): void {
  pending = {scope: key(scope), ids: [...ids]};
}
export function takeIdentitySelection(scope: IdentitySelectionScope): number[] {
  const result = pending?.scope === key(scope) ? [...pending.ids] : [];
  pending = null;
  return result;
}
