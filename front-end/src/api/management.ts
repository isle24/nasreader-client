// Administrator book management (/#/admin/books): endpoints and the pure helpers behind
// the page.
//
// The backend contract is doc/plans/2026-10-08-sources-management-scale.md §2. The
// routes are implemented in parallel, so callers must surface a missing route as
// 「暂不可用」 (`integrationError` / `isUnavailable`) rather than pretending an empty
// list is an answer.
//
// Nothing in this module touches `window`/`document`: the HTTP client is passed in, so
// the query builder, the batch chunker, the byte formatter and the confirmation copy
// stay unit-testable without a DOM.
import {errorMessage} from './errors';
import {ApiError} from './client';
import type {Book} from './client';

export type ManageFilter =
  | ''
  | 'missing'
  | 'duplicate'
  | 'no_cover'
  | 'no_author'
  | 'no_description'
  | 'never_opened'
  | 'recent'
  | 'suspicious_title';
export type ManageSort = 'updated' | 'title' | 'size' | 'created' | 'word_count';
export type BatchAction =
  | 'add_shelf'
  | 'remove_shelf'
  | 'set_library'
  | 'rescan'
  | 'extract_cover'
  | 'scrape'
  | 'update'
  | 'delete_records';

/** One row of GET /books/manage: the public book fields plus the management extras. */
export interface ManageBook extends Book {
  has_cover?: boolean;
  file_count?: number;
  available_file_count?: number;
  has_duplicate?: boolean;
  read_count?: number;
  /** Not part of the frozen contract; shown only when the server sends it. */
  last_read_at?: number | null;
}

