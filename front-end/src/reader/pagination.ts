// Deterministic page <-> rune-offset mapping for the TXT reader.
//
// The reader renders a text slice as CSS columns. Previously the visible locator was
// re-measured on every save through the DOM while the column transform animated, and
// the scan returned the first span in document order that still overlapped the
// viewport by a fraction of a pixel - so a save right after a page turn could write
// the *previous* page's locator (page/locator drift).
//
// Instead the geometry is sampled once per render, with the transform neutralized,
// into a page table: page -> first rune offset of that page. Page turns then derive
// the locator from the table, which cannot drift and is unit-testable without a DOM.

export interface SpanBox {
  /** Rune offset of the span start (slice-relative). */
  offset: number;
  /** Rune offset just past the span end (slice-relative). */
  end: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PageTable {
  /** starts[p] = first rune offset rendered on page p. */
  starts: number[];
  /** ends[p] = rune offset just past the last rune rendered on page p. */
  ends: number[];
}

const singlePage = (): PageTable => ({ starts: [0], ends: [0] });

/**
 * Build the page table from measurable span boxes. Boxes must carry coordinates
 * relative to the *untransformed* content origin (the reader measures with
 * `transform: none`), one box per `getClientRects()` fragment so a sentence split
 * across a column boundary contributes a box to each of its pages.
 */
export function buildPageTable(boxes: SpanBox[], pageWidth: number, baseLeft = 0): PageTable {
  const width = Number(pageWidth);
  if (!Number.isFinite(width) || width <= 1) return singlePage();
  const usable = boxes.filter((b) => Number.isFinite(b.left) && Number.isFinite(b.offset));
  if (!usable.length) return singlePage();
  const starts: number[] = [];
  const ends: number[] = [];
  let maxPage = 0;
  for (const box of usable) {
    // 1px tolerance so a sub-pixel column boundary never shifts a page backwards.
    const page = Math.max(0, Math.floor((box.left - baseLeft + 1) / width));
    maxPage = Math.max(maxPage, page);
    const end = Math.max(Number(box.end) || 0, box.offset);
    if (starts[page] === undefined || box.offset < starts[page]!) starts[page] = box.offset;
    if (ends[page] === undefined || end > ends[page]!) ends[page] = end;
  }
  // A page whose first box starts as a continuation of the previous page has no
  // offset of its own; continue from the previous page's end so every page has a
  // valid, monotonic locator.
  for (let page = 0; page <= maxPage; page++) {
    if (starts[page] === undefined) starts[page] = page === 0 ? 0 : ends[page - 1] ?? 0;
    if (ends[page] === undefined) ends[page] = starts[page]!;
    if (page > 0 && starts[page]! < starts[page - 1]!) starts[page] = starts[page - 1]!;
    if (ends[page]! < starts[page]!) ends[page] = starts[page]!;
  }
  // Page 0 always starts at the beginning of the slice: it carries the chapter
  // heading, which is not part of any span box.
  if (starts[0]! > 0) starts[0] = 0;
  return { starts, ends };
}

/** Page index whose visible text begins at or before `offset`. */
export function pageForOffset(table: PageTable, offset: number): number {
  const starts = table.starts;
  if (!starts.length) return 0;
  const value = Math.max(0, Number(offset) || 0);
  let low = 0;
  let high = starts.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! <= value) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/** First rune offset rendered on `page` (clamped). */
export function offsetForPage(table: PageTable, page: number): number {
  const starts = table.starts;
  if (!starts.length) return 0;
  const index = Math.max(0, Math.min(starts.length - 1, Math.floor(Number(page) || 0)));
  return starts[index]!;
}

/** Number of pages the table describes (always >= 1). */
export const pageCount = (table: PageTable): number => Math.max(1, table.starts.length);

export interface ScrollTable {
  /** tops[i] = distance of span i from the top of the scroll content. */
  tops: number[];
  offsets: number[];
}

/** Ordered table for the scroll reading mode (offset of the first visible span). */
export function buildScrollTable(boxes: SpanBox[]): ScrollTable {
  const usable = boxes
    .filter((b) => Number.isFinite(b.top) && Number.isFinite(b.offset))
    .slice()
    .sort((a, b) => a.top - b.top || a.offset - b.offset);
  const table: ScrollTable = { tops: [], offsets: [] };
  for (const box of usable) {
    const last = table.tops.length - 1;
    if (last >= 0 && table.offsets[last] === box.offset) continue;
    table.tops.push(box.top);
    table.offsets.push(box.offset);
  }
  if (!table.tops.length) return { tops: [0], offsets: [0] };
  return table;
}

/** Rune offset of the first span visible at the given scroll position. */
export function scrollOffsetAt(table: ScrollTable, scrollTop: number): number {
  const { tops, offsets } = table;
  if (!tops.length) return 0;
  const value = Math.max(0, Number(scrollTop) || 0);
  let low = 0;
  let high = tops.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (tops[mid]! <= value + 1) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return offsets[found]!;
}

/** Scroll position that brings the given rune offset to the top of the viewport. */
export function scrollTopForOffset(table: ScrollTable, offset: number): number {
  const { tops, offsets } = table;
  if (!tops.length) return 0;
  const value = Math.max(0, Number(offset) || 0);
  let low = 0;
  let high = offsets.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid]! <= value) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return tops[found]!;
}
