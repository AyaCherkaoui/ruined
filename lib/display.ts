// Human-readable drug labels, shared by drug search and the upcoming-risk feed.
// Mirrors components/format.ts's displayDrugName exactly (duplicated, not imported: the UI layer
// is out of scope for the backend build -- see PROGRESS.md).

/** Brand in brackets when RxNorm includes one (e.g. "... [Myrbetriq]" -> "Myrbetriq"); otherwise the first few words. */
export function displayDrugName(name: string): string {
  const brand = name.match(/\[([^\]]+)\]/);
  if (brand?.[1]?.trim()) return brand[1].trim();
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
}
