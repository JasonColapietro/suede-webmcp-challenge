/**
 * There is one comparison today, so the bare section route points to it. If a
 * second comparison ships, replace this redirect with a real index page.
 */
import { permanentRedirect } from "next/navigation";

export default function CompareIndexPage(): never {
  permanentRedirect("/compare/gumloop-alternative");
}
