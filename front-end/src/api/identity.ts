import {ApiError} from './client';
import {errorMessage} from './errors';
import {buildManageQuery, assertManagePage, type ManageQuery} from './management';

export type IdentityProvider = 'openlibrary' | 'google' | 'neodb';
export type IdentityFormat = '' | 'txt' | 'epub' | 'mobi' | 'pdf';
export type IdentityStatus = 'pending' | 'applied' | 'rejected';
export interface IdentityClient {
  get(path: string): Promise<any>;
  post(path: string, body?: unknown): Promise<any>;
}
export interface IdentityInput {
  book_ids?: number[]; library_id?: number; filter?: 'suspicious_title' | 'all';
  q?: string; format?: IdentityFormat; providers: IdentityProvider[]; limit?: number;
}
export interface IdentityFailure {id: number; reason: string}
export interface IdentityResult {
  total: number; eligible: number; enqueued: number; reused: number; skipped: number;
  failed: IdentityFailure[]; dry_run: boolean; providers: IdentityProvider[];
}
export interface IdentityPreview extends IdentityResult {scopeKey: string; bodies: Record<string, unknown>[]}
export interface IdentityRunOptions {
  isCurrent: () => boolean; shouldCancel?: () => boolean; onProgress?: (done: number, total: number) => void;
}
export interface IdentityEnqueueOutcome {
  requested: number; submitted: number; enqueued: number; reused: number; skipped: number;
  failed: IdentityFailure[]; remaining: number; cancelled: boolean;
}
export interface IdentityReview {
  id: number; book_id: number; title: string; status: IdentityStatus; created_at: number;
  before: {title: string; author: string; description: string; series_name: string; volume_label: string; has_cover: boolean};
  candidate: {title: string; author: string; description: string; series: string; volume_label: string; cover_url: string; has_cover: boolean};
  identification: {work_title: string; part_title: string; part_number: number; part_label: string; confidence: number; reason: string; evidence: string};
  sources: {provider: string; status: string; note?: string}[]; can_apply: boolean;
}
export const IDENTITY_PROVIDERS: {value: IdentityProvider; label: string}[] = [
  {value: 'openlibrary', label: 'Open Library'}, {value: 'google', label: 'Google Books'}, {value: 'neodb', label: 'NeoDB'},
];
export const IDENTITY_DISCLOSURE = '仅向已配置的 AI 模型提交最多 6000 字正文摘录、内嵌资料与文件基本名；不会发送完整原文、文件路径或账户资料。随后按所选 HTTP 来源顺序查询整书名与作者。所有结果进入审核，应用后才改写资料并归入同一书库及内容类型的系列集合；原文件和阅读进度保持不变。';
export function identityProviderLabel(provider: string): string {
  if (provider === 'identity') return '内容识别＋刮削';
  if (provider === 'ai') return 'AI 辅助';
  if (provider === 'cover') return '封面';
  return IDENTITY_PROVIDERS.find(item => item.value === provider)?.label ?? ({embedded: '内嵌资料', filename: '文件名解析'} as Record<string, string>)[provider] ?? provider;
}
export function identityStatusLabel(status: string): string {
  return ({pending: '等待处理', running: '正在识别／查询', completed: '完成', failed: '失败', cancelled: '已取消', applied: '已应用', rejected: '已拒绝', matched: '可靠匹配', no_match: '未找到匹配', review: '待审核', succeeded: '成功', identified: '内容已识别', missing: '缺失'} as Record<string, string>)[status] ?? status;
}
function missing(message: string): ApiError {return new ApiError(501, {error: {code: 'not_implemented', message}})}
function checkedIDs(ids: readonly number[]): number[] {
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw new Error('图书／候选 ID 必须为不重复的正整数');
  return [...ids];
}
function chunks(ids: number[], size: number): number[][] {
  return Array.from({length: Math.ceil(ids.length / size)}, (_, i) => ids.slice(i * size, (i + 1) * size));
}
export function buildIdentityBody(input: IdentityInput, dryRun = false): Record<string, unknown> {
  if (!Array.isArray(input.providers) || input.providers.length < 1 || input.providers.some(p => !IDENTITY_PROVIDERS.some(item => item.value === p)) || new Set(input.providers).size !== input.providers.length) throw new Error('请选择 1 至 3 个不重复的 HTTP 刮削来源');
  const body: Record<string, unknown> = {providers: [...input.providers]};
  if (input.book_ids !== undefined) {
    body.book_ids = checkedIDs(input.book_ids);
    if (input.book_ids.length > 500) throw new Error('单次识别最多 500 本');
  } else {
    body.filter = input.filter ?? 'suspicious_title';
    if (!['suspicious_title', 'all'].includes(String(body.filter))) throw new Error('识别筛选不受支持');
    const limit = input.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 50 || limit > 500) throw new Error('每批数量必须为 50 至 500');
    body.limit = limit;
  }
  if (input.library_id !== undefined) {
    if (!Number.isSafeInteger(input.library_id) || input.library_id <= 0) throw new Error('书库 ID 必须为正整数');
    body.library_id = input.library_id;
  }
  if (input.format) {
    if (!['txt', 'epub', 'mobi', 'pdf'].includes(input.format)) throw new Error('识别格式不受支持');
    body.format = input.format;
  }
  if (input.q?.trim()) body.q = input.q.trim();
  if (dryRun) body.dry_run = true;
  return body;
}
function assertIdentityResult(value: unknown, dryRun: boolean): IdentityResult {
  const data = value as IdentityResult;
  if (!data || ['total', 'eligible', 'enqueued', 'reused', 'skipped'].some(key => !Number.isSafeInteger((data as any)[key]) || (data as any)[key] < 0) || !Array.isArray(data.failed) || !Array.isArray(data.providers) || data.dry_run !== dryRun) throw missing('服务器没有返回内容识别范围与批量结果');
  return data;
}
export async function prepareIdentityPreview(client: IdentityClient, input: IdentityInput, scopeKey: string, options?: IdentityRunOptions): Promise<IdentityPreview> {
  const bodies = input.book_ids !== undefined
    ? chunks(checkedIDs(input.book_ids), 500).map(book_ids => buildIdentityBody({...input, book_ids}, true))
    : [buildIdentityBody(input, true)];
  const result: IdentityPreview = {scopeKey, bodies, total: 0, eligible: 0, enqueued: 0, reused: 0, skipped: 0, failed: [], dry_run: true, providers: [...input.providers]};
  let done = 0;
  options?.onProgress?.(0, input.book_ids?.length ?? 0);
  for (const body of bodies) {
    if (options && (!options.isCurrent() || options.shouldCancel?.())) throw new Error('账号或选择范围已变化，请重新预览');
    const data = assertIdentityResult(await client.post('/metadata/identify', body), true);
    if (options && !options.isCurrent()) throw new Error('账号或选择范围已变化，请重新预览');
    result.total += data.total; result.eligible += data.eligible; result.reused += data.reused; result.skipped += data.skipped; result.failed.push(...data.failed);
    done += Array.isArray(body.book_ids) ? body.book_ids.length : data.eligible;
    options?.onProgress?.(done, input.book_ids?.length ?? data.total);
  }
  if (input.book_ids && result.total !== input.book_ids.length) throw new Error('识别范围已变化，完整选择未通过预览，请重新选择');
  return result;
}
export async function collectIdentityBookIDs(client: IdentityClient, query: Partial<ManageQuery>, isCurrent: () => boolean, onProgress?: (done: number, total: number) => void): Promise<number[]> {
  const ids: number[] = []; let total: number | undefined;
  for (let page = 1; ; page++) {
    if (!isCurrent()) throw new Error('账号或选择范围已变化，请重新预览');
    const data = assertManagePage(await client.get('/books/manage?' + buildManageQuery({...query, logical_library: true, sort: 'title', page, page_size: 200})));
    if (!isCurrent()) throw new Error('账号或选择范围已变化，请重新预览');
    if (total !== undefined && data.total !== total) throw new Error('筛选结果已变化，请重新预览');
    total = data.total;
    ids.push(...data.items.map(item => item.id));
    onProgress?.(ids.length, total);
    if (ids.length === total && new Set(ids).size === ids.length) return ids.length ? checkedIDs(ids) : [];
    if (data.items.length < 200 || ids.length > total || new Set(ids).size !== ids.length) throw new Error('筛选结果已变化或未完整返回，请重新预览');
  }
}
export async function runIdentityEnqueue(client: IdentityClient, preview: IdentityPreview, options: IdentityRunOptions & {confirmed: boolean}): Promise<IdentityEnqueueOutcome> {
  if (!options.confirmed) throw new Error('请先确认范围和摘录发送说明');
  if (!options.isCurrent()) throw new Error('账号或选择范围已变化，请重新预览');
  const outcome: IdentityEnqueueOutcome = {requested: preview.total, submitted: 0, enqueued: 0, reused: 0, skipped: 0, failed: [], remaining: preview.total, cancelled: false};
  options.onProgress?.(0, preview.total);
  for (const previewBody of preview.bodies) {
    if (!options.isCurrent() || options.shouldCancel?.()) {outcome.cancelled = true; break}
    const body = {...previewBody}; delete body.dry_run;
    const count = Array.isArray(body.book_ids) ? body.book_ids.length : preview.eligible;
    try {
      const result = assertIdentityResult(await client.post('/metadata/identify', body), false);
      outcome.enqueued += result.enqueued; outcome.reused += result.reused; outcome.skipped += result.skipped; outcome.failed.push(...result.failed);
    } catch (error) {
      if (!Array.isArray(body.book_ids)) throw error;
      outcome.failed.push(...body.book_ids.map(id => ({id, reason: errorMessage(error, '这一批提交失败')})));
    }
    outcome.submitted += count; outcome.remaining = Math.max(0, outcome.requested - outcome.submitted);
    options.onProgress?.(outcome.submitted, outcome.requested);
  }
  return outcome;
}
export function identityReviewsQuery(query: {status?: IdentityStatus; library?: string; page?: number; page_size?: number; q?: string} = {}): string {
  const params = new URLSearchParams({status: query.status ?? 'pending', page: String(query.page ?? 1), page_size: String(query.page_size ?? 20)});
  if (query.library) params.set('library', query.library);
  if (query.q?.trim()) params.set('q', query.q.trim());
  return params.toString();
}
export async function fetchIdentityReviews(client: IdentityClient, query: Parameters<typeof identityReviewsQuery>[0] = {}): Promise<{items: IdentityReview[]; total: number; page: number; page_size: number}> {
  const data = await client.get('/metadata/identity-reviews?' + identityReviewsQuery(query));
  if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.items.some((item: IdentityReview) => !item.before || !item.candidate || !item.identification || !Array.isArray(item.sources))) throw missing('服务器没有返回内容识别候选及前后资料');
  return data;
}
export async function runIdentityReviews(client: IdentityClient, ids: readonly number[], action: 'apply' | 'reject', options: IdentityRunOptions): Promise<{applied: number; rejected: number; failed: IdentityFailure[]; succeededIDs: number[]; submitted: number; remaining: number; cancelled: boolean}> {
  const valid = checkedIDs(ids);
  const outcome = {applied: 0, rejected: 0, failed: [] as IdentityFailure[], succeededIDs: [] as number[], submitted: 0, remaining: valid.length, cancelled: false};
  options.onProgress?.(0, valid.length);
  for (const chunk of chunks(valid, 20)) {
    if (!options.isCurrent() || options.shouldCancel?.()) {outcome.cancelled = true; break}
    try {
      const data = await client.post('/metadata/identity-reviews/batch', {ids: chunk, action});
      if (!data || !Number.isSafeInteger(data.applied) || data.applied < 0 || !Number.isSafeInteger(data.rejected) || data.rejected < 0 || !Array.isArray(data.failed)) throw missing('服务器没有返回审核批量结果');
      const failedIDs = data.failed.map((item: IdentityFailure) => item?.id);
      if (new Set(failedIDs).size !== failedIDs.length || failedIDs.some((id: number) => !chunk.includes(id)) || data.applied + data.rejected + failedIDs.length !== chunk.length) throw missing('审核结果未完整说明每条候选，保留待核对');
      outcome.applied += data.applied; outcome.rejected += data.rejected; outcome.failed.push(...data.failed);
      const failed = new Set(data.failed.map((item: IdentityFailure) => item.id));
      outcome.succeededIDs.push(...chunk.filter(id => !failed.has(id)));
    } catch (error) {
      outcome.failed.push(...chunk.map(id => ({id, reason: errorMessage(error, '这一批审核失败；候选保留待核对')})));
    }
    outcome.submitted += chunk.length; outcome.remaining = valid.length - outcome.submitted;
    options.onProgress?.(outcome.submitted, valid.length);
  }
  return outcome;
}
