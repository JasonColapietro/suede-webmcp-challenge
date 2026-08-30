"use client";

import dynamic from "next/dynamic";

const ResourcePortfolio = dynamic(
  () => import("@/components/resources/ResourcePortfolio"),
  {
    ssr: false,
    loading: () => <p className="resource-route-loading" role="status">Loading resources…</p>,
  },
);

export default function ResourcesPage(): React.JSX.Element {
  return <ResourcePortfolio />;
}
