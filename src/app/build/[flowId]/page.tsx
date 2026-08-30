"use client";

import dynamic from "next/dynamic";

/* The studio is client-only on purpose. Next hydrates the initial server tree
   inside a single React transition (startTransition(() => hydrateRoot(...)));
   with the full builder in that tree the hydration render is large enough
   that boot-time updates keep interrupting and restarting it, and React
   livelocks in a storm of empty commits — observed as an 8-12s main-thread
   freeze on /build/* before the canvas became interactive. Loading the
   builder after hydration keeps the hydrated tree trivial, so the freeze
   window cannot form. The route is noindex (see layout.tsx), so server
   rendering the builder markup bought nothing a crawler keeps. */
const Builder = dynamic(() => import("./builder"), {
  ssr: false,
  loading: () => (
    <main style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
      <p className="eyebrow" role="status">
        Loading the studio…
      </p>
    </main>
  ),
});

export default function BuildPage(): React.JSX.Element {
  return <Builder />;
}
