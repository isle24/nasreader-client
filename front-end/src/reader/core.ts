// Reader coordinates and private reader settings.
//
// Frozen contract: TXT locators are `c:<global normalized rune offset>`, EPUB uses
// `e:<CFI>`, PDF uses `p:<page>`. All arithmetic here is rune based (code points,
// never UTF-16 units) so a locator means the same thing on every device.

/** Split a string into normalized Unicode runes (code points). */
export const runes = (text: string): string[] => Array.from(text);

/** Rune-aware substring: `runeSlice('书📖页', 0, 2) === '书📖'`. */
export const runeSlice = (text: string, start = 0, end?: number): string =>
  Array.from(text).slice(start, end).join('');

/** Number of normalized runes in a string. */
export const runeLength = (text: string): number => Array.from(text).length;

/** Numeric part of a rune locator, or 0 when it is another locator kind. */
export const locatorOffset = (locator: string): number =>
  /^c:\d+$/.test(locator) ? Number(locator.slice(2)) : 0;

export type LocatorKind = 'rune' | 'epub' | 'pdf' | 'none';

export interface ParsedLocator {
  kind: LocatorKind;
  /** Raw locator text (empty when absent). */
  raw: string;
  /** Rune offset for `c:` locators, page number for `p:`, 0 otherwise. */
  value: number;
}

/** Classify a locator without losing the original string. */
export function parseLocator(locator: string | null | undefined): ParsedLocator {
  const raw = locator ?? '';
  if (/^c:\d+$/.test(raw)) return { kind: 'rune', raw, value: Number(raw.slice(2)) };
  if (/^p:\d+$/.test(raw)) return { kind: 'pdf', raw, value: Number(raw.slice(2)) };
  if (raw.startsWith('epubcfi(') || /^e:/.test(raw)) return { kind: 'epub', raw, value: 0 };
  return { kind: 'none', raw, value: 0 };
}

/** Canonical rune locator for a global rune offset. */
export const formatRuneLocator = (offset: number): string =>
  'c:' + Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));

/** Sentence segmentation used for speech and for rune-offset spans. */
export const sentences = (text: string): string[] =>
  text.match(/[^。！？.!?]+[。！？.!?]*|[。！？.!?]+/gu) ?? [];

export interface SentenceSegment {
  text: string;
  /** Rune offset of the segment start, relative to `base`. */
  start: number;
  /** Rune offset just past the segment end, relative to `base`. */
  end: number;
  index: number;
}

/**
 * Sentence spans with contiguous rune offsets. Every rune of `text` belongs to
 * exactly one segment, so `segments.map(s=>s.text).join('') === text`.
 */
export function sentenceSegments(text: string, base = 0): SentenceSegment[] {
  const parts = sentences(text);
  const out: SentenceSegment[] = [];
  let offset = base;
  for (let i = 0; i < parts.length; i++) {
    const value = parts[i]!;
    const length = runeLength(value);
    out.push({ text: value, start: offset, end: offset + length, index: i });
    offset += length;
  }
  return out;
}

export interface ChapterSpan {
  idx: number;
  /** Inclusive global rune offset. */
  start: number;
  /** Exclusive global rune offset. */
  end: number;
}

/** Chapter index owning a global rune offset (clamped to the book). */
export function chapterAt(chapters: ChapterSpan[], offset: number): number {
  if (!chapters.length) return 0;
  const value = Math.max(0, Number(offset) || 0);
  for (const chapter of chapters) if (value >= chapter.start && value < chapter.end) return chapter.idx;
  return value < chapters[0]!.start ? chapters[0]!.idx : chapters[chapters.length - 1]!.idx;
}

/** Clamp a global rune offset into a chapter's own range. */
export function clampChapterOffset(chapters: ChapterSpan[], idx: number, offset: number): number {
  const chapter = chapters.find((x) => x.idx === idx);
  if (!chapter) return Math.max(0, Number(offset) || 0);
  return Math.min(Math.max(chapter.start, Number(offset) || 0), Math.max(chapter.start, chapter.end - 1));
}

export interface RuneLocation {
  chapter_idx: number;
  /** Chapter-relative rune offset. */
  local: number;
  /** Global rune offset. */
  global: number;
  locator: string;
}

/** Map a global rune offset to {chapter, chapter-relative offset, locator}. */
export function locateRune(chapters: ChapterSpan[], offset: number): RuneLocation {
  const idx = chapterAt(chapters, offset);
  const global = clampChapterOffset(chapters, idx, offset);
  const chapter = chapters.find((x) => x.idx === idx);
  const local = chapter ? Math.max(0, global - chapter.start) : Math.max(0, global);
  return { chapter_idx: idx, local, global, locator: formatRuneLocator(global) };
}

/**
 * Deterministic slice window (chapter-relative runes) for one reader page of text.
 * Slice boundaries are multiples of `size`, so the same locator always maps to the
 * same slice and chunked offline reads stay identical to the server's.
 */
