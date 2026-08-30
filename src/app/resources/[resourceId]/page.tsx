"use client";

import dynamic from "next/dynamic";

const ResourceWorkspace = dynamic(
  () => import("@/components/resources/ResourceWorkspace"),
  {
    ssr: false,
    loading: () => <p className="resource-route-loading" role="status">Loading resource workspace…</p>,
  },
);

export default function ResourceDetailPage(): React.JSX.Element {
  return <ResourceWorkspace />;
}
