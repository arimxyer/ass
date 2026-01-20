// src/types.ts

export interface GitHubMetadata {
  stars: number;
  language: string | null;
  pushedAt: string;
}

export interface GitHubNotFound {
  notFound: true;
  checkedAt: string;
}

export interface Item {
  name: string;
  url: string;
  description: string;
  category: string;
  subcategory?: string;
  lastEnriched?: string;
  github?: GitHubMetadata | GitHubNotFound;
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
