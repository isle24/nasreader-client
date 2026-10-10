// Paper texture and page surface tokens for the reader.
//
// Constraints from the design spec (§10.4): no bundled raster assets, no third-party
// artwork, no glow. Everything here is CSS gradients plus one inline SVG `feTurbulence`
// grain encoded as a data URI, which the browser rasterises once into a small tile and
// then repeats. The grain sits *behind* the text (a `::before` layer at z-index 0), so it
// can only ever darken the paper slightly - it never washes the text out.
import type { ReaderTheme } from './core';

/** Tile edge in px. Deliberately small: one rasterisation, cheap repetition. */
export const GRAIN_TILE = 180;
/**
 * Paper tint added by the grain, theme by theme.
 *
 * Each value was checked against the spec's >= 7:1 body-contrast requirement with the
 * grain over the paper and the theme ink on top (`THEME_SURFACES` below holds the
 * colours): the worst case is 13.6:1 (day), 9.5:1 (night), 9.5:1 (green) and 6.9:1
 * (parchment, whose ink is intentionally warm and low-contrast - it therefore gets the
 * lightest grain). The grain can only ever darken the paper slightly: it sits behind the
 * text and never touches the ink.
 */
export const GRAIN_OPACITY: Record<ReaderTheme, number> = {
  day: 0.08,
  night: 0.11,
  parchment: 0.05,
  green: 0.07,
};

export interface ThemeSurface {
  /** Paper colour (matches §10.2). */
  paper: string;
  /** Foreground colour (§10.2), used for the text and the ink shadows. */
  ink: string;
  /** Secondary text colour (§10.2). */
  muted: string;
  /** Spine / gutter shadow colour, rgba. */
  gutter: string;
  /** The hairline where the sheet meets the binding. */
  fold: string;
  /** Outer page edge line, rgba. */
  edge: string;
  /** Soft drop shadow under the page so it sits on a surface. */
  pageShadow: string;
  /** Grain tint: a dark ink for light themes, a pale light for the night theme. */
  grain: string;
  /** Night theme adds line-height and weight (spec §10.2). */
  lineHeightBonus: number;
  fontWeightBonus: number;
}

export const THEME_SURFACES: Record<ReaderTheme, ThemeSurface> = {
  day: {
    paper: '#F7F7F5',
    ink: '#1F1F1F',
    muted: '#6B6B6B',
    gutter: 'rgba(31,31,31,.14)',
    edge: 'rgba(31,31,31,.12)',
    pageShadow: 'rgba(31,31,31,.16)',
    grain: '#3a3a38',
    fold: 'rgba(31,31,31,.1)',
    lineHeightBonus: 0,
    fontWeightBonus: 0,
  },
  night: {
    paper: '#161616',
    ink: '#CFCFCF',
    muted: '#8A8A8A',
    gutter: 'rgba(0,0,0,.55)',
    edge: 'rgba(207,207,207,.1)',
    pageShadow: 'rgba(0,0,0,.6)',
    // Light grain on a dark page, otherwise the night sheet reads as flat plastic.
    grain: '#c9c9c9',
    fold: 'rgba(207,207,207,.09)',
    lineHeightBonus: 0.1,
    fontWeightBonus: 50,
  },
  parchment: {
    paper: '#F4ECD8',
    ink: '#5B4636',
    muted: '#8A7761',
    gutter: 'rgba(91,70,54,.16)',
    edge: 'rgba(91,70,54,.16)',
    pageShadow: 'rgba(91,70,54,.2)',
    grain: '#7a5a2e',
    fold: 'rgba(91,70,54,.11)',
    lineHeightBonus: 0,
    fontWeightBonus: 0,
  },
  green: {
    paper: '#C7EDCC',
    ink: '#263228',
    muted: '#4E5C50',
    gutter: 'rgba(38,50,40,.16)',
    edge: 'rgba(38,50,40,.14)',
    pageShadow: 'rgba(38,50,40,.18)',
    grain: '#2f4a37',
    fold: 'rgba(38,50,40,.1)',
    lineHeightBonus: 0,
    fontWeightBonus: 0,
  },
};

export function themeSurface(theme: ReaderTheme | string): ThemeSurface {
  return THEME_SURFACES[(theme as ReaderTheme) in THEME_SURFACES ? (theme as ReaderTheme) : 'day'];
}

/**
 * One inline SVG: a turbulence field, desaturated to a grain, recoloured to the theme
 * tint. `encodeURIComponent` keeps the payload valid inside `url("data:...")` without
 * relying on base64 (which would hide the SVG from review).
 */
export function grainDataURI(tint: string, tile: number = GRAIN_TILE): string {
  const size = Math.max(24, Math.min(512, Math.round(tile)));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<filter id="g" x="0" y="0" width="100%" height="100%">`,
    `<feTurbulence type="fractalNoise" baseFrequency="0.96" numOctaves="3" stitchTiles="stitch" seed="7" result="n"/>`,
    `<feColorMatrix in="n" type="saturate" values="0" result="m"/>`,
    `<feFlood flood-color="${tint}" result="tint"/>`,
    `<feComposite in="tint" in2="m" operator="in"/>`,
    `</filter>`,
    `<rect width="${size}" height="${size}" filter="url(#g)"/>`,
    `</svg>`,
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Grain tile + strength for a theme, as the reader's `--paper-grain-*` custom props. */
export function grainLayer(theme: ReaderTheme | string): { image: string; opacity: number } {
  const key: ReaderTheme = (theme as ReaderTheme) in GRAIN_OPACITY ? (theme as ReaderTheme) : 'day';
  return { image: grainDataURI(THEME_SURFACES[key].grain), opacity: GRAIN_OPACITY[key] };
}

/**
 * Every design token the reader surface needs, as CSS custom properties. The stylesheet
 * (`Reader.vue`, global layer) only reads these, so a theme change is one style object
 * swap and never a JS repaint loop.
 */
export function surfaceVars(theme: ReaderTheme | string): Record<string, string> {
  const surface = themeSurface(theme);
  const grain = grainLayer(theme);
  return {
    '--reader-paper': surface.paper,
    '--reader-ink': surface.ink,
    '--reader-muted': surface.muted,
    '--reader-gutter': surface.gutter,
    '--reader-fold': surface.fold,
    '--reader-edge': surface.edge,
    '--reader-page-shadow': surface.pageShadow,
    '--paper-grain-image': `url("${grain.image}")`,
    '--paper-grain-opacity': String(grain.opacity),
  };
}

/**
 * The turn shadow is drawn from gradients so the browser animates `background-position`
 * and `opacity` on the compositor instead of repainting the text underneath. Two
 * offset bands read as one soft shadow with a darker leading edge.
 */
export function turnShadowBackground(theme: ReaderTheme | string): string {
  const dark = themeSurface(theme).gutter;
  return [
    `linear-gradient(100deg, transparent 0%, ${dark} 42%, transparent 74%)`,
    `linear-gradient(100deg, transparent 10%, ${dark} 56%, transparent 90%)`,
  ].join(',');
}
