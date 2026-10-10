// Display-only TXT structure. Source line grouping owns every rune coordinate;
// formatting may join paragraph blocks, but never joins spans over hidden newlines.
import { runeLength } from './core';
import { paragraphGroups, type ParagraphGroup } from './paragraphs';

export interface FormattedParagraph extends ParagraphGroup {
  kind: 'body' | 'heading' | 'verse' | 'list';
}

const MAX_HEADING_RUNES = 48;
const MAX_VERSE_RUNES = 24;
const MIN_PROSE_RUNES = 40;
const CHINESE_HEADING = /^第[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟廿卅\d]{1,12}[章回节卷部篇](?:[\s:：、.．]+.*)?$/u;
const PREFACE_HEADING = /^(?:序章|序言|前言|前序|后序|后记|跋文|序|跋)(?:[\s:：、.．]+.*)?$/u;
const ENGLISH_HEADING = /^(?:chapter|volume|book|part)\s+(?:\d{1,4}|[ivxlcdm]{1,8})(?:[\s:：.\-]+.*)?$/iu;
const ENGLISH_PREFACE = /^(?:preface|foreword|afterword|prologue|epilogue)(?:\s*[:：]\s*.*)?$/iu;
const LIST_MARKER = /^(?:[-*+•●▪]\s+|\d{1,3}[.)、．]\s*(?!\d)|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]+[、.)）]\s*)\S/u;
const SENTENCE_END = /[。！？.!?…；;：:][”’"'）)\]】」』]*$/u;
const HAN = /\p{Script=Han}/gu;
const HAN_BOUNDARY_END = /[\p{Script=Han}，、]$/u;
const HAN_BOUNDARY_START = /^\p{Script=Han}/u;

function displayedText(group: ParagraphGroup): string {
  return group.segments.map((segment) => segment.text).join('');
}

function hasExplicitHeadingMarker(text: string): boolean {
  return CHINESE_HEADING.test(text) || PREFACE_HEADING.test(text) || ENGLISH_HEADING.test(text) || ENGLISH_PREFACE.test(text);
}

function isHeading(text: string): boolean {
  return runeLength(text) <= MAX_HEADING_RUNES && !/[。！？.!?]$/u.test(text) && hasExplicitHeadingMarker(text);
}

function isShortVerseCandidate(group: FormattedParagraph, text: string): boolean {
  const length = runeLength(text);
  // A short isolated line remains ordinary prose. A contiguous run can retain
  // poetry line styling; quoted dialogue and multiple sentences are left alone.
  return group.kind === 'body' && !group.stripped && length >= 3 && length <= MAX_VERSE_RUNES
    && group.segments.length === 1 && !/[“”「」『』"]/u.test(text);
}

function adjacent(left: ParagraphGroup, right: ParagraphGroup): boolean {
  // paragraphGroups excludes exactly the LF rune between source lines. A larger
  // gap means at least one blank/whitespace line and must remain a paragraph break.
  return right.start === left.end + 1;
}

function isLongCJKProse(text: string): boolean {
  const length = runeLength(text);
  const hanCount = text.match(HAN)?.length ?? 0;
  return length >= MIN_PROSE_RUNES && hanCount >= length * 0.7;
}

function canJoin(left: FormattedParagraph, right: FormattedParagraph, leftText: string, rightText: string): boolean {
  return left.kind === 'body' && right.kind === 'body' && !left.stripped && !right.stripped
    && adjacent(left, right) && isLongCJKProse(leftText) && isLongCJKProse(rightText)
    // A marker too long for heading styling still establishes a source boundary.
    && !hasExplicitHeadingMarker(leftText) && !hasExplicitHeadingMarker(rightText)
    && !SENTENCE_END.test(leftText) && HAN_BOUNDARY_END.test(leftText) && HAN_BOUNDARY_START.test(rightText);
}

/**
 * Format one complete reader slice. All starts/ends are relative to that exact
 * input, as in paragraphGroups; the reader adds its slice's global base itself.
 * Original mode preserves existing line paragraphs and indentation stripping.
 * Both modes assign span indices once across the complete slice for speech.
 */
export function formatTextGroups(text: string, mode: 'auto' | 'original' = 'auto'): FormattedParagraph[] {
  let sentenceIndex = 0;
  const groups: FormattedParagraph[] = paragraphGroups(text).map((group) => ({
    ...group,
    kind: 'body',
    segments: group.segments.map((segment) => ({ ...segment, index: sentenceIndex++ })),
  }));
  if (mode === 'original') return groups;

  // Trimming is used only to inspect structure. Every displayed span keeps the
  // original text, including internal/trailing spaces, CR and punctuation.
  const lines = groups.map((group) => displayedText(group).trim());
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    const line = lines[index]!;
    if (isHeading(line)) group.kind = 'heading';
    else if (LIST_MARKER.test(line)) group.kind = 'list';
  }

  for (let first = 0; first < groups.length;) {
    if (!isShortVerseCandidate(groups[first]!, lines[first]!)) {
      first++;
      continue;
    }
    let end = first + 1;
    while (end < groups.length && adjacent(groups[end - 1]!, groups[end]!)
      && isShortVerseCandidate(groups[end]!, lines[end]!)) end++;
    // Consecutive complete short prose sentences are not enough to infer verse.
    if (end - first >= 2 && lines.slice(first, end).some((line) => !SENTENCE_END.test(line))) {
      for (let index = first; index < end; index++) groups[index]!.kind = 'verse';
    }
    first = end;
  }

  const formatted: FormattedParagraph[] = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (index > 0 && canJoin(groups[index - 1]!, group, lines[index - 1]!, lines[index]!)) {
      const previous = formatted[formatted.length - 1]!;
      previous.end = group.end;
      previous.segments.push(...group.segments);
    } else {
      // Copy the array because a merged block must not change the original line
      // ranges used to decide whether the following source boundary can join.
      formatted.push({ ...group, segments: [...group.segments] });
    }
  }
  return formatted;
}
