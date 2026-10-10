// Page-turn animation: mode resolution and the (DOM-free) animation plan.
//
// This module exists for two reasons:
//   1. the mode a device actually gets (explicit choice vs. reduced motion vs. low-end
//      hardware) is pure logic and belongs in a unit test, not in a component;
//   2. the page turn must only ever animate `transform` / `opacity`, and it must never
//      change the page index while the locator can be read differently. Both halves of
//      that contract are expressed here as data (`animatedProperties`, `stages`) so the
//      test suite can assert them without a browser.
//
// Visual model of `simulation` (the flagship mode): the page is hinged at the spine
// edge, so the turn is a 3D perspective rotation around that edge plus the sweep to the
// next slot, the incoming page settles from a small residual rotation, and a soft
// shadow layer travels across the page while it moves. The outgoing page and the
// incoming page are the same element (the measured column block) - a DOM snapshot was
// rejected on purpose, because duplicating the `[data-offset]` spans would give the
// pagination table two sources of truth.

export const FLIP_MODES = ['simulation', 'cover', 'slide', 'none'] as const;
export type FlipMode = (typeof FLIP_MODES)[number];

export const FLIP_LABELS: Record<FlipMode, string> = {
  simulation: '仿真翻页（纸页抬起）',
  cover: '横滑（新页覆盖）',
  slide: '横滑（整页平移）',
  none: '横滑（无动效）',
};

export const DEFAULT_FLIP: FlipMode = 'simulation';

export interface DeviceHints {
  /** navigator.hardwareConcurrency; 0/undefined means unknown. */
  hardwareConcurrency?: number;
  /** navigator.deviceMemory (GiB); 0/undefined means unknown. */
  deviceMemory?: number;
}

export interface MotionHints extends DeviceHints {
  /** matchMedia('(prefers-reduced-motion: reduce)').matches */
  reducedMotion?: boolean;
}

/** True when the device looks too weak for per-page 3D compositing. */
export function lowEndDevice(hints: DeviceHints = {}): boolean {
  const cores = Number(hints.hardwareConcurrency) || 0;
  const memory = Number(hints.deviceMemory) || 0;
  if (cores > 0 && cores <= 4) return true;
  if (memory > 0 && memory <= 2) return true;
  return false;
}

/**
 * The mode actually used for a turn.
 *
 * - `prefers-reduced-motion: reduce` always wins: instant swap, no transition.
 * - an explicit user choice is never second-guessed;
 * - an untouched (`automatic`) setting falls back to no animation on low-end hardware,
 *   which is exactly the spec's "低端机默认无动画" without asking the user anything.
 */
export function resolveFlipMode(
  saved: FlipMode | undefined,
  hints: MotionHints & { automatic?: boolean } = {},
): FlipMode {
  const mode = FLIP_MODES.includes(saved as FlipMode) ? (saved as FlipMode) : DEFAULT_FLIP;
  if (hints.reducedMotion) return 'none';
  if (hints.automatic !== false && lowEndDevice(hints)) return 'none';
  return mode;
}

/** Current device hints, safely defaulted in non-browser environments. */
export function deviceMotionHints(
  nav: Partial<Navigator> = {},
): Required<DeviceHints> & { reducedMotion: boolean } {
  const target = nav as DeviceHints;
  let reducedMotion = false;
  try {
    reducedMotion = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    reducedMotion = false;
  }
  return {
    hardwareConcurrency: Number(target.hardwareConcurrency) || 0,
    deviceMemory: Number(target.deviceMemory) || 0,
    reducedMotion,
  };
}

/* ------------------------------- the plan -------------------------------- */

export interface FlipKeyframe {
  transform?: string;
  opacity?: number;
  /** Percentage position of a gradient stop pair (shadow sweep only). */
  backgroundPosition?: string;
  /** Keyframe position 0..1; omitted means evenly distributed. */
  offset?: number;
}

export interface FlipTiming {
  duration: number;
  easing: string;
  fill: 'forwards';
}

export interface FlipStage {
  /** Milliseconds from the start of the turn at which this stage happens. */
  at: number;
  action: 'swap' | 'settle' | 'cleanup';
}

export interface FlipPlan {
  mode: FlipMode;
  direction: 'forward' | 'back';
  /** Slot width in px (viewport width); the page sweep is a multiple of it. */
  pageWidth: number;
  /** The measured column block: the outgoing page and the incoming page. */
  content: { keyframes: FlipKeyframe[]; timing: FlipTiming };
  /** Soft shadow sweep over the page while it turns. */
  shadow: { keyframes: FlipKeyframe[]; timing: FlipTiming };
  /** When the DOM page index may change, and when the turn is over. */
  stages: FlipStage[];
}

