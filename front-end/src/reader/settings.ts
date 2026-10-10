// Reading settings: per server + account persistence, server sync and the styles
// that carry the settings into EPUB/PDF rendering.
//
// The key must include the server AND the user id: two family members share one
// browser on one NAS, and the same account can point at two servers.
import { readerSettings, type ReaderSettings, type ReaderTheme } from './core';

export const READER_SETTINGS_PREFIX = 'nasreader.reader:';

export function readerSettingsKey(server: string, userId: number | string | null | undefined): string {
  return `${READER_SETTINGS_PREFIX}${server || ''}:${userId ?? ''}`;
}

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Stored settings for this server+account, or null when absent/corrupt. */
export function loadReaderSettings(
  storage: SettingsStorage,
  server: string,
  userId: number | string | null | undefined,
): ReaderSettings | null {
  try {
    const raw = storage.getItem(readerSettingsKey(server, userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return readerSettings(parsed as Partial<ReaderSettings>);
  } catch {
    return null;
  }
}

export function saveReaderSettings(
  storage: SettingsStorage,
  server: string,
  userId: number | string | null | undefined,
  value: Partial<ReaderSettings>,
): ReaderSettings {
  const settings = readerSettings(value);
  storage.setItem(readerSettingsKey(server, userId), JSON.stringify(settings));
  return settings;
}

/**
 * Accept both the documented envelope `{reader:{...}}` and a flat settings object
 * from GET/PUT /me/settings. Unknown shapes yield null so the caller keeps the
 * device-local values instead of inventing defaults.
 */
export function serverReaderSettings(payload: unknown): ReaderSettings | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nested = record.reader;
  if (nested && typeof nested === 'object') return readerSettings(nested as Partial<ReaderSettings>);
  if (['theme', 'size', 'lineHeight', 'font', 'mode', 'flip', 'indent', 'txtLayout'].some((k) => k in record))
    return readerSettings(record as Partial<ReaderSettings>);
  return null;
}

/** Device-local settings win; otherwise the account's server copy; else defaults. */
export function resolveReaderSettings(
  local: ReaderSettings | null,
  remote: ReaderSettings | null,
): ReaderSettings {
  return local ?? remote ?? readerSettings();
}

export interface ThemeColors {
  foreground: string;
  background: string;
  link: string;
}

const THEME_COLORS: Record<ReaderTheme, ThemeColors> = {
  day: { foreground: '#1f1f1f', background: '#f7f7f5', link: '#1c5d4f' },
  night: { foreground: '#cfcfcf', background: '#161616', link: '#8fc7b4' },
  parchment: { foreground: '#5b4636', background: '#f4ecd8', link: '#7a5a2e' },
  green: { foreground: '#263228', background: '#c7edcc', link: '#1f5c46' },
};

export function readerThemeColors(theme: ReaderTheme): ThemeColors {
  return THEME_COLORS[theme] ?? THEME_COLORS.day;
}

/**
 * CSS injected into the EPUB document (foliate renderer.setStyles). EPUB keeps its
 * own layout, so only typography and colors are overridden - and with `!important`
 * because publisher styles are often equally specific.
 */
export function epubStyleSheet(settings: ReaderSettings): string {
  const colors = readerThemeColors(settings.theme);
  const family =
    settings.font === 'serif'
      ? 'serif'
      : settings.font === 'monospace'
        ? 'ui-monospace, monospace'
        : 'system-ui, sans-serif';
  return [
    `html { font-size: ${settings.size}px !important; line-height: ${settings.lineHeight} !important;`,
    ` font-family: ${family} !important; color: ${colors.foreground} !important;`,
    ` background: ${colors.background} !important; }`,
    `body { color: ${colors.foreground} !important; background: transparent !important; }`,
    `a, a:visited { color: ${colors.link} !important; }`,
    'img, svg, video { max-width: 100% !important; height: auto !important; }',
    '::selection { background: #b8d9c2; color: #233429; }',
  ].join('\n');
}

/**
 * PDFs are fixed-layout scans/documents: typography cannot be reflowed, so only the
 * night theme is adapted (inverted luminance) on the rendering canvas.
 */
export function pdfCanvasFilter(theme: ReaderTheme): string {
  return theme === 'night' ? 'invert(0.92) hue-rotate(180deg)' : 'none';
}
