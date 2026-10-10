// Admin metadata scraper helpers (/#/admin/metadata).
//
// The page configures the optional AI assistant and drives the library-wide
// scrape queue. Everything that must be right without a browser lives here: the
// request bodies, the model-list normalisation, the queue-status folding and the
// confirmation copy for the two AI modes. The component stays thin and these
// helpers are unit tested directly.
import {ApiError} from './client';

export type ScrapeProvider = 'embedded' | 'filename' | 'openlibrary' | 'google' | 'neodb' | 'ai';
export type ScrapeFilter = '' | 'all' | 'no_author' | 'no_description' | 'no_cover' | 'never_scraped';
export type QueueStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AIProvider = 'openai' | 'anthropic' | 'custom';
export type AIMode = 'retry_failed' | 'all';

/** The subset of ApiClient this page uses (kept structural so tests can fake it). */
export interface MetadataClient {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  delete<T = any>(path: string): Promise<T>;
  /** Raw-body requests (cover upload); ApiClient provides it, fakes may omit it. */
  request?<T = any>(path: string, options?: RequestInit): Promise<T>;
}

export interface AIConfig {
  provider: AIProvider;
  base_url: string;
  model: string;
  has_api_key: boolean;
  temperature: number;
  max_tokens: number;
  configured: boolean;
}

export interface AIModel {
  id: string;
  name?: string;
}

export interface ScrapeQueueEntry {
  id: number;
  book_id: number;
  title: string;
  provider: string;
  providers?: ScrapeProvider[];
  outcomes?: {provider:string;status:string;error?:string;note?:string;reviews:number;applied_fields:string[]}[];
  status: QueueStatus;
  error: string;
  created_at: number;
  updated_at: number;
}

export interface ScrapeQueueResult {
  enqueued: number;
  reused?: number;
  skipped: number;
  total: number;
  provider: string;
  filter: string;
  failed?: {id: number; reason: string}[];
}

export interface ScrapeStatusCounts {
  pending: number;
  running: number;
  done: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
  last_error: string;
}

export interface AIAssistResult {
  mode: AIMode;
  filter: string;
  total: number;
  enqueued: number;
  skipped: number;
  dry_run: boolean;
}

export const SCRAPE_PROVIDERS: {value: ScrapeProvider; label: string}[] = [
  {value: 'embedded', label: '内嵌元数据（离线）'},
  {value: 'filename', label: '文件名解析（离线）'},
  {value: 'openlibrary', label: 'Open Library'},
  {value: 'google', label: 'Google Books'},
  {value: 'neodb', label: 'NeoDB'},
  {value: 'ai', label: 'AI 辅助'},
];

export const SCRAPE_FILTERS: {value: ScrapeFilter; label: string}[] = [
  {value: 'all', label: '全部'},
  {value: 'no_author', label: '无作者'},
  {value: 'no_description', label: '无简介'},
  {value: 'no_cover', label: '无封面'},
  {value: 'never_scraped', label: '从未刮削'},
];

export const AI_PROVIDERS: {value: AIProvider; label: string}[] = [
  {value: 'openai', label: 'OpenAI'},
  {value: 'anthropic', label: 'Anthropic（Claude）'},
  {value: 'custom', label: '自定义（OpenAI 兼容）'},
];

/** Default endpoint per provider; shown as a hint and used when base_url is empty. */
export const AI_BASE_HINTS: Record<AIProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  custom: '',
};

export const DEFAULT_SCRAPE_LIMIT = 200;
export const MAX_SCRAPE_LIMIT = 1000;
export const AI_ASSIST_LIMIT = 50;
export const QUEUE_PAGE_LIMIT = 50;

function contractMissing(detail: string): ApiError {
  return new ApiError(501, {error: {code: 'not_implemented', message: detail}});
}

