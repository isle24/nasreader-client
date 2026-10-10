<script setup lang="ts">
// 书籍管理（管理员，/#/admin/books）。
//
// 表格 + 问题视图筛选 + 批量操作 + 存储统计 + 重复合并。所有数字都来自服务端；
// 接口还没实现的服务器会看到明确的「暂不可用」，不会看到伪造的空列表或假数据。
// 页面只使用全局样式类（.page/.panel/.toolbar/.list-row/.sheet/.modal-backdrop/
// .status-banner/.error/.pagination/.book-cover），页面专属规则放在本组件的 scoped 样式里。
import {ref,reactive,computed,onMounted,onBeforeUnmount,nextTick,watch} from 'vue';
import {useRouter} from 'vue-router';
import {api,state} from '../state';
import {errorMessage,integrationError} from '../api/errors';
import {handoffIdentitySelection} from '../identitySelection';
import BookCover from '../components/BookCover.vue';
import ScrapeSources from '../components/ScrapeSources.vue';
import type {ScrapeProvider} from '../api/metadata';
import {
  BATCH_ACTION_LABELS,
  BATCH_PROVIDERS,
  MANAGE_FILTERS,
  MANAGE_SORTS,
  batchConfirmText,
  cleanCovers,
  cleanCoversMessage,
  fetchBookStats,
  fetchDuplicates,
  fetchLibraries,
  fetchManageBooks,
  fetchShelves,
  formatBytes,
  mergeDuplicates,
  mergeMessage as mergeSummary,
  rebuildSearch,
  rebuildSearchMessage,
  runBatch,
  vacuumDatabase,
  vacuumMessage,
  type BatchAction,
  type BatchFailure,
  type BookStats,
  type DuplicateGroup,
  type ManageBook,
  type ManageFilter,
  type ManageQuery,
  type ManageSort,
} from '../api/management';

type MaintKey = 'vacuum' | 'rebuild-search' | 'clean-covers';
interface Confirmation {
  title: string;
  body: string;
  count?: number;
  confirmLabel: string;
  danger: boolean;
  run: () => Promise<void>;
}
interface PendingMaintenance {
  key: MaintKey;
  /** Button text — kept honest about what the endpoint now does. */
  label: string;
  title: string;
  body: string;
  confirmLabel: string;
}

const router = useRouter();
const isAdmin = computed(() => state.user?.role === 'admin');
const accountScope = computed(() => JSON.stringify([state.server, state.user?.id, state.user?.role, state.accessEpoch]));
let mounted = false;
let scopeGeneration = 0;
const currentScope = (scope: string, generation: number) => mounted && isAdmin.value && accountScope.value === scope && scopeGeneration === generation;

/* ---------- list + filters ---------- */

const books = ref<ManageBook[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(50);
const q = ref('');
const filter = ref<ManageFilter>('');
const library = ref('');
const format = ref('');
const sort = ref<ManageSort>('updated');
const loading = ref(false);
const listError = ref('');
const message = ref('');
const libraries = ref<{id: number; name: string}[]>([]);
const shelves = ref<{id: number; name: string}[]>([]);
let generation = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const query = (): Partial<ManageQuery> => ({
  filter: filter.value,
  library: library.value,
  format: format.value,
  q: q.value,
  sort: sort.value,
  page: page.value,
  page_size: pageSize.value,
});

async function load() {
  if (!isAdmin.value || !mounted) return;
  const scope = accountScope.value, sg = scopeGeneration;
  const g = ++generation;
  loading.value = true;
  listError.value = '';
  try {
    const data = await fetchManageBooks(api, query());
    if (g !== generation || !currentScope(scope, sg)) return;
    books.value = Array.isArray(data?.items) ? data.items : [];
    total.value = Number(data?.total ?? books.value.length) || 0;
  } catch (e: any) {
    if (g !== generation || !currentScope(scope, sg)) return;
    books.value = [];
    total.value = 0;
    listError.value = integrationError('书籍管理', e);
  } finally {
    if (g === generation && currentScope(scope, sg)) loading.value = false;
  }
}

async function loadLibraries() {
  if (!isAdmin.value || !mounted) return;
  const scope = accountScope.value, g = scopeGeneration;
  try {
    const data = await fetchLibraries(api);
    if (currentScope(scope, g)) libraries.value = data.items ?? [];
  } catch (e: any) {
    if (currentScope(scope, g)) message.value = '书库列表读取失败：' + errorMessage(e);
  }
}
async function loadShelves() {
  if (!isAdmin.value || !mounted) return;
  const scope = accountScope.value, g = scopeGeneration;
  try {
    const data = await fetchShelves(api);
    if (currentScope(scope, g)) shelves.value = data.items ?? [];
  } catch (e: any) {
    if (currentScope(scope, g)) message.value = '书架列表读取失败：' + errorMessage(e);
  }
}

function setFilter(value: ManageFilter) {
  filter.value = value;
  page.value = 1;
  clearSelection();
  void load();
}
function onScopeChange() {
  page.value = 1;
  clearSelection();
  void load();
}
function onSortChange() {
  page.value = 1;
  void load();
}
function onPageSizeChange() {
  page.value = 1;
  void load();
}
function applySearch() {
  clearTimeout(debounceTimer);
  page.value = 1;
  clearSelection();
  void load();
}
function onSearchInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applySearch, 300);
}
function go(target: number) {
  page.value = Math.min(Math.max(1, target), pageCount.value);
  void load();
}

/* ---------- selection ---------- */

const selected = ref<Set<number>>(new Set());
const allSelectedFiltered = ref(false);
const selectedCount = computed(() => selected.value.size);
const pageAllSelected = computed(() => books.value.length > 0 && books.value.every((b) => selected.value.has(b.id)));
const pageSomeSelected = computed(() => !pageAllSelected.value && books.value.some((b) => selected.value.has(b.id)));
const canSelectAll = computed(() => total.value > 0 && selectedCount.value < total.value && !allSelectedFiltered.value);

