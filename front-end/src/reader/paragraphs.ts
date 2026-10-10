// Paragraph structure for the TXT reader: keeps the rune-offset contract while letting
// the reader style real paragraphs (first-line indent, paragraph spacing).
//
// The reader used to render one flat run of sentence spans, so every paragraph was a
// line break in a `white-space: pre-wrap` box and no paragraph-level typography was
// possible. Grouping the same sentence segmentation under paragraph blocks changes only
// the DOM shape: every rune still belongs to exactly one span, spans stay in document
// order, and `data-offset` is still the global rune offset of the span start. The
// pagination table (src/reader/pagination.ts) therefore keeps producing the identical
// `c:<rune>` locators.
import { runeLength, sentenceSegments, type SentenceSegment } from './core';

/** Runs that never carry content of their own: pure line breaks / blank lines. */
const WHITESPACE = /^[\s\u3000]*$/;

export interface ParagraphGroup {
  /** Rune offset of the paragraph start, relative to the segmented text. */
  start: number;
  /** Rune offset just past the paragraph end. */
  end: number;
  /** Sentences to render, each with the same rune coordinates as `sentenceSegments`. */
  segments: SentenceSegment[];
  /** True when the paragraph began with ideographic spaces that were stripped. */
  stripped: boolean;
}

export interface ParagraphOptions {
  /**
   * Remove the 全角空格 / ASCII spaces a plain-text file already uses for indentation.
   * Required by spec §9.3: with `text-indent` applied on top they would double-indent.
   * The removed runes stay inside the paragraph's `[start,end)` range, so offsets do not
   * move - only the rendered text loses them.
   */
  stripIndent?: boolean;
  /** Rune offset of the first character of `text` in the whole book. */
  base?: number;
}

/** Rune offset of the first non-space character of `text` (0 when it is all spaces). */
export function leadingSpaceRunes(text: string): number {
  let count = 0;
  for (const rune of text) {
    if (rune !== ' ' && rune !== '\u3000' && rune !== '\t') break;
    count++;
  }
  return count;
}

/**
 * Split text into paragraphs, then into sentence spans inside them.
 *
 * One source line is one paragraph: Chinese novels - the shape this reader is built for -
 * put exactly one paragraph per line and separate paragraphs with a blank line. Blank
 * lines are therefore dropped as content, and their runes stay covered by the range
 * between the neighbouring paragraphs.
 */
export function paragraphGroups(text: string, options: ParagraphOptions = {}): ParagraphGroup[] {
  const value = typeof text === 'string' ? text : '';
  const base = Number(options.base) || 0;
  const strip = options.stripIndent !== false;
  const groups: ParagraphGroup[] = [];
  const lines = value.split('\n');
  let lineStart = base;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const next = lineStart + runeLength(line) + (index < lines.length - 1 ? 1 : 0);
    if (!WHITESPACE.test(line)) {
      const skip = strip ? Math.min(leadingSpaceRunes(line), line.length) : 0;
      const shown = line.slice(skip);
      if (shown && !WHITESPACE.test(shown)) {
        groups.push({
          start: lineStart,
          end: lineStart + runeLength(line),
          segments: sentenceSegments(shown, lineStart + skip),
          stripped: skip > 0,
        });
      }
    }
    lineStart = next;
  }
  return groups;
}
