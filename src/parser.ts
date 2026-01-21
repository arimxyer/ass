// src/parser.ts
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Item } from "./types";

export function parseReadme(markdown: string): Item[] {
  const tree = fromMarkdown(markdown);
  const items: Item[] = [];
  let currentCategory = "Uncategorized";  // Default so items before first h2 are captured
  let currentSubcategory: string | undefined;

  function walk(node: any) {
    // Track h2 headings as categories
    if (node.type === "heading" && node.depth === 2) {
      const text = node.children?.find((c: any) => c.type === "text")?.value || "";
      currentCategory = text;
      currentSubcategory = undefined;
    }

    // Track h3 headings as subcategories
    if (node.type === "heading" && node.depth === 3) {
      const text = node.children?.find((c: any) => c.type === "text")?.value || "";
      currentSubcategory = text;
    }

    // Extract list items with links
    if (node.type === "listItem") {
      const paragraph = node.children?.find((c: any) => c.type === "paragraph");
      if (paragraph) {
        const link = paragraph.children?.find((c: any) => c.type === "link");
        if (link) {
          const name = link.children?.find((c: any) => c.type === "text")?.value || "";
          const url = link.url || "";

          // Get description (text after the link)
          const linkIndex = paragraph.children.indexOf(link);
          const afterLink = paragraph.children.slice(linkIndex + 1);
          const description = afterLink
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.value)
            .join("")
            .replace(/^\s*[-–—]\s*/, "")
            .trim();

          // Skip anchor links and empty names
          if (name && url && !url.startsWith("#")) {
            items.push({
              name,
              url,
              description,
              category: currentCategory,
              ...(currentSubcategory && { subcategory: currentSubcategory }),
            });
          }
        }
      }
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(tree);
  return items;
}
