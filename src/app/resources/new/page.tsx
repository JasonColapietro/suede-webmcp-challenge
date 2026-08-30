"use client";

import dynamic from "next/dynamic";

const ResourceCreateForm = dynamic(
  () => import("@/components/resources/ResourceCreateForm"),
  {
    ssr: false,
    loading: () => <p className="resource-route-loading" role="status">Preparing the Foundry…</p>,
  },
);

export default function NewResourcePage(): React.JSX.Element {
  return <ResourceCreateForm />;
}