function startIdentity() {
  if (!isAdmin.value || !state.user || !selectedCount.value || batchRunning.value || selectAllBusy.value) return;
  handoffIdentitySelection({server: state.server, userId: state.user.id}, [...selected.value]);
  void router.push('/admin/identify');
}
watch(accountScope, (next, previous) => {
  scopeGeneration++; generation++;
  clearTimeout(debounceTimer);
  clearSelection();
  books.value = []; total.value = 0; loading.value = false; listError.value = '';
  libraries.value = []; shelves.value = []; message.value = '';
  stats.value = null; statsLoading.value = false; statsError.value = '';
  dupGroups.value = []; dupTotal.value = 0; dupLoaded.value = false; dupLoading.value = false; dupError.value = '';
  for (const key of Object.keys(keepChoice)) delete keepChoice[key];
  detail.value = null; confirmState.value = null; editOpen.value = false; editError.value = '';
  editFields.title = ''; editFields.author = ''; editFields.description = '';
  shelfId.value = ''; libraryId.value = '';
  failures.value = []; failureTitle.value = ''; resultMessage.value = ''; resultError.value = '';
  maintMessage.value = ''; maintError.value = ''; mergeMessage.value = ''; mergeError.value = '';
  page.value = 1;
  if (JSON.stringify(JSON.parse(next).slice(0, 3)) !== JSON.stringify(JSON.parse(previous).slice(0, 3))) {
    library.value = ''; format.value = ''; q.value = ''; filter.value = '';
  }
  // Let a server/session switch and the app's lease gate finish before starting
  // reads. The replacement run owns loading; every old response is now stale.
  if (mounted && isAdmin.value) {
    loading.value = true;
    void nextTick(() => {if (mounted && next === accountScope.value && isAdmin.value) void reloadScopedData()});
  }
}, {flush: 'sync'});

function isSelected(id: number) {
  return selected.value.has(id);
}
function toggleRow(id: number) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}
function togglePage() {
  const next = new Set(selected.value);
  const ids = books.value.map((b) => b.id);
  const all = ids.length > 0 && ids.every((id) => next.has(id));
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  selected.value = next;
}
let selectionGeneration = 0;
function clearSelection() {
  selectionGeneration++;
  selectAllBusy.value = false;
  selectAllProgress.value = {done: 0, total: 0};
  selectAllError.value = '';
  selected.value = new Set();
  allSelectedFiltered.value = false;
}

/* 全选整个筛选结果：接口没有「只取 id」的入口，所以按 200/页把当前筛选全部读回来，
   选中数量永远等于真正读到的 id 数量（total 只用于显示与上限判断）。 */
const SELECT_PAGE_SIZE = 200;
const selectAllBusy = ref(false);
const selectAllProgress = ref({done: 0, total: 0});
const selectAllError = ref('');

async function selectAllFiltered() {
  if (selectAllBusy.value) return;
  const wanted = total.value;
  const pages = Math.ceil(wanted / SELECT_PAGE_SIZE);
  const snapshot = query();
  const g = ++selectionGeneration, sg = scopeGeneration, scope = accountScope.value;
  const selectionScope = JSON.stringify(snapshot);
  const current = () => currentScope(scope, sg) && g === selectionGeneration && selectionScope === JSON.stringify(query());
  selectAllError.value = '';
  selectAllBusy.value = true;
  selectAllProgress.value = {done: 0, total: wanted};
  try {
    const ids: number[] = [];
    for (let p = 1; p <= pages; p++) {
      if (!current()) throw new Error('账号或筛选范围已变化，请重新选择');
      const data = await fetchManageBooks(api, {...snapshot, page: p, page_size: SELECT_PAGE_SIZE});
      if (!current() || data.total !== wanted) throw new Error('账号或筛选范围已变化，请重新选择');
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) break;
      for (const item of items) ids.push(item.id);
      selectAllProgress.value = {done: ids.length, total: wanted};
    }
    if (new Set(ids).size !== ids.length || ids.length !== wanted) throw new Error('筛选结果未完整返回，请重新选择');
    if (!current()) return;
    selected.value = new Set(ids);
    allSelectedFiltered.value = ids.length > 0 && ids.length >= wanted;
  } catch (e: any) {
    if (current()) selectAllError.value = '读取筛选结果失败：' + errorMessage(e);
  } finally {
    if (g === selectionGeneration) selectAllBusy.value = false;
  }
}

/* ---------- batch actions ---------- */

const confirmState = ref<Confirmation | null>(null);
const confirmEl = ref<HTMLElement | null>(null);
const batchRunning = ref(false);
const batchProgress = ref({done: 0, total: 0});
const failures = ref<BatchFailure[]>([]);
const failureTitle = ref('');
const resultMessage = ref('');
const resultError = ref('');
const MAX_FAILURES_SHOWN = 200;
const shelfId = ref('');
const libraryId = ref('');
const providers=ref<ScrapeProvider[]>(['embedded','neodb','openlibrary','google']);
const editOpen = ref(false);
const editEl = ref<HTMLElement | null>(null);
const editError = ref('');
const editFields = reactive({title: '', author: '', description: ''});

function shelfName(id: unknown) {
  return shelves.value.find((s) => Number(s.id) === Number(id))?.name;
}
function libraryName(id: unknown) {
  if (id === null || id === undefined || id === '') return '未分类';
  return libraries.value.find((l) => Number(l.id) === Number(id))?.name ?? `#${id}`;
}
function providerLabel(value: unknown) {
  return BATCH_PROVIDERS.find((p) => p.value === value)?.label ?? String(value ?? '');
}

