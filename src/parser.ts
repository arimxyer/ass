// src/parser.ts
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, Heading, ListItem, Paragraph, Link, Text, PhrasingContent, RootContent } from "mdast";
import type { Item } from "./types";

/** Union of all mdast node types we traverse */
type MdastNode = Root | RootContent;

/**
 * Extract text from a heading or paragraph node.
 * Filters for text nodes and concatenates their values.
 */
function extractText(node: Heading | Paragraph): string {
  return (node.children as PhrasingContent[])
    .filter((c): c is Text => c.type === "text")
    .map((c) => c.value)
    .join("");
}

const ALLOWED_SCHEMES = ["http:", "https:"];

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Parse an awesome-list README and extract tool/library items.
 * Traverses the markdown AST to find list items with links, tracking
 * h2 headings as categories and h3 headings as subcategories.
 *
 * @param markdown - Raw markdown content of the README
 * @returns Array of parsed items with name, URL, description, and category context
 */
export function parseReadme(markdown: string): Item[] {
  const tree = fromMarkdown(markdown);
  const items: Item[] = [];
  let currentCategory = "Uncategorized";  // Default so items before first h2 are captured
  let currentSubcategory: string | undefined;

  function walk(node: MdastNode): void {
    // Track h2 headings as categories
    if (node.type === "heading" && node.depth === 2) {
      currentCategory = extractText(node);
      currentSubcategory = undefined;
    }

    // Track h3 headings as subcategories
    if (node.type === "heading" && node.depth === 3) {
      currentSubcategory = extractText(node);
    }

    // Extract list items with links
    if (node.type === "listItem") {
      const listItem = node as ListItem;
      const paragraph = listItem.children?.find((c): c is Paragraph => c.type === "paragraph");
      if (paragraph) {
        const link = paragraph.children?.find((c): c is Link => c.type === "link");
        if (link) {
          const textNode = link.children?.find((c): c is Text => c.type === "text");
          const name = textNode?.value || "";
          const url = link.url || "";

          // Get description (text after the link)
          const linkIndex = paragraph.children.indexOf(link);
          const afterLink = paragraph.children.slice(linkIndex + 1);
          const description = afterLink
            .filter((c): c is Text => c.type === "text")
            .map((c) => c.value)
            .join("")
            .replace(/^\s*[-–—]\s*/, "")
            .trim();

          // Skip anchor links, empty names, and invalid URLs
          if (name && url && !url.startsWith("#") && isValidUrl(url)) {
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
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child as MdastNode);
      }
    }
  }

  walk(tree);
  return items;
}
