// Touch gestures for the reader.
//
// The previous inline handler only looked at the horizontal delta, so a
// horizontal flick in the vertical-scroll mode turned pages instead of
// scrolling, and a vertical flick in the paginated modes did nothing at all.
// This module keeps the decision pure so it can be unit-tested: the reader only
// applies the returned intent.

export interface TouchPoint {
  x: number;
  y: number;
}

export interface SwipeOptions {
  /** Movement (px) required before a gesture counts as a swipe. */
  distance?: number;
  /** Slop (px) the perpendicular axis may drift before the gesture is ambiguous. */
  slop?: number;
  /** Gestures slower than this are drags/selects, not page turns. */
  maxDurationMs?: number;
}

export type SwipeIntent =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'none'; reason: 'too-short' | 'too-slow' | 'ambiguous' | 'vertical-scroll' };

const DEFAULTS = { distance: 48, slop: 40, maxDurationMs: 700 };

/**
 * Classify one touch gesture.
 *
 * `verticalScroll` is passed by the reader when the continuous vertical mode is
 * active: there, a horizontal flick must never turn a page, and vertical motion
 * belongs to the scroller.
 */
export function resolveSwipe(
  start: TouchPoint,
  end: TouchPoint,
  durationMs: number,
  verticalScroll = false,
  options: SwipeOptions = {},
): SwipeIntent {
  const distance = options.distance ?? DEFAULTS.distance;
  const slop = options.slop ?? DEFAULTS.slop;
  const maxDuration = options.maxDurationMs ?? DEFAULTS.maxDurationMs;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { kind: 'none', reason: 'too-short' };
  // A long press followed by a drag is a selection, not a page turn.
  if (durationMs > maxDuration) return { kind: 'none', reason: 'too-slow' };
  // Vertical motion is the scroller's job in vertical mode, and in the paginated
  // modes it is either a scroll attempt or a mis-tap; never a page turn.
  if (absY > absX) return { kind: 'none', reason: verticalScroll ? 'vertical-scroll' : 'ambiguous' };
  if (absX < distance) return { kind: 'none', reason: 'too-short' };
  // Ambiguous diagonal: neither axis clearly dominates.
  if (absY > slop) return { kind: 'none', reason: 'ambiguous' };

  // Chinese and Japanese books read left-to-right here, matching the on-screen
  // 上一页/下一页 buttons: swipe left (content moves left) advances.
  return dx < 0 ? { kind: 'next' } : { kind: 'prev' };
}

/** Wheel/trackpad panning, mapped the same way as a swipe. */
export function resolveWheel(deltaX: number, deltaY: number, verticalScroll = false): SwipeIntent {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return { kind: 'none', reason: 'too-short' };
  if (verticalScroll) return { kind: 'none', reason: 'vertical-scroll' };
  if (Math.abs(deltaY) > Math.abs(deltaX)) return { kind: 'none', reason: 'ambiguous' };
  if (Math.abs(deltaX) < 24) return { kind: 'none', reason: 'too-short' };
  // A wheel/trackpad pan to the right means the content moved right, i.e. back.
  return deltaX > 0 ? { kind: 'prev' } : { kind: 'next' };
}

/* ---------- taps (immersive chrome) ----------
   The reader shows only the book text; a tap is what reveals the bars. A tap must be
   told apart from every gesture that already has a meaning: a swipe (page turn), a long
   press or drag (text selection) and a vertical drag in the scroll mode. The two
   helpers below are pure so the thresholds are unit-tested instead of living in the
   event handler. */

export interface TapOptions {
  /** A press held longer than this is a long press/selection, not a tap. */
  maxDurationMs?: number;
  /** Movement (px) a press may make and still count as a tap. */
  slop?: number;
}

const TAP_DEFAULTS = { maxDurationMs: 250, slop: 12 };

/** True when a press/release pair is a tap: short and almost motionless. */
export function isTap(
  start: TouchPoint,
  end: TouchPoint,
  durationMs: number,
  options: TapOptions = {},
): boolean {
  const maxDuration = options.maxDurationMs ?? TAP_DEFAULTS.maxDurationMs;
  const slop = options.slop ?? TAP_DEFAULTS.slop;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(durationMs)) return false;
  if (durationMs < 0 || durationMs > maxDuration) return false;
  return Math.hypot(dx, dy) <= slop;
}

/** Horizontal zones of a tap: the outer 30% turns a page, the middle 40% toggles. */
export type TapZone = 'prev' | 'next' | 'toggle';

/** Fraction of the reader width owned by each page-turn zone. */
export const TAP_EDGE_RATIO = 0.3;

/** Classify the horizontal position of a tap, relative to the reader's own box. */
export function tapZone(x: number, width: number): TapZone {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 'toggle';
  const ratio = x / width;
  if (ratio < TAP_EDGE_RATIO) return 'prev';
  if (ratio > 1 - TAP_EDGE_RATIO) return 'next';
  return 'toggle';
}

/**
 * In the continuous vertical mode a vertical flick only continues the book when
 * the reader is already at that end of the scroll area; everywhere else the
 * scroller owns the gesture.
 */
export function resolveVerticalContinue(
  start: TouchPoint,
  end: TouchPoint,
  durationMs: number,
  bounds: { atTop: boolean; atBottom: boolean },
  options: SwipeOptions = {},
): SwipeIntent {
  const distance = options.distance ?? DEFAULTS.distance;
  const maxDuration = options.maxDurationMs ?? DEFAULTS.maxDurationMs;
  const dy = end.y - start.y;
  const dx = end.x - start.x;
  if (!Number.isFinite(dy) || !Number.isFinite(dx) || durationMs > maxDuration) {
    return { kind: 'none', reason: 'too-short' };
  }
  if (Math.abs(dy) < distance || Math.abs(dx) > Math.abs(dy)) return { kind: 'none', reason: 'ambiguous' };
  if (dy < 0 && bounds.atBottom) return { kind: 'next' };
  if (dy > 0 && bounds.atTop) return { kind: 'prev' };
  return { kind: 'none', reason: 'vertical-scroll' };
}