function askBatch(action: BatchAction, extra: Record<string, unknown> = {}, fields: string[] = []) {
  if (!selectedCount.value || batchRunning.value) return;
  const count = selectedCount.value;
  confirmState.value = {
    title: BATCH_ACTION_LABELS[action],
    body: batchConfirmText(action, count, {
      shelf: shelfName(extra.shelf_id),
      library: libraryName(extra.library_id),
      provider: Array.isArray(extra.providers)?extra.providers.map(providerLabel).join(" → "):providerLabel(extra.provider),
      fields,
    }),
    count,
    confirmLabel: `确认${BATCH_ACTION_LABELS[action]}`,
    danger: action === 'delete_records',
    run: () => executeBatch(action, extra),
  };
  void focusSheet(confirmEl);
}

type SheetRef = typeof confirmEl;
async function focusSheet(target: SheetRef) {
  await nextTick();
  target.value?.querySelector<HTMLElement>('button,input,select,textarea,a[href]')?.focus();
}

async function executeBatch(action: BatchAction, extra: Record<string, unknown>) {
  const ids = [...selected.value];
  const label = BATCH_ACTION_LABELS[action];
  batchRunning.value = true;
  batchProgress.value = {done: 0, total: ids.length};
  failures.value = [];
  failureTitle.value = label;
  resultMessage.value = '';
  resultError.value = '';
  try {
    const outcome = await runBatch(ids, action, {
      client: api,
      extra,
      onProgress: (done, total) => {
        batchProgress.value = {done, total};
      },
    });
    resultMessage.value = outcome.failed.length
      ? `${label}完成：成功 ${outcome.updated} 本，失败 ${outcome.failed.length} 本（共提交 ${outcome.requested} 本）。`
      : `${label}完成：成功 ${outcome.updated} 本。`;
    if (outcome.updated === 0 && outcome.requested > 0 && outcome.failed.length === outcome.requested) {
      resultError.value = `${label}失败：${outcome.failed[0].reason}`;
    }
    failures.value = outcome.failed;
    clearSelection();
    await refresh();
  } catch (e: any) {
    resultError.value = `${label}失败：${errorMessage(e)}`;
  } finally {
    batchRunning.value = false;
    batchProgress.value = {done: 0, total: 0};
  }
}

function openBatchEdit() {
  if (!selectedCount.value) return;
  editFields.title = '';
  editFields.author = '';
  editFields.description = '';
  editOpen.value = true;
  void focusSheet(editEl);
}
function submitBatchEdit() {
  const extra: Record<string, unknown> = {};
  const fields: string[] = [];
  if (editFields.title.trim()) {
    extra.title = editFields.title.trim();
    fields.push('书名');
  }
  if (editFields.author.trim()) {
    extra.author = editFields.author.trim();
    fields.push('作者');
  }
  if (editFields.description.trim()) {
    extra.description = editFields.description.trim();
    fields.push('简介');
  }
  if (!fields.length) {
    editError.value = '至少填写一项要覆盖的内容。';
    return;
  }
  editError.value = '';
  editOpen.value = false;
  askBatch('update', extra, fields);
}

/* ---------- maintenance ---------- */

const stats = ref<BookStats | null>(null);
const statsLoading = ref(false);
const statsError = ref('');
const maintRunning = ref<MaintKey | ''>('');
const maintMessage = ref('');
const maintError = ref('');
const MAINTENANCE: PendingMaintenance[] = [
  {
    key: 'vacuum',
    label: 'VACUUM 整理数据库',
    title: 'VACUUM 整理数据库',
    body: 'VACUUM 会重建数据库文件以回收删除记录后的空间，执行时服务可能短暂变慢。确定现在执行吗？',
    confirmLabel: '确认 VACUUM',
  },
  {
    // Full-text search is now an exact substring scan per book, so there is no index
    // left to rebuild. The route stays for compatibility and this button says so.
    key: 'rebuild-search',
    label: '重建全文索引（已改为精确匹配，通常无需执行）',
    title: '重建全文索引（兼容接口，不会重建索引）',
    body: '全文检索已改为按书精确匹配，不再使用索引：这个接口现在只是兼容用的空操作，执行不会重建任何索引，也不会改变搜索结果。确定仍要调用吗？',
    confirmLabel: '仍然调用',
  },
  {
    key: 'clean-covers',
    label: '清理无主封面',
    title: '清理无主封面',
    body: '将删除封面目录中没有对应书籍记录的文件，并清掉指向缺失文件的封面引用；不会删除任何图书记录，也不会改动 /library 下的源文件。',
    confirmLabel: '确认清理无主封面',
  },
];

async function loadStats() {
  if (!isAdmin.value || !mounted) return;
  const scope = accountScope.value, g = scopeGeneration;
  statsLoading.value = true;
  statsError.value = '';
  try {
    const data = await fetchBookStats(api);
    if (currentScope(scope, g)) stats.value = data;
  } catch (e: any) {
    if (!currentScope(scope, g)) return;
    stats.value = null;
    statsError.value = integrationError('存储统计', e);
  } finally {
    if (currentScope(scope, g)) statsLoading.value = false;
  }
}
function askMaintenance(item: PendingMaintenance) {
  if (maintRunning.value) return;
  confirmState.value = {
    title: item.title,
    body: item.body,
    confirmLabel: item.confirmLabel,
    danger: item.key === 'clean-covers',
    run: () => runMaintenance(item.key),
  };
  void focusSheet(confirmEl);
}
async function runMaintenance(key: MaintKey) {
  maintRunning.value = key;
  maintMessage.value = '';
  maintError.value = '';
  try {
    if (key === 'vacuum') {
      maintMessage.value = vacuumMessage(await vacuumDatabase(api));
    } else if (key === 'rebuild-search') {
      // Compatibility no-op: show the server's own note, never claim a rebuild.
      maintMessage.value = rebuildSearchMessage(await rebuildSearch(api));
    } else {
      maintMessage.value = cleanCoversMessage(await cleanCovers(api));
    }
    await loadStats();
  } catch (e: any) {
    maintError.value = integrationError('维护操作', e);
  } finally {
    maintRunning.value = '';
  }
}

