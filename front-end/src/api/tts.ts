// Server speech engines: model discovery and the copy the panel needs when an
// engine is selected but unusable.
//
// The browser's built-in voices are the zero-configuration default and need no
// endpoint at all. `/tts/models` only exists for the optional OpenAI-compatible
// engines, and it answers 400 when nothing is enabled and 502 when the configured
// engine cannot be reached — both must become actionable Chinese text, never a
// raw transport error.
import {errorMessage} from './errors';

export type ServerEngine = 'edge' | 'custom';

export interface TtsModel {
  id: string;
}

export interface TtsModelList {
  items: TtsModel[];
  total: number;
}

/** The slice of ApiClient these helpers need; ApiClient satisfies it structurally. */
export interface TtsClient {
  get<T = any>(path: string): Promise<T>;
}



/** Path for the discovery call; the engine parameter is omitted when unknown. */
export function modelsPath(engine?: ServerEngine | ''): string {
  return engine === 'edge' || engine === 'custom' ? `/tts/models?engine=${engine}` : '/tts/models';
}

/** Tolerant parse: anything without usable ids becomes an empty list. */
export function parseModels(payload: unknown): TtsModel[] {
  const data = (payload as {items?: unknown} | null)?.items;
  if (!Array.isArray(data)) return [];
  const out: TtsModel[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const id = typeof entry === 'string' ? entry : String((entry as {id?: unknown} | null)?.id ?? '');
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push({id: trimmed});
  }
  return out;
}

export async function fetchTtsModels(api: TtsClient, engine?: ServerEngine | ''): Promise<TtsModel[]> {
  return parseModels(await api.get<TtsModelList>(modelsPath(engine)));
}

/** Hint shown in the reader when a server engine is selected but unusable. */
export function serverEngineHint(engine: ServerEngine): string {
  if (engine === 'edge') {
    return `内置中文朗读直接由 nasReader 提供，无需额外容器；请在「我的 → 服务器朗读引擎」启用，并检查服务器能否访问语音服务。也可以使用系统语音`;
  }
  return '自定义 HTTP TTS 需要在「我的 → 服务器朗读引擎」里填写兼容 OpenAI 的服务地址与模型；也可以直接用系统语音，无需配置';
}

/** Copy for a failed discovery call, differentiated by the server's status. */
export function modelsError(error: unknown, engine: ServerEngine = 'custom'): string {
  const status = Number((error as {status?: unknown} | null)?.status);
  const detail = errorMessage(error, '');
  if (status === 400) {
    return detail || `服务器朗读引擎尚未启用或未配置；${engine === 'edge' ? '请在「我的 → 服务器朗读引擎」启用内置中文朗读' : '请在「我的 → 服务器朗读引擎」里填写服务地址'}`;
  }
  if (status === 502) {
    return `无法从朗读服务读取模型列表：${detail || '服务不可达'}。请检查服务器网络与引擎设置，或直接用浏览器语音（无需配置）`;
  }
  return `获取模型失败：${detail || '请稍后重试'}`;
}
