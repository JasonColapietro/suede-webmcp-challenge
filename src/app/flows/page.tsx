"use client";

import dynamic from "next/dynamic";

/* The dashboard is client-only on purpose. Next hydrates the initial server
   tree inside a single React transition (startTransition(() => hydrateRoot(...)));
   with the full dashboard in that tree the hydration render is large enough
   that boot-time updates keep interrupting and restarting it, and React
   livelocks in a storm of empty commits — the same failure fixed on /build/*
   in #305, reproduced here under CPU contention (4,575 commits in one load).
   Loading the dashboard after hydration keeps the hydrated tree trivial, so
   the freeze window cannot form. The route is noindex (see layout.tsx), so
   server rendering the dashboard markup bought nothing a crawler keeps. */
const Dashboard = dynamic(() => import("./dashboard"), {
  ssr: false,
  loading: () => (
    <main style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
      <p className="eyebrow" role="status">
        Loading your flows…
      </p>
    </main>
  ),
});

export default function FlowsPage(): React.JSX.Element {
  return <Dashboard />;
}
