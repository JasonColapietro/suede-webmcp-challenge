import Image from "next/image";
import Link from "next/link";
import type { EditorialVisual } from "@/lib/editorial-visuals";

export default function EditorialProofFigure({
  visual,
}: {
  readonly visual: EditorialVisual;
}): React.JSX.Element {
  return (
    <figure
      className="lp-proof-figure"
      data-editorial-proof={visual.id}
      data-source-export={visual.sourceFilename}
    >
      <div className="lp-proof-media">
        <Image
          className="lp-proof-image"
          src={visual.src}
          width={visual.width}
          height={visual.height}
          alt={visual.alt}
          sizes="(max-width: 720px) calc(100vw - 2rem), 1120px"
          loading="lazy"
        />
      </div>
      <figcaption className="lp-proof-caption">
        {visual.href ? (
          <Link className="lp-proof-label" href={visual.href}>
            {visual.evidenceLabel}
          </Link>
        ) : (
          <span className="lp-proof-label">{visual.evidenceLabel}</span>
        )}
        <span>{visual.caption}</span>
      </figcaption>
    </figure>
  );
}