function asCount(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** Query string for the queue list; status '' means all statuses. */
export function scrapeQueueQuery(status: QueueStatus | '' = '', limit: number = QUEUE_PAGE_LIMIT): string {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', String(limit));
  return params.toString();
}

/** Body for POST /metadata/scrape-queue. Filters and limits are always explicit. */
export function buildScrapeQueueBody(input: {
  provider?: ScrapeProvider;
  providers?: ScrapeProvider[];
  filter?: ScrapeFilter;
  limit?: number;
}): Record<string, unknown> {
  const provider = SCRAPE_PROVIDERS.some((item) => item.value === input.provider)
    ? input.provider
    : 'embedded';
  const filter = input.filter === '' || input.filter === undefined ? 'all' : input.filter;
  const limit = Math.min(Math.max(Math.floor(input.limit ?? DEFAULT_SCRAPE_LIMIT), 1), MAX_SCRAPE_LIMIT);
  if(input.providers)return {providers:input.providers,filter,limit};
  return {provider, filter, limit};
}

/** Body for PUT /ai/config. Empty key preserves, clearKey sends null. */
export function buildAIConfigUpdate(
  config: Pick<AIConfig, 'provider' | 'base_url' | 'model' | 'temperature' | 'max_tokens'>,
  apiKey = '',
  clearKey = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    provider: config.provider,
    base_url: config.base_url.trim(),
    model: config.model.trim(),
    temperature: Number(config.temperature),
    max_tokens: Math.floor(Number(config.max_tokens)),
  };
  if (clearKey) body.api_key = null;
  else if (apiKey !== '') body.api_key = apiKey;
  return body;
}

/** Confirmation copy for the two AI modes; always states the exact book count. */
export function aiAssistConfirmText(total: number, mode: AIMode): string {
  const books = `${asCount(total)} 本图书`;
  if (total <= 0) {
    return mode === 'retry_failed'
      ? '没有需要辅助重试的图书：没有失败记录，也没有从未刮削的图书。'
      : '当前筛选条件下没有可辅助的图书。';
  }
  return mode === 'retry_failed'
    ? `将对 ${books}调用 AI 辅助：这些书此前刮削失败或从未产生候选。结果会进入元数据审核，需你手动应用。`
    : `将对 ${books}调用 AI 辅助（按当前筛选）。结果会进入元数据审核，需你手动应用。`;
}

/** Normalises the status payload; done/completed are aliases of the same count. */
export function normalizeScrapeStatus(raw: unknown): ScrapeStatusCounts {
  const value = (raw ?? {}) as Record<string, unknown>;
  const completed = asCount(value.completed ?? value.done);
  return {
    pending: asCount(value.pending),
    running: asCount(value.running),
    done: completed,
    completed,
    failed: asCount(value.failed),
    cancelled: asCount(value.cancelled),
    total: asCount(value.total),
    last_error: typeof value.last_error === 'string' ? value.last_error : '',
  };
}

/** True while the queue still has work, which is when polling should continue. */
export function isActiveQueue(counts: Pick<ScrapeStatusCounts, 'pending' | 'running'>): boolean {
  return counts.pending + counts.running > 0;
}

/** Guards the queue list against an unrelated 200 response (unimplemented route). */
export function assertScrapeQueueList(data: unknown): {items: ScrapeQueueEntry[]; total: number} {
  const value = (data ?? {}) as {items?: unknown; total?: unknown};
  const items = Array.isArray(value.items) ? (value.items as ScrapeQueueEntry[]) : null;
  if (!items || (items.length > 0 && typeof items[0]?.status !== 'string')) {
    throw contractMissing('服务器返回的不是刮削队列数据');
  }
  return {items, total: asCount(value.total ?? items.length)};
}

/** Guards the model list; an empty list is valid, a non-list is not. */
export function assertModelList(data: unknown): {items: AIModel[]; total: number} {
  const value = (data ?? {}) as {items?: unknown; total?: unknown};
  if (!Array.isArray(value.items)) throw contractMissing('服务器返回的不是模型列表');
  const items = (value.items as unknown[])
    .map((item) => (item && typeof item === 'object' ? (item as {id?: unknown; name?: unknown}) : null))
    .filter((item): item is {id?: unknown; name?: unknown} => item !== null)
    .map((item) => ({
      id: String(item.id ?? '').trim(),
      ...(typeof item.name === 'string' && item.name.trim() ? {name: item.name.trim()} : {}),
    }))
    .filter((item) => item.id !== '');
  return {items, total: asCount(value.total ?? items.length)};
}

