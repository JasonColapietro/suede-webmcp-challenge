/**
 * Bare /rankings used to 404 even though it reads as the section index
 * (QA round-2 finding 19). There is exactly one ranking today, so the bare
 * path permanently redirects to it; if a second ranking ever ships, replace
 * this with a real index page.
 */
import { permanentRedirect } from "next/navigation";

export default function RankingsIndexPage(): never {
  permanentRedirect("/rankings/best-ai-agent-builders");
}
