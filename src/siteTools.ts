export interface SiteTool {
  href: string;
  title: string;
  description: string;
  glyph: string;
}

export const SITE_TOOLS: SiteTool[] = [
  {
    href: "/tools/percentile/",
    title: "Percentile converter",
    description: "Take where you sit in one distribution and find the same spot, or its mirror image, in another.",
    glyph: "◐"
  }
];
