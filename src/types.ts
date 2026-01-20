// src/types.ts

export interface Item {
  name: string;
  url: string;
  description: string;
  category: string;
  subcategory?: string;
  lastEnriched?: string;
  github?: {
    stars: number;
    language: string | null;
    pushedAt: string;
  };
}

export interface ListEntry {
  lastParsed: string;
  pushedAt: string;
  items: Item[];
}

export interface ItemsIndex {
  generatedAt: string;
  listCount: number;
  itemCount: number;
  lists: Record<string, ListEntry>;
}

export interface DiffResult {
  added: Item[];
  removed: Item[];
  unchanged: Item[];
  updated: Item[];
}