export async function fetchAIConfig(client: MetadataClient): Promise<AIConfig> {
  const data = (await client.get<AIConfig>('/ai/config')) ?? ({} as AIConfig);
  return {
    provider: (['openai', 'anthropic', 'custom'] as AIProvider[]).includes(data.provider) ? data.provider : 'openai',
    base_url: String(data.base_url ?? ''),
    model: String(data.model ?? ''),
    has_api_key: data.has_api_key === true,
    temperature: Number.isFinite(Number(data.temperature)) ? Number(data.temperature) : 0.2,
    max_tokens: asCount(data.max_tokens) || 1024,
    configured: data.configured === true,
  };
}

export function saveAIConfig(client: MetadataClient, update: Record<string, unknown>): Promise<AIConfig> {
  return client.put<AIConfig>('/ai/config', update);
}

export async function fetchAIModels(client: MetadataClient): Promise<AIModel[]> {
  return assertModelList(await client.get('/ai/models')).items;
}

export async function enqueueScrape(client: MetadataClient, body: Record<string, unknown>): Promise<ScrapeQueueResult> {
  return client.post<ScrapeQueueResult>('/metadata/scrape-queue', body);
}

export async function fetchScrapeQueue(
  client: MetadataClient,
  status: QueueStatus | '' = '',
  limit: number = QUEUE_PAGE_LIMIT,
): Promise<{items: ScrapeQueueEntry[]; total: number}> {
  return assertScrapeQueueList(await client.get(`/metadata/scrape-queue?${scrapeQueueQuery(status, limit)}`));
}

export async function fetchScrapeStatus(client: MetadataClient): Promise<ScrapeStatusCounts> {
  return normalizeScrapeStatus(await client.get('/metadata/scrape-status'));
}

export function cancelScrapeEntry(client: MetadataClient, id: number): Promise<ScrapeQueueEntry> {
  return client.post<ScrapeQueueEntry>(`/metadata/scrape-queue/${id}/cancel`);
}

export function cancelAllScrapes(client: MetadataClient): Promise<{cancelled: number}> {
  return client.post<{cancelled: number}>('/metadata/scrape-queue/cancel-all');
}

export function retryFailedScrapes(client: MetadataClient): Promise<{retried: number; requeued?: number; skipped: number}> {
  return client.post('/metadata/scrape-queue/retry-failed');
}

/** One AI assist call; dry_run=true is the confirmation preview and writes nothing. */
export function runAIAssist(client: MetadataClient, body: Record<string, unknown>): Promise<AIAssistResult> {
  return client.post<AIAssistResult>('/metadata/ai-assist', body);
}

export function previewAIAssist(
  client: MetadataClient,
  mode: AIMode,
  filter: ScrapeFilter,
  limit: number = AI_ASSIST_LIMIT,
): Promise<AIAssistResult> {
  return runAIAssist(client, {mode, filter: filter || 'all', limit, dry_run: true});
}

/* ---------- manual per-book editing ---------- */

export interface EditBook {
  id: number;
  title: string;
  author: string;
  description: string;
  format: string;
  has_cover?: boolean;
}

export async function searchBooks(client: MetadataClient, q: string, pageSize = 20): Promise<EditBook[]> {
  const query = new URLSearchParams({q: q.trim(), page_size: String(pageSize)});
  const data = await client.get<{items?: EditBook[]}>(`/books?${query.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

export function updateBook(
  client: MetadataClient,
  id: number,
  fields: {title: string; author: string; description: string},
): Promise<EditBook> {
  return client.put<EditBook>(`/books/${id}`, fields);
}

/** Raw image upload; the server accepts the bytes with an image content type. */
export async function uploadCover(client: MetadataClient, id: number, file: File): Promise<void> {
  const raw = {method: 'POST', headers: {'Content-Type': file.type || 'application/octet-stream'}, body: file};
  if (client.request) {
    await client.request(`/books/${id}/cover/upload`, raw);
    return;
  }
  await client.post(`/books/${id}/cover/upload`, file);
}

/** Asks the server to pull the cover out of the stored EPUB. */
export async function extractCover(client: MetadataClient, id: number): Promise<EditBook | undefined> {
  const raw = {method: 'POST', headers: {'Content-Type': 'application/x-extract'}};
  if (client.request) return client.request<EditBook>(`/books/${id}/cover/upload`, raw);
  return client.post<EditBook>(`/books/${id}/cover/upload`);
}

export function clearCover(client: MetadataClient, id: number): Promise<EditBook> {
  return client.delete<EditBook>(`/books/${id}/cover`);
}