/* ---------- duplicates ---------- */

const dupGroups = ref<DuplicateGroup[]>([]);
const dupTotal = ref(0);
const dupLoading = ref(false);
const dupError = ref('');
const dupLoaded = ref(false);
const keepChoice = reactive<Record<string, number>>({});
const merging = ref('');
const mergeMessage = ref('');
const mergeError = ref('');

async function loadDuplicates() {
  if (!isAdmin.value || !mounted) return;
  const scope = accountScope.value, g = scopeGeneration;
  dupLoading.value = true;
  dupError.value = '';
  try {
    const data = await fetchDuplicates(api);
    if (!currentScope(scope, g)) return;
    dupGroups.value = Array.isArray(data?.items) ? data.items : [];
    dupTotal.value = Number(data?.total ?? dupGroups.value.length) || 0;
    dupLoaded.value = true;
  } catch (e: any) {
    if (!currentScope(scope, g)) return;
    dupGroups.value = [];
    dupTotal.value = 0;
    dupLoaded.value = false;
    dupError.value = integrationError('重复内容', e);
  } finally {
    if (currentScope(scope, g)) dupLoading.value = false;
  }
}
function askMerge(group: DuplicateGroup) {
  const keepId = keepChoice[group.content_hash];
  if (!keepId) return;
  const keep = group.books.find((b) => b.id === keepId);
  confirmState.value = {
    title: '合并重复记录',
    body: `将保留《${keep?.title ?? keepId}》，把同组另外 ${Math.max(0, group.books.length - 1)} 条记录合并进来。整个过程只修改数据库记录，不会移动或删除 /library 下的任何文件。`,
    count: group.books.length,
    confirmLabel: '确认合并',
    danger: false,
    run: () => doMerge(group, keepId),
  };
  void focusSheet(confirmEl);
}
async function doMerge(group: DuplicateGroup, keepId: number) {
  merging.value = group.content_hash;
  mergeMessage.value = '';
  mergeError.value = '';
  try {
    const result = await mergeDuplicates(api, group.books.map((b) => b.id), keepId);
    mergeMessage.value = mergeSummary(result, group.books.find((b) => b.id === keepId)?.title ?? '');
    delete keepChoice[group.content_hash];
    await Promise.all([loadDuplicates(), load(), loadStats()]);
  } catch (e: any) {
    mergeError.value = integrationError('合并重复记录', e);
  } finally {
    merging.value = '';
  }
}

/* ---------- detail sheet ---------- */

const detail = ref<ManageBook | null>(null);
const detailEl = ref<HTMLElement | null>(null);

function openDetail(book: ManageBook) {
  detail.value = book;
  void focusSheet(detailEl);
}

function setSort(value: ManageSort) {
  sort.value = value;
  onSortChange();
}

/* ---------- helpers ---------- */

function fmtTime(value: unknown): string {
  const ms = Number(value);
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}
function num(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
}
function wordCount(book: ManageBook): string {
  return book.word_count ? num(book.word_count) + ' 字' : '—';
}
function readText(book: ManageBook): string {
  if (book.last_read_at) return fmtTime(book.last_read_at);
  if (typeof book.read_count === 'number') return book.read_count > 0 ? `已读 ${book.read_count} 次` : '从未打开';
  return '—';
}
function statusTags(book: ManageBook): string[] {
  const tags: string[] = [];
  if (book.status === 'missing' || book.available_file_count === 0) tags.push('缺失');
  if (book.has_duplicate) tags.push('重复');
  if (book.has_cover === false) tags.push('无封面');
  return tags;
}
function fileText(book: ManageBook): string {
  if (book.file_count === undefined && book.available_file_count === undefined) return '—';
  const totalFiles = Number(book.file_count ?? 1);
  const available = Number(book.available_file_count ?? totalFiles);
  return `${available}/${totalFiles} 个可用`;
}

async function reloadScopedData() {
  await Promise.all([loadLibraries(), loadShelves(), load(), loadStats(), loadDuplicates()]);
}

async function refresh(withDuplicates = true) {
  await load();
  await Promise.all([loadStats(), withDuplicates && dupLoaded.value ? loadDuplicates() : Promise.resolve()]);
}

function confirmRun() {
  const pending = confirmState.value;
  if (!pending) return;
  confirmState.value = null;
  void pending.run();
}
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (confirmState.value) confirmState.value = null;
  else if (editOpen.value) editOpen.value = false;
  else if (detail.value) detail.value = null;
}

