import type { EnvironmentKind } from "@/lib/projects/types";

export default function EnvironmentBadge({
  kind,
}: {
  readonly kind: EnvironmentKind;
}): React.JSX.Element {
  return <span className={`project-environment project-environment--${kind}`}>{kind}</span>;
}