export interface ManageQuery {
  /** Opt in to books.library_id membership; ordinary management also includes physical sources. */
  logical_library?: boolean;
  filter: ManageFilter;
  library: string;
  format: string;
  q: string;
  sort: ManageSort;
  page: number;
  page_size: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface BatchFailure {
  id: number;
  reason: string;
}

export interface BatchResult {
  updated: number;
  failed?: BatchFailure[];
}

export interface LibraryStat {
  id: number;
  name: string;
  books: number;
  bytes: number;
}

export interface BookStats {
  books: number;
  total_bytes: number;
  cover_bytes: number;
  database_bytes: number;
  chapters: number;
  duplicate_groups: number;
  missing_books: number;
  libraries?: LibraryStat[];
}

export interface DuplicateBook {
  id: number;
  title: string;
  path: string;
  format: string;
  file_count: number;
  is_primary: boolean;
}

export interface DuplicateGroup {
  content_hash: string;
  size: number;
  books: DuplicateBook[];
}

export interface MergeResult {
  kept: number;
  merged: number;
}

export interface VacuumResult {
  before_bytes: number;
  after_bytes: number;
  duration_ms: number;
}

export interface CleanCoversResult {
  /** Unreferenced files deleted under DATA_DIR/covers. */
  removed: number;
  /** Book cover paths that pointed at a missing file and were cleared. */
  orphans: number;
}

/**
 * The full-text index was removed: `GET /books/{id}/search` is now an exact substring
 * scan per book, so this route stays as a compatibility no-op that reports `indexed: 0`
 * and a `note` explaining that no index is needed.
 */
export interface RebuildSearchResult {
  indexed?: number;
  duration_ms?: number;
  note?: string;
}

/** The slice of ApiClient this module needs; ApiClient satisfies it structurally. */
export interface ManageClient {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  delete<T = any>(path: string): Promise<T>;
}

export type BatchSender = (ids: number[], body: Record<string, unknown>) => Promise<BatchResult>;

export interface BatchOutcome {
  /** Unique ids actually submitted (duplicates removed). */
  requested: number;
  chunks: number;
  updated: number;
  failed: BatchFailure[];
}

export interface BatchRunOptions {
  client?: ManageClient;
  extra?: Record<string, unknown>;
  send?: BatchSender;
  onProgress?: (done: number, total: number) => void;
}

/** The contract caps one batch call at 500 ids. */
export const BATCH_CHUNK_SIZE = 500;

/** The sentence D4 requires verbatim in the delete-records confirmation. */
export const DELETE_RECORDS_NOTE = '只会删除数据库中的记录，不会删除 /library 下的任何文件。';

export const BATCH_ACTION_LABELS: Record<BatchAction, string> = {
  add_shelf: '加入书架',
  remove_shelf: '移出书架',
  set_library: '设为书库',
  rescan: '重新扫描',
  extract_cover: '提取封面',
  scrape: '刮削元数据',
  update: '编辑元数据',
  delete_records: '删除记录',
};

export const MANAGE_FILTERS: {value: ManageFilter; label: string}[] = [
  {value: '', label: '全部'},
  {value: 'missing', label: '源文件缺失'},
  {value: 'duplicate', label: '重复内容'},
  {value: 'no_cover', label: '无封面'},
  {value: 'no_author', label: '无作者'},
  {value: 'no_description', label: '无简介'},
  {value: 'never_opened', label: '从未打开'},
  {value: 'recent', label: '最近新增'},
  {value: 'suspicious_title', label: '疑似错误书名'},
];

export const MANAGE_SORTS: {value: ManageSort; label: string}[] = [
  {value: 'updated', label: '最近更新'},
  {value: 'created', label: '加入时间'},
  {value: 'title', label: '书名'},
  {value: 'size', label: '文件大小'},
  {value: 'word_count', label: '字数'},
];

export const BATCH_PROVIDERS: {value: string; label: string}[] = [
  {value: 'openlibrary', label: 'Open Library'},
  {value: 'google', label: 'Google Books'},
  {value: 'neodb', label: 'NeoDB'},
];

/** `GET /books/manage` query string. Empty filters are omitted; paging is always sent. */
export function buildManageQuery(input: Partial<ManageQuery> = {}): string {
  const params = new URLSearchParams();
  const filter = input.filter ?? '';
  if (filter) params.set('filter', filter);
  if (input.library) params.set('library', String(input.library));
  if (input.format) params.set('format', String(input.format));
  const q = (input.q ?? '').trim();
  if (q) params.set('q', q);
  if (input.logical_library) params.set('logical_library', '1');
  params.set('sort', input.sort ?? 'updated');
  params.set('page', String(input.page ?? 1));
  params.set('page_size', String(input.page_size ?? 50));
  return params.toString();
}

/** Split ids into batches of at most `size`; duplicates are dropped (order kept). */
export function chunkIds(ids: readonly number[], size: number = BATCH_CHUNK_SIZE): number[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('分块大小必须是正整数');
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const chunks: number[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human-readable byte size; a missing or non-finite value reads as 「—」, never 0 B. */
export function formatBytes(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let scaled = bytes;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

/** Confirmation body for every batch action; always states the exact count. */
export function batchConfirmText(
  action: BatchAction,
  count: number,
  extra: {shelf?: string; library?: string; provider?: string; fields?: string[]} = {},
): string {
  const books = `${count} 本图书`;
  switch (action) {
    case 'add_shelf':
      return `将 ${books}加入书架${extra.shelf ? `「${extra.shelf}」` : ''}。书架里的其他图书不受影响。`;
    case 'remove_shelf':
      return `将 ${books}移出书架${extra.shelf ? `「${extra.shelf}」` : ''}。书架本身和图书都不会被删除。`;
    case 'set_library':
      return `将 ${books}的书库归属改为${extra.library ? `「${extra.library}」` : '所选书库'}。`;
    case 'rescan':
      return `重新扫描这 ${books}的源文件，更新大小、格式与章节。`;
    case 'extract_cover':
      return `从这 ${books}的文件中提取内嵌封面；没有内嵌封面的书会保持不变。`;
    case 'scrape':
      return `为这 ${books}排队刮削元数据${extra.provider ? `（来源：${extra.provider}）` : ''}。逐本处理，可能需要较长时间。`;
    case 'update':
      return `将批量覆盖这 ${books}的${extra.fields?.length ? extra.fields.join('、') : '元数据'}；原有内容会被替换。`;
    case 'delete_records':
      return `即将删除这 ${books}的数据库记录。${DELETE_RECORDS_NOTE}此操作不可撤销。`;
  }
}

export function deleteRecordsConfirm(count: number): string {
  return batchConfirmText('delete_records', count);
}

/**
 * Unimplemented management routes on this server do NOT answer 404: the router sends
 * the path to the ordinary book-list handler, which answers 200 `{items,total}` of all
 * books (an unfiltered list, and for POST a body without `updated`). Treating that as
 * data would show wrong rows and fake successful batches, so every response is checked
 * against the shapes the contract names and reported as 暂不可用 (501 / not_implemented)
 * when it does not match.
 */
function contractMissing(detail: string): ApiError {
  return new ApiError(501, {error: {code: 'not_implemented', message: detail}});
}

/** Keys that only the management view returns (the plain book list has none of them). */
export const MANAGE_ROW_KEYS = ['file_count', 'available_file_count', 'has_duplicate', 'read_count'];

export function assertManagePage(data: Page<ManageBook> | null | undefined): Page<ManageBook> {
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length && !MANAGE_ROW_KEYS.some((key) => key in (items[0] as unknown as Record<string, unknown>))) {
    throw contractMissing('服务器返回的是普通图书列表，缺少管理字段（file_count / available_file_count / read_count）');
  }
  return {items, total: Number(data?.total ?? items.length) || 0};
}

export function assertCounts<T>(data: T, keys: string[], what: string): T {
  for (const key of keys) {
    if (typeof (data as Record<string, unknown> | null | undefined)?.[key] !== 'number') {
      throw contractMissing(`${what}没有返回 ${key}`);
    }
  }
  return data;
}

/**
 * Run `POST /books/batch` over every id, 500 at a time, aggregating failures per item.
 * A chunk-level failure (network / server error) marks every id of that chunk failed
 * with the same reason, so the reported failure list always covers the submitted set.
 */
export async function runBatch(
  ids: readonly number[],
  action: BatchAction,
  options: BatchRunOptions = {},
): Promise<BatchOutcome> {
  const chunks = chunkIds(ids);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const sender: BatchSender | undefined =
    options.send ??
    (options.client
      ? (chunk, body) => options.client!.post<BatchResult>('/books/batch', {ids: chunk, ...body})
      : undefined);
  if (!sender) throw new Error('runBatch 需要 client 或 send 之一');
  const failed: BatchFailure[] = [];
  let updated = 0;
  let done = 0;
  options.onProgress?.(0, total);
  for (const chunk of chunks) {
    try {
      const result = await sender(chunk, {action, ...(options.extra ?? {})});
      if (typeof result?.updated !== 'number' || (result.failed !== undefined && !Array.isArray(result.failed))) {
        throw contractMissing('服务器没有返回 {updated, failed} 批量结果');
      }
      updated += Number(result.updated) || 0;
      for (const item of result.failed ?? []) {
        failed.push({id: Number(item?.id), reason: String(item?.reason ?? '').trim() || '服务端未说明原因'});
      }
    } catch (error) {
      const reason = errorMessage(error, '这一批请求失败');
      for (const id of chunk) failed.push({id, reason});
    }
    done += chunk.length;
    options.onProgress?.(done, total);
  }
  return {requested: total, chunks: chunks.length, updated, failed};
}

export function fetchManageBooks(client: ManageClient, query: Partial<ManageQuery> = {}) {
  return client
    .get<Page<ManageBook>>('/books/manage?' + buildManageQuery(query))
    .then(assertManagePage);
}

export function fetchBookStats(client: ManageClient) {
  return client.get<BookStats>('/books/stats').then((data) => {
    if (!data || typeof data.books !== 'number' || typeof data.total_bytes !== 'number') {
      throw contractMissing('服务器没有返回 {books,total_bytes,…} 统计对象');
    }
    return data;
  });
}

export function fetchDuplicates(client: ManageClient) {
  return client.get<Page<DuplicateGroup>>('/books/duplicates').then((data) => {
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length && !('content_hash' in (items[0] as unknown as Record<string, unknown>))) {
      throw contractMissing('服务器没有返回按 content_hash 分组的重复内容');
    }
    return {items, total: Number(data?.total ?? items.length) || 0};
  });
}

export function mergeDuplicates(client: ManageClient, bookIds: number[], keepId: number) {
  return client
    .post<MergeResult>('/books/duplicates/merge', {book_ids: bookIds, keep_id: keepId})
    .then((result) => assertCounts(result, ['kept', 'merged'], '合并重复内容'));
}

export function vacuumDatabase(client: ManageClient) {
  return client
    .post<VacuumResult>('/maintenance/vacuum')
    .then((result) => assertCounts(result, ['before_bytes', 'after_bytes'], 'VACUUM'));
}

export function rebuildSearch(client: ManageClient) {
  // Compatibility no-op: the server no longer rebuilds a full-text index. Keep the
  // {indexed,duration_ms,note} shape checked so the ordinary book-list fallback of an
  // unimplemented route is never mistaken for a successful reindex.
  return client
    .post<RebuildSearchResult>('/maintenance/rebuild-search')
    .then((result) => assertCounts(result, ['indexed', 'duration_ms'], '重建全文索引'));
}

export function cleanCovers(client: ManageClient) {
  return client
    .post<CleanCoversResult>('/maintenance/clean-covers')
    .then((result) => assertCounts(result, ['removed', 'orphans'], '清理无主封面'));
}

export function fetchLibraries(client: ManageClient) {
  return client.get<Page<{id: number; name: string}>>('/libraries');
}

export function fetchShelves(client: ManageClient) {
  return client.get<Page<{id: number; name: string}>>('/shelves');
}

export function vacuumMessage(result: VacuumResult): string {
  const before = Number(result?.before_bytes ?? 0);
  const after = Number(result?.after_bytes ?? 0);
  const freed = Math.max(0, before - after);
  return `VACUUM 完成：${formatBytes(before)} → ${formatBytes(after)}，释放 ${formatBytes(freed)}，用时 ${Number(
    result?.duration_ms ?? 0,
  )} 毫秒。`;
}

export function cleanCoversMessage(result: CleanCoversResult): string {
  // `removed` = unreferenced files deleted; `orphans` = book cover paths that pointed
  // at a missing file and were cleared (not "remaining orphans").
  return `清理无主封面完成：删除 ${Number(result?.removed ?? 0)} 个无主文件，清理 ${Number(
    result?.orphans ?? 0,
  )} 条指向缺失文件的封面引用。`;
}

/**
 * Result line for the compatibility no-op. The server's own `note` is the truth about
 * what happened; without one the numbers are reported plainly instead of claiming that
 * an index was rebuilt.
 */
export function rebuildSearchMessage(result: RebuildSearchResult | null | undefined): string {
  const note = String(result?.note ?? '').trim();
  if (note) return note;
  return `接口已返回：索引 ${Number(result?.indexed ?? 0)} 条，用时 ${Number(
    result?.duration_ms ?? 0,
  )} 毫秒（服务器没有提供说明；全文检索已改为按书精确匹配，通常无需执行）。`;
}

export function mergeMessage(result: MergeResult, keptTitle = ''): string {
  const kept = keptTitle ? `《${keptTitle}》` : `#${Number(result?.kept ?? 0)}`;
  return `已保留${kept}，合并 ${Number(result?.merged ?? 0)} 条记录。`;
}
