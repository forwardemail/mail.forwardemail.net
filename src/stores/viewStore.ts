import { writable } from 'svelte/store';
import type { Writable } from 'svelte/store';

export type SortOrderValue =
  | 'newest'
  | 'oldest'
  | 'from-asc'
  | 'from-desc'
  | 'subject-asc'
  | 'subject-desc';

export const threadingEnabled: Writable<boolean> = writable(true);
export const sidebarOpen: Writable<boolean> = writable(true);
export const showFilters: Writable<boolean> = writable(false);
export const sortOrder: Writable<SortOrderValue> = writable('newest');
export const query: Writable<string> = writable('');
export const unreadOnly: Writable<boolean> = writable(false);
export const hasAttachmentsOnly: Writable<boolean> = writable(false);
export const filterByLabel: Writable<string[]> = writable([]);
export const starredOnly: Writable<boolean> = writable(false);

/**
 * Message list row density, mirrored from the list_density setting by
 * applyDensity in main.ts. CSS reads data-density on <html> for row height;
 * this store is for markup that changes shape, such as power density
 * collapsing card rows to a single line.
 */
export type ListDensityValue = 'comfortable' | 'compact' | 'power';

export const LIST_DENSITIES: readonly ListDensityValue[] = ['comfortable', 'compact', 'power'];

/** Anything stored that is not a known density falls back to compact. */
export function resolveListDensity(value: unknown): ListDensityValue {
  return LIST_DENSITIES.includes(value as ListDensityValue)
    ? (value as ListDensityValue)
    : 'compact';
}

export const listDensity: Writable<ListDensityValue> = writable('compact');
