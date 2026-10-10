// Server speech engines with a guaranteed browser-speech fallback.
//
// `edge` and `custom` are optional server engines (POST /tts/speak). They can be
// disabled, unreachable, unimplemented, or return audio the device refuses to play.
// In every one of those cases the reader must say what happened, switch to the
// device voice, and never stay in the "speaking" state without a pending utterance.
import { runeLength } from './core';
import { serverEngineHint } from '../api/tts';

export type SpeechEngine = 'browser' | 'edge' | 'custom';

export interface TtsEngines {
  edge_enabled: boolean;
  custom_enabled: boolean;
  has_api_key?: boolean;
}

export interface SpeechDecision {
  /** Engine that will actually be used. */
  engine: SpeechEngine;
  /** Human-readable reason when a server engine had to be dropped ('' otherwise). */
  notice: string;
}

const LABEL: Record<SpeechEngine, string> = {
  browser: '系统语音',
  edge: '内置中文朗读',
  custom: '服务器 HTTP TTS',
};

/**
 * Decide which engine to use. `engines === null` means GET /tts/engines could not
 * be read (missing route, offline): a server engine is then treated as unavailable.
 */
export function resolveSpeechEngine(requested: SpeechEngine, engines: TtsEngines | null): SpeechDecision {
  if (requested === 'browser') return { engine: 'browser', notice: '' };
  if (!engines) {
    return {
      engine: 'browser',
      notice: `朗读引擎配置暂不可用，已改用${LABEL.browser}。${serverEngineHint(requested)}`,
    };
  }
  const enabled = requested === 'edge' ? engines.edge_enabled === true : engines.custom_enabled === true;
  if (enabled) return { engine: requested, notice: '' };
  return {
    engine: 'browser',
    notice: `${LABEL[requested]}未启用，已改用${LABEL.browser}。${serverEngineHint(requested)}`,
  };
}

/**
 * Actionable hint for the 朗读 panel: empty while the requested engine is usable,
 * otherwise the exact instructions for that engine. The panel shows it before the
 * reader has to press anything, so an unconfigured NAS never looks like a bug.
 */
export function serverEngineIssue(requested: SpeechEngine, engines: TtsEngines | null): string {
  if (requested === 'browser') return '';
  if (engines && (requested === 'edge' ? engines.edge_enabled === true : engines.custom_enabled === true)) return '';
  return serverEngineHint(requested);
}

export interface ReaderPosition {
  chapter_idx: number;
  page: number;
  sliceStart: number;
  sliceEnd: number;
  locator: string;
}

/**
 * True when navigation actually moved the reading position. The speech loop uses it
 * before continuing into the next page/chapter: at the end of the book `next()` is a
 * no-op, and re-speaking sentence 0 there would trap the reader in an endless loop.
 */
export function speechAdvanced(before: ReaderPosition, after: ReaderPosition): boolean {
  return (
    before.chapter_idx !== after.chapter_idx ||
    before.page !== after.page ||
    before.sliceStart !== after.sliceStart ||
    before.sliceEnd !== after.sliceEnd ||
    before.locator !== after.locator
  );
}

/**
 * Watchdog for one server-audio sentence. Chinese TTS averages roughly five runes
 * per second; the extra margin covers buffering and slow NAS transcoding.
 */
export function audioWatchdogMs(text: string, rate: number): number {
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const estimated = Math.round((runeLength(text) / 5) * 1000 / speed) + 4000;
  return Math.max(5000, Math.min(120000, estimated || 5000));
}

/** A browser utterance that never fires `onstart` within this window is unusable. */
export const speechStartTimeoutMs = 4000;

/** Continuation is attempted once per sentence; this bounds a stuck chain. */
export const maxSpeechContinuations = 10000;
