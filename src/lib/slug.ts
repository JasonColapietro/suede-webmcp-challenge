export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "agent";
}

export function uniqueSlug(name: string): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${slugify(name)}-${suffix}`;
}
