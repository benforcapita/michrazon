// Disabled source stubs (LLD §4.3). haifa / petah_tikva have no adapter in
// the MVP. Enabling one requires code changes (allowlist + real adapter) and
// Ben's approval — these stubs exist so config referencing them fails loudly.

export class DisabledSourceError extends Error {
  constructor(readonly sourceId: string) {
    super(`source '${sourceId}' is disabled in MVP (requires allowlist + code change + approval)`);
    this.name = 'DisabledSourceError';
  }
}

export type DisabledSourceId = 'haifa' | 'petah_tikva';

export interface DisabledSource {
  readonly id: DisabledSourceId;
  readonly enabled: false;
  fetchSince(): never;
}

export function disabledSource(id: DisabledSourceId): DisabledSource {
  return {
    id,
    enabled: false,
    fetchSince(): never {
      throw new DisabledSourceError(id);
    },
  };
}

export const haifaSource = disabledSource('haifa');
export const petahTikvaSource = disabledSource('petah_tikva');
