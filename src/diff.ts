import type { Item, DiffResult } from "./types";

/**
 * Calculate the difference between old and new item lists.
 * Preserves GitHub metadata from old items when unchanged or updated.
 *
 * @param oldItems - Previous list of items
 * @param newItems - New list of items from README parse
 * @returns Object containing added, removed, unchanged, and updated items
 */
export function diffItems(oldItems: Item[], newItems: Item[]): DiffResult {
  const oldByUrl = new Map(oldItems.map(i => [i.url, i]));
  const newByUrl = new Map(newItems.map(i => [i.url, i]));

  const added: Item[] = [];
  const removed: Item[] = [];
  const unchanged: Item[] = [];
  const updated: Item[] = [];

  // Check new items against old
  for (const newItem of newItems) {
    const oldItem = oldByUrl.get(newItem.url);
    if (!oldItem) {
      added.push(newItem);
    } else if (oldItem.name === newItem.name && oldItem.description === newItem.description) {
      // Unchanged - preserve enrichment data from old item
      unchanged.push({
        ...newItem,
        github: oldItem.github,
        lastEnriched: oldItem.lastEnriched,
      });
    } else {
      // Updated - preserve enrichment data, use new metadata
      updated.push({
        ...newItem,
        github: oldItem.github,
        lastEnriched: oldItem.lastEnriched,
      });
    }
  }

  // Find removed items
  for (const oldItem of oldItems) {
    if (!newByUrl.has(oldItem.url)) {
      removed.push(oldItem);
    }
  }

  return { added, removed, unchanged, updated };
}