/** Total budget from the design spec: page turns stay at or below 300 ms. */
export const FLIP_DURATION_MS = { simulation: 280, cover: 220, slide: 200, none: 0 } as const;
/** Build gate: nothing else may appear in an animated keyframe. */
export const FLIP_ANIMATED_PROPERTIES = ['backgroundPosition', 'opacity', 'transform'] as const;
export const FLIP_EASING = 'cubic-bezier(.22,1,.36,1)';
/** Hinge of the page: the spine edge of the slot. */
export const FLIP_ORIGIN = 'right center';
/**
 * Fraction of a simulation turn during which the page is held still while the sheet
 * lifts and the shadow builds. The `swap` stage is placed on this frame.
 */
export const FLIP_HOLD_OFFSET = 0.44;

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/**
 * Keyframes for one page turn. Pure: same inputs, same plan, no DOM access.
 *
 * Geometry: the slot is the viewport, its spine edge is on the left (Chinese books open
 * left-to-right) and the page is hinged on the right edge, so a turn is a rotation
 * around that hinge plus the translation into the next slot.
 */
export function flipPlan(mode: FlipMode, direction: 'forward' | 'back', pageWidth: number): FlipPlan {
  const resolved: FlipMode = FLIP_MODES.includes(mode) ? mode : DEFAULT_FLIP;
  const width = isPositive(pageWidth) ? pageWidth : 0;
  const ratio = direction === 'forward' ? -1 : 1;
  const duration = FLIP_DURATION_MS[resolved];
  const stages: FlipStage[] = [];

  if (resolved === 'none' || duration <= 0) {
    stages.push({ at: 0, action: 'swap' }, { at: 0, action: 'cleanup' });
    const instant: FlipTiming = { duration: 0, easing: 'linear', fill: 'forwards' };
    const still: FlipKeyframe[] = [{ opacity: 1 }, { opacity: 1 }];
    const hidden: FlipKeyframe[] = [{ opacity: 0 }, { opacity: 0 }];
    return {
      mode: 'none',
      direction,
      pageWidth: width,
      content: { keyframes: still, timing: instant },
      shadow: { keyframes: hidden, timing: instant },
      stages,
    };
  }

  const easeOut: FlipTiming = { duration, easing: FLIP_EASING, fill: 'forwards' };

  if (resolved === 'simulation') {
    // A paper turn within the 280 ms budget, in two beats:
    //   1. the page lifts: a narrow dark band appears along the spine edge and the page
    //      starts to move;
    //   2. the page leaves: the block travels exactly one slot - the same distance the
    //      instant swap covers - the shadow washes across the incoming page and dies
    //      away. Because the end frame is the identity and the time curve is ease-out,
    //      the page appears to settle rather than stop.
    //
    // Measured in Chromium at 1280x800, two alternatives were tried and rejected:
    //   * a rotateY on the whole column block: the block is several slots wide, so the
    //     rotation magnified the column entering at the spine into a visible bulge;
    //   * a separate 3D "sheet" element hinged at the spine: it had no text of its own
    //     (a DOM snapshot would duplicate the `[data-offset]` spans the page table is
    //     built from), so it hid the outgoing page correctly but revealed the incoming
    //     page early as a grey band and made every turn look like a grey flash. The
    //     shadow-only sweep keeps the paper opaque and the two pages unambiguous.
    // `FLIP_HOLD_OFFSET` is the frame the page rests on while the shadow builds up. The
    // swap stage is derived from it, so the reading offset changes at the exact instant
    // the animation is stationary: nothing can jump on screen, and the locator that is
    // saved is the one for the page that is (still) fully visible.
    const content: FlipKeyframe[] = [
      { transform: 'translate3d(0,0,0)', opacity: 1 },
      { transform: 'translate3d(0,0,0)', opacity: 1, offset: FLIP_HOLD_OFFSET },
      { transform: `translate3d(${px(ratio * width * 0.5)},0,0)`, opacity: 1, offset: 0.72 },
      { transform: `translate3d(${px(ratio * width)},0,0)`, opacity: 1 },
    ];
    // A narrow dark band hugging the spine edge, then a soft wash over the incoming
    // page: a full-width veil (the first attempt) dimmed the whole page and read as a
    // grey flash rather than a shadow.
    const shadow: FlipKeyframe[] = [
      { opacity: 0, backgroundPosition: ratio < 0 ? '150% 0' : '-50% 0' },
      { opacity: 0.8, backgroundPosition: ratio < 0 ? '124% 0' : '-24% 0', offset: 0.36 },
      { opacity: 0.42, backgroundPosition: ratio < 0 ? '72% 0' : '28% 0', offset: 0.62 },
      { opacity: 0.14, backgroundPosition: ratio < 0 ? '28% 0' : '72% 0', offset: 0.86 },
      { opacity: 0, backgroundPosition: ratio < 0 ? '-50% 0' : '150% 0' },
    ];
    stages.push({ at: Math.round(duration * FLIP_HOLD_OFFSET), action: 'swap' }, { at: duration, action: 'settle' });
    return {
      mode: 'simulation',
      direction,
      pageWidth: width,
      content: { keyframes: content, timing: easeOut },
      shadow: { keyframes: shadow, timing: easeOut },
      stages,
    };
  }

  if (resolved === 'cover') {
    // The incoming page slides in over the outgoing one: transform + opacity only.
    const content: FlipKeyframe[] = [
      { transform: `translate3d(${px(ratio * width)},0,0)`, opacity: 0.2 },
      { transform: `translate3d(${px(ratio * width * 0.45)},0,0)`, opacity: 0.85, offset: 0.6 },
      { transform: 'translate3d(0,0,0)', opacity: 1 },
    ];
    const shadow: FlipKeyframe[] = [{ opacity: 0 }, { opacity: 0.14, offset: 0.45 }, { opacity: 0 }];
    stages.push({ at: Math.round(duration * 0.45), action: 'swap' }, { at: duration, action: 'settle' });
    return {
      mode: 'cover',
      direction,
      pageWidth: width,
      content: { keyframes: content, timing: easeOut },
      shadow: { keyframes: shadow, timing: easeOut },
      stages,
    };
  }

  // slide: both pages travel together; no shadow, no fading, no 3D.
  const content: FlipKeyframe[] = [
    { transform: `translate3d(${px(ratio * width)},0,0)`, opacity: 1 },
    { transform: 'translate3d(0,0,0)', opacity: 1 },
  ];
  const shadow: FlipKeyframe[] = [{ opacity: 0 }, { opacity: 0 }];
  stages.push({ at: Math.round(duration * 0.45), action: 'swap' }, { at: duration, action: 'settle' });
  return {
    mode: 'slide',
    direction,
    pageWidth: width,
    content: { keyframes: content, timing: easeOut },
    shadow: { keyframes: shadow, timing: easeOut },
    stages,
  };
}

