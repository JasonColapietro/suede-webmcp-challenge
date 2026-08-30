/**
 * Real, verified press mentions — each URL confirmed live (HTTP 200) and
 * headline checked against the live page before adding. Single source of
 * truth: the founder page's full "In the press" section and the shared
 * footer's compact press line both render from this list.
 */
export interface PressMention {
  outlet: string;
  href: string;
  headline: string;
  /** Compact label for space-constrained contexts like the footer. */
  shortLabel: string;
  /** ISO publish date, read off the live article. */
  published: string;
  /** Human date for rendering; precomputed so no surface formats at runtime. */
  publishedLabel: string;
}

export const PRESS_MENTIONS: PressMention[] = [
  {
    outlet: "TechBullion",
    href: "https://techbullion.com/jason-colapietros-suede-labs-ai-launches-ios-apps/",
    headline: "Suede Labs AI Releases iOS Apps, Codex Skills & Musicians Terminal",
    shortLabel: "TechBullion: iOS Apps",
    published: "2026-05-25",
    publishedLabel: "May 2026",
  },
  {
    outlet: "Altcoin Investor",
    href: "https://altcoininvestor.com/ai-blockchain-on-chain-ip-creator-ownership/",
    headline: "How AI, Blockchain, and On-Chain IP Are Changing Creator Ownership",
    shortLabel: "Altcoin Investor: Creator Ownership",
    published: "2026-05-09",
    publishedLabel: "May 2026",
  },
  {
    outlet: "TechBullion",
    href: "https://techbullion.com/suede-labs-brings-ai-powered-creative-tools-to-students-the-quiet-revolution-in-africas-classrooms/",
    headline: "Suede Labs Brings AI-Powered Creative Tools to Students: The Quiet Revolution in Africa's Classrooms",
    shortLabel: "TechBullion: Africa's Classrooms",
    published: "2026-01-07",
    publishedLabel: "Jan 2026",
  },
  {
    outlet: "TechBullion",
    href: "https://techbullion.com/suede-labs-launches-a-comprehensive-on-chain-ip-authentication-system/",
    headline: "Suede Labs Launches A Comprehensive On-Chain IP Authentication System",
    shortLabel: "TechBullion: IP Authentication",
    published: "2025-12-15",
    publishedLabel: "Dec 2025",
  },
];
