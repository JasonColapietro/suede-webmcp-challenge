import { redirect } from "next/navigation";

/**
 * Bare /build has no content — the canvas lives at /build/[flowId].
 * Redirect straight into a blank canvas so the Studio CTA in the
 * three-setting band opens the builder instead of a dashboard detour.
 */
export default function BuildIndexPage(): never {
  redirect("/build/new");
}
