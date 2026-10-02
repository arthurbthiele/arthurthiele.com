const OPENING_CONTEXT = /(^|[\s([{—–-])/;

/**
 * Markdown bodies get SmartyPants, but frontmatter strings (titles, descriptions) don't, and fonts like IM Fell
 * draw a straight ' as a closing curl, so 'quoted' titles render with a backwards opening mark.
 */
export function typographicQuotes(text: string) {
  return text
    .replace(new RegExp(`${OPENING_CONTEXT.source}'`, "g"), "$1‘")
    .replace(/'/g, "’")
    .replace(new RegExp(`${OPENING_CONTEXT.source}"`, "g"), "$1“")
    .replace(/"/g, "”");
}
