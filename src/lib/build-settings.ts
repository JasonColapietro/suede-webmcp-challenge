/**
 * The three build settings, in one place.
 *
 * Guided, Studio and Code are the same product at three levels of hand-holding,
 * and every surface that offers the choice — the nav's Build menu, the in-canvas
 * ModeSwitch, the docs intro — has to describe them identically. Before this
 * module the labels lived in mode-switch.tsx and the one-sentence explanation
 * lived as prose in docs/page.tsx, so a fourth writer had nothing to copy from.
 *
 * Blurbs are checked against the pages they describe: Guided mirrors /start's
 * hero, Studio the canvas at /build/[flowId], Code the SDK quickstart at
 * /docs#sdk. If a door changes, the blurb changes here, once.
 */

export type BuildSettingId = "guided" | "studio" | "code";

export interface BuildSetting {
  readonly id: BuildSettingId;
  readonly label: string;
  readonly blurb: string;
}

/** The sentence that separates all three, shown above the choice. Rendered by
 *  the nav's Build menu and by the docs intro — the two places a visitor meets
 *  the three settings before picking one. */
export const BUILD_SETTINGS_LEDE =
  "Three settings to build: Guided walks you through it, Studio is the canvas, " +
  "Code is TypeScript pushed from the terminal.";

export const BUILD_SETTINGS: readonly BuildSetting[] = [
  {
    id: "guided",
    label: "Guided",
    blurb:
      "Describe the job in a sentence. Answer a few plain questions, review the draft, approve it live.",
  },
  {
    id: "studio",
    label: "Studio",
    blurb:
      "Wire it yourself on the canvas: drag nodes, connect them, set the trigger.",
  },
  {
    id: "code",
    label: "Code",
    blurb:
      "Write it in TypeScript with the @suedeai/agents SDK and push it live from your terminal.",
  },
];

/**
 * Where a setting goes.
 *
 * `encodedFlowId` is already URI-encoded by the caller — ModeSwitch encodes it
 * inside the canvas, where the flow id comes from the route.
 *
 * With no flow, Code has nowhere to open: it starts in the terminal, so there is
 * no blank-canvas equivalent. It points at the SDK quickstart instead of
 * rendering disabled — a greyed-out third option in a three-option menu reads as
 * an unfinished product rather than as a different way in.
 */
export function buildSettingHref(
  id: BuildSettingId,
  encodedFlowId: string | null,
): string {
  if (id === "guided") return encodedFlowId ? `/start?flow=${encodedFlowId}` : "/start";
  if (id === "studio") return encodedFlowId ? `/build/${encodedFlowId}` : "/build/new";
  return encodedFlowId ? `/code/${encodedFlowId}` : "/docs#sdk";
}