export function sliceWindow(
  chapterStart: number,
  chapterEnd: number,
  targetOffset: number,
  size = 12000,
): { start: number; end: number } {
  const length = Math.max(0, chapterEnd - chapterStart);
  const step = Math.max(1, Math.floor(size));
  const target = Math.min(Math.max(0, (Number(targetOffset) || 0) - chapterStart), Math.max(0, length - 1));
  const lastStart = Math.max(0, Math.ceil(length / step) * step - step);
  const start = Math.min(Math.floor(target / step) * step, lastStart);
  const end = Math.min(length, start + step);
  return { start: Math.max(0, start), end: Math.max(0, end) };
}

/** Reading percent (0..1) for a global rune offset, using the last chapter end. */
export function percentAt(chapters: ChapterSpan[], offset: number): number {
  const total = chapters.length ? chapters[chapters.length - 1]!.end : 0;
  if (!total) return 0;
  return Math.min(1, Math.max(0, (Number(offset) || 0) / total));
}

/**
 * Timestamp for a progress write. The contract compares `updated_at` strictly, so a
 * peer whose clock is ahead can make every later write stale. After the reader has
 * observed (and the user has resolved) such a record, its timestamp becomes a floor,
 * which ends the conflict instead of re-triggering it on the next page turn.
 */
export function progressTimestamp(now: number, floor = 0, override?: number): number {
  const sane = (value: number) => (Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0);
  return Math.max(sane(now), sane(floor), override === undefined ? 0 : sane(override));
}

/** Cache / API key for one book version of one account on one server. */
export const cacheKey = (server: string, user: number, book: number, version: string): string =>
  JSON.stringify([server, user, book, version]);

export function normalizeServer(input: string): string {
  const value = String(input ?? '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  if (!value) return '';
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error('请输入 HTTP / HTTPS 服务地址，不含密码、查询或片段');
  return u.href.replace(/\/$/, '');
}

/**
 * Server the app should talk to before the user configures anything.
 *
 * The web build is served by the same Go service it talks to, so the current
 * origin is always right and asking for an address is pointless. The Tauri
 * client loads a bundled page from `tauri://localhost` and only learns which
 * NAS to call once the user says so, so it starts unconfigured.
 */
export function defaultServer(env: { native?: boolean; origin?: string } = {}): string {
  const native = env.native ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
  if (native) return '';
  const origin = env.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  return /^https?:$/.test(safeProtocol(origin)) ? origin.replace(/\/+$/, '') : '';
}

function safeProtocol(origin: string): string {
  try {
    return new URL(origin).protocol;
  } catch {
    return '';
  }
}

export const READER_THEMES = ['day', 'night', 'parchment', 'green'] as const;
export type ReaderTheme = (typeof READER_THEMES)[number];
export const READER_FONTS = ['serif', 'sans-serif', 'monospace'] as const;
export const READER_MODES = ['paginated', 'scroll'] as const;
/**
 * Page-turn animation. `simulation` is the paper turn, `cover`/`slide` are the cheap
 * modes and `none` swaps instantly. `scroll` reading ignores this (continuous flow).
 */
export const READER_FLIPS = ['simulation', 'cover', 'slide', 'none'] as const;
export type ReaderFlip = (typeof READER_FLIPS)[number];
export const READER_ALIGNS = ['justify', 'left'] as const;
export type ReaderAlign = (typeof READER_ALIGNS)[number];

export interface ReaderSettings {
  theme: ReaderTheme;
  size: number;
  lineHeight: number;
  font: string;
  mode: 'paginated' | 'scroll';
  flip: ReaderFlip;
  /** First-line indent in em (0 disables it), spec §9.3 default 2. */
  indent: number;
  /** Paragraph spacing in em (0 disables it), spec §9.3 range 0-2. */
  paraGap: number;
  align: ReaderAlign;
  /** TXT presentation only; source runes and files are never rewritten. */
  txtLayout: 'auto' | 'original';
}

/** Validate/clamp persisted or server-provided reader settings. */
export function readerSettings(input: Partial<ReaderSettings> = {}): ReaderSettings {
  const theme = READER_THEMES.includes(input.theme as ReaderTheme) ? (input.theme as ReaderTheme) : 'day';
  const font = READER_FONTS.includes(input.font as (typeof READER_FONTS)[number]) ? input.font! : 'serif';
  return {
    theme,
    size: Math.max(16, Math.min(36, Number(input.size) || 20)),
    lineHeight: Math.max(1.4, Math.min(2.4, Number(input.lineHeight) || 1.8)),
    font,
    mode: input.mode === 'scroll' ? 'scroll' : 'paginated',
    flip: READER_FLIPS.includes(input.flip as ReaderFlip) ? (input.flip as ReaderFlip) : 'simulation',
    indent: Math.max(0, Math.min(4, Number.isFinite(Number(input.indent)) ? Number(input.indent) : 2)),
    paraGap: Math.max(0, Math.min(2, Number.isFinite(Number(input.paraGap)) ? Number(input.paraGap) : 0)),
    align: READER_ALIGNS.includes(input.align as ReaderAlign) ? (input.align as ReaderAlign) : 'justify',
    txtLayout: input.txtLayout === 'original' ? 'original' : 'auto',
  };
}
