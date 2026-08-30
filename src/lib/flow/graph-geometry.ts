import { GraphCommandError, type NodeBounds, type Point } from "./graph-command-types";

type Axis = "x" | "y";
type Alignment = "start" | "center" | "end";

const codeUnitCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function selectedBounds(
  bounds: Readonly<Record<string, NodeBounds>>,
  nodeIds: readonly string[],
  minimum: number,
): Array<{ id: string; bounds: NodeBounds }> {
  if (nodeIds.length < minimum) {
    throw new GraphCommandError(minimum === 2 ? "Alignment requires at least two nodes" : "Distribution requires at least three nodes");
  }
  if (new Set(nodeIds).size !== nodeIds.length) throw new GraphCommandError("Selection node IDs must be unique");
  const expected = [...nodeIds].sort(codeUnitCompare);
  const actual = Object.keys(bounds).sort(codeUnitCompare);
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new GraphCommandError("Bounds must exactly cover selected node IDs");
  }
  return nodeIds.map((id) => {
    const value = bounds[id];
    if (!value) throw new GraphCommandError(`Bounds are missing node "${id}"`);
    if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) {
      throw new GraphCommandError(`Bounds for node "${id}" must be finite`);
    }
    if (value.width < 0 || value.height < 0) throw new GraphCommandError(`Bounds for node "${id}" must be nonnegative`);
    return { id, bounds: value };
  });
}

const start = (value: NodeBounds, axis: Axis): number => value[axis];
const size = (value: NodeBounds, axis: Axis): number => axis === "x" ? value.width : value.height;
const pointWithAxis = (value: NodeBounds, axis: Axis, coordinate: number): Point => axis === "x"
  ? { x: coordinate, y: value.y }
  : { x: value.x, y: coordinate };

export function alignSelection(
  bounds: Readonly<Record<string, NodeBounds>>,
  nodeIds: readonly string[],
  axis: Axis,
  mode: Alignment,
): Record<string, Point> {
  const selected = selectedBounds(bounds, nodeIds, 2);
  const minimum = Math.min(...selected.map(({ bounds: value }) => start(value, axis)));
  const maximum = Math.max(...selected.map(({ bounds: value }) => start(value, axis) + size(value, axis)));
  const target = mode === "start" ? minimum : mode === "end" ? maximum : (minimum + maximum) / 2;
  return Object.fromEntries(selected.map(({ id, bounds: value }) => {
    const coordinate = mode === "start" ? target : mode === "end" ? target - size(value, axis) : target - size(value, axis) / 2;
    return [id, pointWithAxis(value, axis, coordinate)];
  }));
}

export function distributeSelection(
  bounds: Readonly<Record<string, NodeBounds>>,
  nodeIds: readonly string[],
  axis: Axis,
): Record<string, Point> {
  const selected = selectedBounds(bounds, nodeIds, 3).sort((left, right) => {
    const delta = start(left.bounds, axis) - start(right.bounds, axis);
    return delta || codeUnitCompare(left.id, right.id);
  });
  const first = selected[0] as { id: string; bounds: NodeBounds };
  const last = selected[selected.length - 1] as { id: string; bounds: NodeBounds };
  const occupied = selected.reduce((total, item) => total + size(item.bounds, axis), 0);
  const gap = (start(last.bounds, axis) + size(last.bounds, axis) - start(first.bounds, axis) - occupied) / (selected.length - 1);
  let cursor = start(first.bounds, axis);
  const positions: Record<string, Point> = {};
  for (const item of selected) {
    positions[item.id] = pointWithAxis(item.bounds, axis, cursor);
    cursor += size(item.bounds, axis) + gap;
  }
  return positions;
}
