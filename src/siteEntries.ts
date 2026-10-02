export type EntryKind = "Game" | "Tool" | "Post";

export interface SiteEntry {
  kind: EntryKind;
  title: string;
  description: string;
  href: string;
  date: Date;
  image?: { src: string; alt: string };
}

export const MADE_THINGS: SiteEntry[] = [
  {
    kind: "Game",
    title: "Wayword",
    description:
      "A daily word-ladder puzzle. Get from one word to another by adding, removing, or changing one letter at a time.",
    href: "https://wayword.fun/",
    date: new Date("2026-05-17"),
    image: { src: "/projects/wayword.png", alt: "A Wayword puzzle in progress: a small graph of words linking 'there' towards 'lisp'" }
  },
  {
    kind: "Tool",
    title: "Percentile converter",
    description: "Take where you sit in one distribution and find the same spot, or its mirror image, in another.",
    href: "/tools/percentile/",
    date: new Date("2026-10-02")
  }
];
