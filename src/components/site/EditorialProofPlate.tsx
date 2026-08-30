"use client";

import { usePathname } from "next/navigation";
import { getEditorialVisualForPath } from "@/lib/editorial-visuals";
import EditorialProofFigure from "./EditorialProofFigure";

export default function EditorialProofPlate(): React.JSX.Element {
  const pathname = usePathname();
  const visual = getEditorialVisualForPath(pathname);

  return (
    <section className="lp-proof-band" aria-label="Inside Agent Studio">
      <div className="lp-shell">
        <EditorialProofFigure visual={visual} />
      </div>
    </section>
  );
}