/**
 * Runs a plan's stages exactly once each.
 *
 * The reader reaches the `swap` stage from two directions - the stage timer and the
 * post-animation settle, whichever is later - and applying it twice advanced the book by
 * two pages for a single tap (found in the browser, fixed by routing both through this
 * guard). The guard is exported so the unit test can pin that behaviour down without a
 * DOM.
 */
export function createStageRunner(): (plan: FlipPlan, action: FlipStage['action']) => FlipStage | undefined {
  const done = new Set<string>();
  return (plan, action) => {
    const stage = plan.stages.find((candidate) => candidate.action === action);
    if (!stage) return undefined;
    const key = `${plan.mode}:${action}`;
    if (done.has(key)) return undefined;
    done.add(key);
    return stage;
  };
}

/** Every CSS property name a plan animates; the unit test uses this as a build gate. */
export function animatedProperties(plan: FlipPlan): string[] {
  const names = new Set<string>();
  for (const track of [plan.content, plan.shadow]) {
    for (const frame of track.keyframes) {
      for (const key of Object.keys(frame)) {
        // `offset` is a keyframe timeline position, not a CSS property.
        if (key !== 'offset') names.add(key);
      }
    }
  }
  return [...names].sort();
}

/**
 * Final transform of the incoming page: the identity, i.e. the reading position the
 * reader must be in when the turn ends. A save that runs while an animation is in
 * flight still reads the page table, so it can never observe a half-turned page.
 */
export function settledTransform(plan: FlipPlan): string {
  const frames = plan.content.keyframes;
  return frames[frames.length - 1]?.transform ?? 'translate3d(0,0,0)';
}

/** Numeric parts of a `translate3d(x,y,z) rotateY(a)` string, for assertions. */
export function parseFlipTransform(value: string): { x: number; y: number; z: number; rotate: number } {
  const translate = /translate3d\(\s*(-?[\d.]+)(?:px)?\s*,\s*(-?[\d.]+)(?:px)?\s*,\s*(-?[\d.]+)(?:px)?\s*\)/.exec(value);
  const rotate = /rotateY\(\s*(-?[\d.]+)(?:deg)?\s*\)/.exec(value);
  return {
    x: Number(translate?.[1] ?? 0),
    y: Number(translate?.[2] ?? 0),
    z: Number(translate?.[3] ?? 0),
    rotate: Number(rotate?.[1] ?? 0),
  };
}

/** True when a plan would visibly move the page (used to skip work entirely). */
export function planMoves(plan: FlipPlan): boolean {
  return plan.content.timing.duration > 0;
}