onMounted(async () => {
  mounted = true;
  window.addEventListener('keydown', onKeydown);
  if (!state.user) {
    await router.replace('/login');
    return;
  }
  if (!isAdmin.value) return;
  await reloadScopedData();
});
onBeforeUnmount(() => {
  mounted = false; scopeGeneration++; generation++; selectionGeneration++;
  clearTimeout(debounceTimer);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
<main v-if="!isAdmin" class="page admin-books">
  <div class="page-title"><div><h1>书籍管理</h1><p>仅管理员可用</p></div></div>
  <section class="panel">
    <h2>没有访问权限</h2>
    <p role="alert" class="error">书籍管理需要管理员账户；当前账户（{{ state.user?.username ?? '未登录' }}）无权打开这个页面。</p>
    <RouterLink class="button primary" to="/">返回书库</RouterLink>
  </section>
</main>

<main v-else class="page admin-books">
<div class="page-title">
  <div><h1>书籍管理</h1><p>{{state.user?.username}} · 管理员 · 共 {{num(total)}} 本符合当前筛选</p></div>
  <RouterLink class="button" to="/import">导入与书库</RouterLink>
</div>

<section class="panel">
  <h2>筛选</h2>
  <form class="toolbar" role="search" @submit.prevent="applySearch">
    <label class="sr-only" for="admin-books-search">搜索书名或作者</label>
    <input id="admin-books-search" v-model="q" type="search" placeholder="搜索书名或作者" @input="onSearchInput" @keydown.enter.prevent="applySearch">
    <button type="submit">搜索</button>
    <label class="sr-only" for="admin-books-library">书库筛选</label>
    <select id="admin-books-library" v-model="library" @change="onScopeChange">
      <option value="">所有书库</option>
      <option v-for="item in libraries" :key="item.id" :value="String(item.id)">{{item.name}}</option>
    </select>
    <label class="sr-only" for="admin-books-format">格式筛选</label>
    <select id="admin-books-format" v-model="format" @change="onScopeChange">
      <option value="">所有格式</option><option value="epub">EPUB</option><option value="txt">TXT</option><option value="pdf">PDF</option><option value="mobi">MOBI</option>
    </select>
    <label class="sr-only" for="admin-books-sort">排序</label>
    <select id="admin-books-sort" v-model="sort" @change="onSortChange">
      <option v-for="item in MANAGE_SORTS" :key="item.value" :value="item.value">{{item.label}}</option>
    </select>
    <label class="sr-only" for="admin-books-pagesize">每页数量</label>
    <select id="admin-books-pagesize" v-model.number="pageSize" @change="onPageSizeChange">
      <option :value="50">每页 50</option><option :value="100">每页 100</option><option :value="200">每页 200</option>
    </select>
  </form>
  <div class="chips" role="group" aria-label="问题图书视图">
    <button v-for="item in MANAGE_FILTERS" :key="item.value || 'all'" class="chip" :class="{active:filter===item.value}" :aria-pressed="filter===item.value" @click="setFilter(item.value)">{{item.label}}</button>
  </div>
  <p v-if="message" role="alert" class="error">{{message}}</p>
</section>

<section v-if="selectedCount" class="panel batch-bar">
  <div class="batch-head">
    <strong>已选中 {{selectedCount}} 本</strong>
    <button @click="clearSelection">清除选择</button>
  </div>
  <div class="batch-controls">
    <label>书架
      <select v-model="shelfId" aria-label="选择书架">
        <option value="">请选择书架</option>
        <option v-for="item in shelves" :key="item.id" :value="String(item.id)">{{item.name}}</option>
      </select>
    </label>
    <button :disabled="!shelfId||batchRunning" @click="askBatch('add_shelf',{shelf_id:Number(shelfId)})">加入书架</button>
    <button :disabled="!shelfId||batchRunning" @click="askBatch('remove_shelf',{shelf_id:Number(shelfId)})">移出书架</button>
    <label>目标书库
      <select v-model="libraryId" aria-label="选择目标书库">
        <option value="">请选择书库</option>
        <option v-for="item in libraries" :key="item.id" :value="String(item.id)">{{item.name}}</option>
      </select>
    </label>
    <button :disabled="!libraryId||batchRunning" @click="askBatch('set_library',{library_id:Number(libraryId)})">设为书库</button>
    <button :disabled="batchRunning" @click="askBatch('rescan')">重新扫描</button>
    <button :disabled="batchRunning" @click="askBatch('extract_cover')">提取封面</button>
    <ScrapeSources v-model="providers" :disabled="batchRunning" />
    <button :disabled="batchRunning" @click="askBatch('scrape',{providers})">刮削元数据</button>
    <button :disabled="batchRunning||selectAllBusy" @click="startIdentity">按内容识别并刮削</button>
    <button :disabled="batchRunning" @click="openBatchEdit">编辑元数据</button>
    <button class="danger" :disabled="batchRunning" @click="askBatch('delete_records')">删除记录</button>
  </div>
  <progress v-if="batchRunning" :value="batchProgress.done" :max="Math.max(1,batchProgress.total)" aria-label="批量处理进度"></progress>
  <p v-if="batchRunning" role="status">正在处理 {{batchProgress.done}} / {{batchProgress.total}} 本…</p>
</section>

<section v-if="failureTitle" class="panel">
  <h2>{{failureTitle}}结果</h2>
  <p v-if="resultMessage" role="status" class="status-banner">{{resultMessage}}</p>
  <p v-if="resultError" role="alert" class="error">{{resultError}}</p>
  <template v-if="failures.length">
    <h3>失败明细（{{failures.length}} 条）</h3>
    <ul class="failure-list">
      <li v-for="item in failures.slice(0,MAX_FAILURES_SHOWN)" :key="item.id">#{{item.id}} · {{item.reason}}</li>
    </ul>
    <p v-if="failures.length>MAX_FAILURES_SHOWN"><small>仅显示前 {{MAX_FAILURES_SHOWN}} 条，共 {{failures.length}} 条失败。</small></p>
  </template>
</section>

<section class="panel">
  <h2>图书表格</h2>
  <div class="selection-bar">
    <p role="status">已选中 {{selectedCount}} 本<template v-if="allSelectedFiltered"> · 已选中全部 {{num(total)}} 条筛选结果</template></p>
    <button v-if="canSelectAll" :disabled="selectAllBusy" @click="selectAllFiltered">
      {{selectAllBusy?`正在读取筛选结果 ${selectAllProgress.done}/${selectAllProgress.total}…`:`选中全部 ${num(total)} 条筛选结果`}}
    </button>
    <button v-if="selectedCount&&!canSelectAll" @click="clearSelection">清除选择</button>
  </div>
  <p v-if="selectAllError" role="alert" class="error">{{selectAllError}}</p>
  <p v-if="listError" role="alert" class="error">{{listError}} <button @click="load()">重试</button></p>
  <p v-else-if="loading&&!books.length" role="status">正在读取图书…</p>
  <template v-else>
    <div class="table-scroll">
      <table class="books-table">
        <caption class="sr-only">图书管理表格</caption>
        <thead>
          <tr>
            <th class="cell-check" scope="col">
              <label class="check-hit"><input type="checkbox" :checked="pageAllSelected" :indeterminate.prop="pageSomeSelected" :disabled="!books.length" aria-label="选择本页全部图书" @change="togglePage"></label>
            </th>
            <th scope="col"><span class="sr-only">封面</span></th>
            <th scope="col" :aria-sort="sort==='title'?'other':'none'"><button class="sort-button" :class="{active:sort==='title'}" @click="setSort('title')">书名</button></th>
            <th scope="col">作者</th>
            <th scope="col">格式</th>
            <th scope="col" :aria-sort="sort==='size'?'other':'none'"><button class="sort-button" :class="{active:sort==='size'}" @click="setSort('size')">大小</button></th>
            <th scope="col" :aria-sort="sort==='word_count'?'other':'none'"><button class="sort-button" :class="{active:sort==='word_count'}" @click="setSort('word_count')">字数</button></th>
            <th scope="col">书库</th>
            <th scope="col">状态</th>
            <th scope="col" :aria-sort="sort==='created'?'other':'none'"><button class="sort-button" :class="{active:sort==='created'}" @click="setSort('created')">加入时间</button></th>
            <th scope="col" :aria-sort="sort==='updated'?'other':'none'"><button class="sort-button" :class="{active:sort==='updated'}" @click="setSort('updated')">最近阅读</button></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="book in books" :key="book.id" :class="{picked:isSelected(book.id)}" @click="openDetail(book)">
            <td class="cell-check" data-label="选择">
              <label class="check-hit"><input type="checkbox" :checked="isSelected(book.id)" :aria-label="`选择《${book.title}》`" @click.stop @change="toggleRow(book.id)"></label>
            </td>
            <td class="cell-cover" data-label="封面"><div class="thumb"><BookCover :book="book"/></div></td>
            <td class="cell-title" data-label="书名"><button class="link-title" @click.stop="openDetail(book)">{{book.title}}</button></td>
            <td data-label="作者">{{book.author||'佚名'}}</td>
            <td data-label="格式">{{(book.format||'').toUpperCase()}}</td>
            <td data-label="大小" class="num">{{formatBytes(book.size)}}</td>
            <td data-label="字数" class="num">{{wordCount(book)}}</td>
            <td data-label="书库">{{libraryName(book.library_id)}}</td>
            <td data-label="状态">
              <span v-for="tag in statusTags(book)" :key="tag" class="tag" :class="tag==='缺失'?'tag-missing':tag==='重复'?'tag-dup':'tag-nocover'">{{tag}}</span>
              <span v-if="!statusTags(book).length" class="muted">正常</span>
            </td>
            <td data-label="加入时间">{{fmtTime(book.created_at)}}</td>
            <td data-label="最近阅读">{{readText(book)}}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!books.length" class="empty-inline">没有符合当前筛选条件的图书。</p>
    <div v-if="total>0" class="pagination">
      <button :disabled="page<=1" @click="go(page-1)">上一页</button>
      <span>第 {{page}} / {{pageCount}} 页 · 共 {{num(total)}} 本</span>
      <button :disabled="page>=pageCount" @click="go(page+1)">下一页</button>
    </div>
  </template>
</section>

<section class="panel">
  <h2>存储与健康</h2>
  <p v-if="statsLoading" role="status">正在读取存储统计…</p>
  <p v-else-if="statsError" role="alert" class="error">{{statsError}} <button @click="loadStats()">重试</button></p>
  <template v-else-if="stats">
    <dl class="stat-grid">
      <div><dt>图书总数</dt><dd>{{num(stats.books)}}</dd></div>
      <div><dt>总体积</dt><dd>{{formatBytes(stats.total_bytes)}}</dd></div>
      <div><dt>封面占用</dt><dd>{{formatBytes(stats.cover_bytes)}}</dd></div>
      <div><dt>数据库体积</dt><dd>{{formatBytes(stats.database_bytes)}}</dd></div>
      <div><dt>章节总数</dt><dd>{{num(stats.chapters)}}</dd></div>
      <div><dt>重复内容组</dt><dd>{{num(stats.duplicate_groups)}}</dd></div>
      <div><dt>源文件缺失</dt><dd>{{num(stats.missing_books)}}</dd></div>
    </dl>
    <h3>按书库</h3>
    <p v-if="!stats.libraries?.length" class="empty-inline">服务器没有返回书库明细。</p>
    <div v-for="item in stats.libraries" :key="item.id" class="list-row">
      <div><strong>{{item.name}}</strong><p>{{num(item.books)}} 本 · {{formatBytes(item.bytes)}}</p></div>
    </div>
  </template>
  <h3>维护</h3>
  <p>维护动作只作用于数据库与封面缓存，不会改动 /library 下的源文件。</p>
  <p><small>全文检索已改为按书精确匹配，不再需要索引；「重建全文索引」按钮只是保留的兼容接口，执行不会重建索引。删除或去索引后留下的空闲页只有 VACUUM 能回收。</small></p>
  <div class="row-actions">
    <button v-for="item in MAINTENANCE" :key="item.key" :disabled="maintRunning!==''" @click="askMaintenance(item)">
      {{maintRunning===item.key?'正在执行…':item.label}}
    </button>
  </div>
  <p v-if="maintError" role="alert" class="error">{{maintError}}</p>
  <p v-if="maintMessage" role="status" class="status-banner">{{maintMessage}}</p>
</section>

<section class="panel">
  <h2>重复内容</h2>
  <p>同一内容哈希下的多份记录。合并只修改数据库记录，不会移动或删除 /library 下的任何文件。</p>
  <p v-if="dupLoading" role="status">正在读取重复内容…</p>
  <p v-else-if="dupError" role="alert" class="error">{{dupError}} <button @click="loadDuplicates()">重试</button></p>
  <p v-else-if="!dupGroups.length" class="empty-inline">没有发现重复内容。</p>
  <template v-else>
    <p><small>共 {{num(dupTotal)}} 组重复内容。</small></p>
    <article v-for="group in dupGroups" :key="group.content_hash" class="dup-group">
      <h3>内容哈希 {{group.content_hash.slice(0,16)}}… · {{formatBytes(group.size)}} · {{group.books.length}} 本</h3>
      <ul class="dup-list">
        <li v-for="book in group.books" :key="book.id">
          <label class="dup-choice">
            <input type="radio" :name="'keep-'+group.content_hash" :value="book.id" v-model="keepChoice[group.content_hash]" :aria-label="`保留《${book.title}》`">
            保留
          </label>
          <div>
            <strong>{{book.title}}</strong>
            <p>{{book.path}} · {{(book.format||'').toUpperCase()}} · {{book.file_count}} 个文件<template v-if="book.is_primary"> · 主记录</template></p>
          </div>
        </li>
      </ul>
      <button class="primary" :disabled="!keepChoice[group.content_hash]||merging===group.content_hash" @click="askMerge(group)">
        {{merging===group.content_hash?'正在合并…':'合并这组'}}
      </button>
    </article>
  </template>
  <p v-if="mergeError" role="alert" class="error">{{mergeError}}</p>
  <p v-if="mergeMessage" role="status" class="status-banner">{{mergeMessage}}</p>
</section>

<div v-if="detail" class="modal-backdrop" @click.self="detail=null">
  <section ref="detailEl" class="sheet" role="dialog" aria-modal="true" aria-label="图书详情">
    <button class="close" @click="detail=null">关闭</button>
    <div class="detail-cover"><BookCover :book="detail"/></div>
    <h2>{{detail.title}}</h2>
    <p>{{detail.author||'佚名'}} · {{(detail.format||'').toUpperCase()}}</p>
    <h3>管理信息</h3>
    <dl class="review-meta">
      <dt>书库</dt><dd>{{libraryName(detail.library_id)}}</dd>
      <dt>文件大小</dt><dd>{{formatBytes(detail.size)}}</dd>
      <dt>字数</dt><dd>{{wordCount(detail)}}</dd>
      <dt>文件</dt><dd>{{fileText(detail)}}</dd>
      <dt>状态</dt><dd>{{statusTags(detail).length?statusTags(detail).join(' · '):'正常'}}</dd>
      <dt>封面</dt><dd>{{detail.has_cover===false?'没有封面':'有封面'}}</dd>
      <dt>加入时间</dt><dd>{{fmtTime(detail.created_at)}}</dd>
      <dt>最近更新</dt><dd>{{fmtTime(detail.updated_at)}}</dd>
      <dt>阅读次数</dt><dd>{{readText(detail)}}</dd>
    </dl>
    <h3>简介</h3>
    <p>{{detail.description||'暂无简介'}}</p>
    <div class="row-actions">
      <RouterLink class="button primary" :to="'/read/'+detail.id">打开阅读器</RouterLink>
      <button @click="detail=null">关闭</button>
    </div>
  </section>
</div>

<div v-if="confirmState" class="modal-backdrop" @click.self="confirmState=null">
  <section ref="confirmEl" class="sheet" role="dialog" aria-modal="true" aria-label="确认操作">
    <button class="close" @click="confirmState=null">关闭</button>
    <h2>{{confirmState.title}}</h2>
    <p v-if="confirmState.count!==undefined" class="confirm-count">将影响 <strong>{{confirmState.count}}</strong> 本图书。</p>
    <p>{{confirmState.body}}</p>
    <p v-if="confirmState.danger" role="alert" class="error">这是不可撤销的操作，请确认后再继续。</p>
    <div class="row-actions">
      <button class="primary" :class="{danger:confirmState.danger}" @click="confirmRun">{{confirmState.confirmLabel}}</button>
      <button @click="confirmState=null">取消</button>
    </div>
  </section>
</div>

<div v-if="editOpen" class="modal-backdrop" @click.self="editOpen=false">
  <section ref="editEl" class="sheet" role="dialog" aria-modal="true" aria-label="批量编辑元数据">
    <button class="close" @click="editOpen=false">关闭</button>
    <h2>批量编辑元数据</h2>
    <p class="confirm-count">将覆盖 <strong>{{selectedCount}}</strong> 本图书；留空的字段保持不变。</p>
    <label>书名<input v-model="editFields.title" placeholder="留空则不修改"></label>
    <label>作者<input v-model="editFields.author" placeholder="留空则不修改"></label>
    <label>简介<textarea v-model="editFields.description" rows="4" placeholder="留空则不修改"></textarea></label>
    <p v-if="editError" role="alert" class="error">{{editError}}</p>
    <div class="row-actions">
      <button class="primary" @click="submitBatchEdit">下一步：确认覆盖</button>
      <button @click="editOpen=false">取消</button>
    </div>
  </section>
</div>
</main>
</template>

<style scoped>
.admin-books .chips{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0}
.admin-books .chip{min-height:44px;padding:8px 14px;font-size:13px;border-radius:999px}
.admin-books .chip.active{background:var(--accent);border-color:var(--accent);color:#fff}
.admin-books .selection-bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin:0 0 12px}
.admin-books .selection-bar p{margin:0;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.admin-books .table-scroll{overflow-x:auto}
.admin-books .books-table{width:100%;border-collapse:collapse;font-size:14px;min-width:960px}
.admin-books .books-table caption{text-align:left}
.admin-books .books-table th,.admin-books .books-table td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);vertical-align:middle}
.admin-books .books-table th{font-size:13px;color:var(--muted);white-space:nowrap}
.admin-books .books-table tbody tr{cursor:pointer}
.admin-books .books-table tbody tr:hover{background:var(--surface-2)}
.admin-books .books-table tbody tr.picked{background:#e9f2ee}
.admin-books .books-table .num{font-variant-numeric:tabular-nums;white-space:nowrap}
.admin-books .cell-check{width:44px}
.admin-books .check-hit{display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;margin:0}
.admin-books .check-hit input{width:20px;height:20px;margin:0}
.admin-books .cell-cover{width:56px}
.admin-books .thumb{width:40px}
.admin-books .thumb :deep(.book-cover){width:40px;padding:3px;border-left-width:2px;border-radius:3px 5px 5px 3px}
.admin-books .thumb :deep(.book-cover strong){font-size:8px;-webkit-line-clamp:2;line-height:1.25}
.admin-books .thumb :deep(.book-cover span){font-size:6px}
.admin-books .sort-button{min-height:44px;padding:6px 8px;border:0;background:transparent;font-weight:700;color:inherit;justify-content:flex-start}
.admin-books .sort-button.active{color:var(--accent);text-decoration:underline}
.admin-books .link-title{min-height:44px;padding:6px 4px;border:0;background:transparent;font-weight:600;color:inherit;text-align:left;justify-content:flex-start;text-decoration:underline;text-decoration-color:transparent}
.admin-books .link-title:hover{text-decoration-color:currentColor;background:transparent;border-color:transparent}
.admin-books .tag{display:inline-flex;align-items:center;min-height:22px;padding:1px 8px;margin:0 4px 2px 0;border:1px solid var(--border);border-radius:999px;background:var(--surface-2);font-size:12px;font-weight:600;white-space:nowrap}
.admin-books .tag-missing{color:#942f23;border-color:#e0b4ae;background:#fdf1ef}
.admin-books .tag-dup{color:#7a5410;border-color:#e2cb9a;background:#fdf6e6}
.admin-books .tag-nocover{color:var(--muted)}
.admin-books .batch-bar{border-color:#bcd3ca}
.admin-books .batch-head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin:0 0 12px}
.admin-books .batch-controls{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.admin-books .batch-controls label{margin:0;flex:0 1 200px;min-width:150px;font-size:13px}
.admin-books .failure-list{margin:8px 0;padding-left:20px;font-size:13px;max-height:300px;overflow:auto;word-break:break-word}
.admin-books .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 20px;padding:0}
.admin-books .stat-grid>div{border:1px solid var(--border);border-radius:10px;padding:12px}
.admin-books .stat-grid dt{font-size:12px;color:var(--muted);font-weight:600}
.admin-books .stat-grid dd{margin:6px 0 0;font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;word-break:break-all}
.admin-books .dup-group{border-top:1px solid var(--border);padding:12px 0}
.admin-books .dup-list{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px}
.admin-books .dup-list li{display:flex;gap:12px;align-items:flex-start;word-break:break-word}
.admin-books .dup-list p{margin:4px 0 0;font-size:13px;color:var(--muted)}
.admin-books .dup-choice{display:flex;align-items:center;gap:6px;margin:0;min-height:44px;font-weight:600;white-space:nowrap}
.admin-books .dup-choice input{width:20px;height:20px;margin:0}
.admin-books .confirm-count{font-size:15px}
.admin-books .confirm-count strong{color:var(--accent);font-size:18px}
.admin-books button.danger{border-color:#d8a79e;color:#8f2c1f}
.admin-books button.primary.danger{background:#a33b2c;border-color:#a33b2c;color:#fff}
@media(max-width:650px){
  .admin-books .books-table{min-width:0}
  .admin-books .books-table thead{display:none}
  .admin-books .books-table,.admin-books .books-table tbody,.admin-books .books-table tr,.admin-books .books-table td{display:block;width:100%}
  .admin-books .books-table tr{border:1px solid var(--border);border-radius:10px;padding:8px 12px;margin:0 0 12px;background:var(--surface)}
  .admin-books .books-table td{display:flex;align-items:center;justify-content:space-between;gap:12px;border:0;padding:4px 0;min-height:36px;text-align:right}
  .admin-books .books-table td::before{content:attr(data-label);color:var(--muted);font-size:12px;font-weight:600;text-align:left}
  .admin-books .books-table td.cell-check{justify-content:flex-start;min-height:44px}
  .admin-books .books-table td.cell-check::before{content:'';display:none}
  .admin-books .cell-cover{width:auto}
  .admin-books .thumb{width:56px}
  .admin-books .thumb :deep(.book-cover){width:56px;padding:5px}
  .admin-books .thumb :deep(.book-cover strong){font-size:10px}
  .admin-books .thumb :deep(.book-cover span){font-size:7px}
  .admin-books .batch-controls label{flex:1 1 100%}
  .admin-books .dup-list li{flex-direction:column;gap:4px}
}
@media(prefers-color-scheme:dark){
  .admin-books .tag-missing{color:#f0c3bc;border-color:#5d3129;background:#3a1f1c}
  .admin-books .tag-dup{color:#e8d5a8;border-color:#5c4a22;background:#33290f}
  .admin-books .books-table tbody tr.picked{background:#243430}
}
</style>
