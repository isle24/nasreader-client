<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {api, state} from '../state';
import {mayReadWithLease} from '../licensing';
import {integrationError} from '../api/errors';
import {fetchLibraries} from '../api/management';
import {cancelScrapeEntry, fetchAIConfig, fetchScrapeQueue, retryFailedScrapes, type ScrapeQueueEntry} from '../api/metadata';
import {collectIdentityBookIDs, fetchIdentityReviews, IDENTITY_DISCLOSURE, identityProviderLabel, identityStatusLabel, prepareIdentityPreview, runIdentityEnqueue, runIdentityReviews, type IdentityFailure, type IdentityFormat, type IdentityPreview, type IdentityProvider, type IdentityReview, type IdentityStatus} from '../api/identity';
import {takeIdentitySelection, syncIdentitySelectionScope} from '../identitySelection';
import IdentityProviders from '../components/IdentityProviders.vue';
import IdentityReviewCard from '../components/IdentityReviewCard.vue';

const isAdmin = computed(() => state.user?.role === 'admin');
const accountKey = computed(() => JSON.stringify([state.server, state.user?.id, state.user?.role, state.accessEpoch]));
const handoff = ref<number[]>([]);
const library = ref(''), filter = ref<'suspicious_title' | 'all'>('suspicious_title'), format = ref<IdentityFormat>(''), q = ref('');
const providers = ref<IdentityProvider[]>(['openlibrary', 'google', 'neodb']);
const libraries = ref<{id: number; name: string}[]>([]);
const aiConfigured = ref(false), aiLoading = ref(true);
const error = ref(''), message = ref('');
const busy = ref(false), cancelled = ref(false), progress = ref({done: 0, total: 0, stage: ''});
const preview = ref<IdentityPreview | null>(null);
const failures = ref<IdentityFailure[]>([]);
const scopeKey = computed(() => JSON.stringify([accountKey.value, library.value, filter.value, format.value, q.value.trim(), providers.value, handoff.value]));
const active = (key: string, current: () => string) => isAdmin.value && accountKey.value.length > 0 && mayReadWithLease(state.license) && current() === key;
const scopeName = computed(() => handoff.value.length ? `书籍管理选中的 ${handoff.value.length} 本` : `${libraries.value.find(item => String(item.id) === library.value)?.name ?? '所有可访问书库'} · ${filter.value==='suspicious_title'?'疑似错误书名':'全部名称'}${format.value?' · '+format.value.toUpperCase():''}${q.value.trim()?' · 关键词「'+q.value.trim()+'」':''}`);
watch(scopeKey, () => {preview.value = null; cancelled.value = true});
watch(accountKey, () => {
  syncIdentitySelectionScope({server: state.server, userId: state.user?.id ?? 0});
  handoff.value = []; preview.value = null; cancelled.value = true; reviews.value = []; queue.value = []; selected.value = new Map(); failures.value = []; error.value = ''; message.value = ''; libraries.value = []; aiConfigured.value = false;
  if (isAdmin.value) void initialise();
}, {flush: 'sync'});
function discardHandoff() {handoff.value = []; preview.value = null}
async function makePreview() {
  const key = scopeKey.value, current = () => active(key, () => scopeKey.value);
  if (!current() || busy.value || !aiConfigured.value) return;
  busy.value = true; cancelled.value = false; error.value = ''; message.value = ''; failures.value = []; preview.value = null;
  try {
    let ids = [...handoff.value];
    if (!ids.length) {
      progress.value = {done: 0, total: 0, stage: '读取完整筛选范围'};
      ids = await collectIdentityBookIDs(api, {library: library.value, filter: filter.value==='all'?'':filter.value, format: format.value, q: q.value}, () => current() && !cancelled.value, (done, total) => {progress.value = {done, total, stage: '读取完整筛选范围'}});
    }
    if (!ids.length) {message.value = '当前范围没有可识别的图书。'; return}
    progress.value = {done: 0, total: ids.length, stage: '只读预览'};
    const result = await prepareIdentityPreview(api, {
      book_ids: ids, providers: [...providers.value],
      library_id: !handoff.value.length && library.value ? Number(library.value) : undefined,
      format: handoff.value.length ? undefined : format.value,
    }, key, {isCurrent: current, shouldCancel: () => cancelled.value, onProgress: (done, total) => {progress.value = {done, total, stage: '只读预览'}}});
    if (current() && !cancelled.value) preview.value = result;
  } catch (e) {if (current()) error.value = integrationError('预览识别范围', e)}
  finally {busy.value = false}
}
async function confirmEnqueue() {
  const item = preview.value;
  if (!item || busy.value) return;
  const key = item.scopeKey, current = () => active(key, () => scopeKey.value);
  busy.value = true; cancelled.value = false; preview.value = null; error.value = ''; failures.value = [];
  try {
    const outcome = await runIdentityEnqueue(api, item, {confirmed: true, isCurrent: current, shouldCancel: () => cancelled.value, onProgress: (done, total) => {progress.value = {done, total, stage: '加入识别队列'}}});
    if (!current()) return;
    message.value = `已提交 ${outcome.submitted} / ${outcome.requested} 本：新增 ${outcome.enqueued} 本，复用 ${outcome.reused} 本，跳过 ${outcome.skipped} 本；失败 ${outcome.failed.length} 本。${outcome.remaining ? `已停止，剩余 ${outcome.remaining} 本未提交。` : '识别结果将进入候选审核。'}`;
    failures.value = outcome.failed;
    await refreshQueue();
  } catch (e) {if (current()) error.value = integrationError('加入识别队列', e)}
  finally {busy.value = false}
}

const reviews = ref<IdentityReview[]>([]), reviewTotal = ref(0), reviewPage = ref(1);
const reviewStatus = ref<IdentityStatus>('pending'), reviewLibrary = ref(''), reviewQ = ref('');
const reviewLoading = ref(false), reviewError = ref('');
const selected = ref<Map<number, boolean>>(new Map());
const selectedCount = computed(() => selected.value.size);
const canApplySelected = computed(() => [...selected.value.values()].every(Boolean));
const reviewScope = computed(() => JSON.stringify([accountKey.value, reviewLibrary.value, reviewStatus.value, reviewQ.value.trim()]));
const reviewPages = computed(() => Math.max(1, Math.ceil(reviewTotal.value / 20)));
const reviewConfirmation = ref<{ids: number[]; action: 'apply' | 'reject'; scope: string} | null>(null);
let reviewGeneration = 0;
watch(reviewScope, () => {selected.value = new Map(); reviewConfirmation.value = null; reviewPage.value = 1; if (isAdmin.value) void loadReviews()});
async function loadReviews() {
  if (!isAdmin.value) return;
  const key = reviewScope.value, generation = ++reviewGeneration;
  reviewLoading.value = true; reviewError.value = '';
  try {
    const data = await fetchIdentityReviews(api, {status: reviewStatus.value, library: reviewLibrary.value, q: reviewQ.value, page: reviewPage.value});
    if (!active(key, () => reviewScope.value) || generation !== reviewGeneration) return;
    reviews.value = data.items; reviewTotal.value = data.total;
    if (reviewPage.value > reviewPages.value) {reviewPage.value = reviewPages.value; void loadReviews()}
  } catch (e) {if (key === reviewScope.value && generation === reviewGeneration) {reviews.value = []; reviewError.value = integrationError('读取识别候选', e)}}
  finally {if (generation === reviewGeneration) reviewLoading.value = false}
}
function toggleReview(review: IdentityReview) {
  const next = new Map(selected.value);
  if (next.has(review.id)) next.delete(review.id); else next.set(review.id, review.can_apply);
  selected.value = next;
}
function selectPage() {
  const next = new Map(selected.value), all = reviews.value.every(item => next.has(item.id));
  for (const item of reviews.value) {if (all) next.delete(item.id); else next.set(item.id, item.can_apply)}
  selected.value = next;
}
async function selectAllReviews() {
  if (busy.value || reviewStatus.value !== 'pending') return;
  const key = reviewScope.value, current = () => active(key, () => reviewScope.value);
  busy.value = true; cancelled.value = false; reviewError.value = '';
  try {
    const rows = new Map<number, boolean>(); let total: number | undefined;
    for (let page = 1; ; page++) {
      if (!current() || cancelled.value) throw new Error('选择范围已变化或停止，请重新选择');
      const data = await fetchIdentityReviews(api, {status: 'pending', library: reviewLibrary.value, q: reviewQ.value, page});
      if (!current() || cancelled.value || (total !== undefined && total !== data.total)) throw new Error('候选范围已变化，请重新选择');
      total = data.total;
      for (const item of data.items) {if (rows.has(item.id)) throw new Error('候选范围已变化，请重新选择'); rows.set(item.id, item.can_apply)}
      progress.value = {done: rows.size, total, stage: '读取全部候选'};
      if (rows.size === total) break;
      if (data.items.length < 20 || rows.size > total) throw new Error('候选范围未完整返回，请重新选择');
    }
    if (current()) selected.value = rows;
  } catch (e) {if (current()) reviewError.value = integrationError('选择全部候选', e)}
  finally {busy.value = false}
}
function askReview(action: 'apply' | 'reject') {
  if (!selectedCount.value || busy.value || reviewStatus.value !== 'pending') return;
  if (action === 'apply' && !canApplySelected.value) {reviewError.value = '选中候选中有失效或无应用权限的项，请保留核对或拒绝。'; return}
  reviewConfirmation.value = {ids: [...selected.value.keys()], action, scope: reviewScope.value};
}
async function confirmReview() {
  const item = reviewConfirmation.value; reviewConfirmation.value = null;
  if (!item || busy.value) return;
  const current = () => active(item.scope, () => reviewScope.value);
  busy.value = true; cancelled.value = false; failures.value = []; error.value = ''; message.value = '';
  try {
    const outcome = await runIdentityReviews(api, item.ids, item.action, {isCurrent: current, shouldCancel: () => cancelled.value, onProgress: (done, total) => {progress.value = {done, total, stage: item.action==='apply'?'应用候选':'拒绝候选'}}});
    if (!current()) return;
    const next = new Map(selected.value); for (const id of outcome.succeededIDs) next.delete(id); selected.value = next;
    failures.value = outcome.failed;
    message.value = `应用 ${outcome.applied} 条，拒绝 ${outcome.rejected} 条，失败 ${outcome.failed.length} 条；冲突与失败候选保留待核对。${outcome.remaining ? `已停止，剩余 ${outcome.remaining} 条未提交。` : ''}`;
    await loadReviews();
  } catch (e) {if (current()) error.value = integrationError('审核候选', e)}
  finally {busy.value = false}
}
function changePage(delta: number) {reviewPage.value = Math.min(reviewPages.value, Math.max(1, reviewPage.value + delta)); void loadReviews()}

const queue = ref<ScrapeQueueEntry[]>([]), sharedQueueTotal = ref(0), sharedQueueShown = ref(0), queueError = ref('');
async function refreshQueue() {
  if (!isAdmin.value) return;
  const key = accountKey.value;
  try {
    const result = await fetchScrapeQueue(api, '', 50);
    if (!active(key, () => accountKey.value)) return;
    queue.value = result.items.filter(item => item.provider === 'identity'); sharedQueueTotal.value = result.total; sharedQueueShown.value = result.items.length; queueError.value = '';
  } catch (e) {if (key === accountKey.value) queueError.value = integrationError('读取识别任务', e)}
}
async function cancelOne(entry: ScrapeQueueEntry) {
  const key = accountKey.value;
  try {await cancelScrapeEntry(api, entry.id); if (active(key, () => accountKey.value)) {message.value = `已取消图书 #${entry.book_id} 的任务。`; await refreshQueue()}}
  catch (e) {if (key === accountKey.value) queueError.value = integrationError('取消识别任务', e)}
}
async function retryQueue() {
  const key = accountKey.value;
  try {const result = await retryFailedScrapes(api); if (active(key, () => accountKey.value)) {message.value = `共享队列已重新排队 ${result.retried ?? result.requeued ?? 0} 条失败任务。`; await refreshQueue()}}
  catch (e) {if (key === accountKey.value) queueError.value = integrationError('重试共享队列', e)}
}
async function initialise() {
  if (!isAdmin.value) return;
  const key = accountKey.value; aiLoading.value = true;
  try {
    const [list, ai] = await Promise.all([fetchLibraries(api), fetchAIConfig(api)]);
    if (key !== accountKey.value || !isAdmin.value) return;
    libraries.value = list.items; aiConfigured.value = ai.configured;
  } catch (e) {if (key === accountKey.value) error.value = integrationError('读取识别设置', e)}
  finally {if (key === accountKey.value) aiLoading.value = false}
  if (key === accountKey.value) await Promise.all([loadReviews(), refreshQueue()]);
}
let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (!isAdmin.value) return;
  handoff.value = takeIdentitySelection({server: state.server, userId: state.user!.id});
  void initialise();
  poll = setInterval(() => {if (isAdmin.value && !busy.value) {void refreshQueue(); if (queue.value.some(item => item.status==='running'||item.status==='pending')) void loadReviews()}}, 3000);
});
onBeforeUnmount(() => {cancelled.value = true; reviewGeneration++; if (poll) clearInterval(poll)});
</script>

<template><main class="page admin-identity">
<div class="page-title"><div><h1>按内容识别并刮削</h1><p>保留分篇名称与序号，审核后更新资料及系列集合。</p></div><RouterLink class="button" to="/admin/books">书籍管理</RouterLink></div>
<section v-if="!isAdmin" class="panel"><h2>没有访问权限</h2><p class="error" role="alert">内容识别需要管理员账户；当前账户无权使用此工作流。</p><RouterLink to="/">返回书库</RouterLink></section>
<template v-else>
<p v-if="error" class="error" role="alert">{{error}}</p><p v-if="message" class="status-banner" role="status">{{message}}</p>
<section class="panel"><h2>选择识别范围</h2><p v-if="handoff.length">书籍管理已交接 {{handoff.length}} 本；全部选择将按每次最多 500 本提交。<button :disabled="busy" @click="discardHandoff">改为筛选范围</button></p>
<form v-else class="toolbar" @submit.prevent="makePreview"><label>书库<select v-model="library" aria-label="识别书库" :disabled="busy"><option value="">所有可访问书库</option><option v-for="item in libraries" :key="item.id" :value="String(item.id)">{{item.name}}</option></select></label><label>名称筛选<select v-model="filter" aria-label="识别名称筛选" :disabled="busy"><option value="suspicious_title">疑似错误书名</option><option value="all">全部名称</option></select></label><label>格式<select v-model="format" aria-label="识别格式" :disabled="busy"><option value="">TXT / EPUB / MOBI / PDF</option><option value="txt">TXT</option><option value="epub">EPUB</option><option value="mobi">MOBI</option><option value="pdf">PDF</option></select></label><label>关键词<input v-model="q" aria-label="识别关键词" type="search" placeholder="书名或作者" :disabled="busy"></label></form>
<IdentityProviders v-model="providers" :disabled="busy"/><p class="disclosure">{{IDENTITY_DISCLOSURE}}</p><p class="muted">PDF 仅提取少量文字页；图像或加密文件没有可读正文时，需要手动线索。</p><p v-if="!aiLoading&&!aiConfigured" class="status-banner">AI 尚未配置，请先在<RouterLink to="/admin/metadata">元数据刮削</RouterLink>保存模型配置。</p><button class="primary" :disabled="busy||aiLoading||!aiConfigured" @click="makePreview">预览识别范围</button>
<div v-if="preview" class="identity-preview" role="region" aria-label="识别范围确认"><h3>发送前确认</h3><p>{{scopeName}}</p><p>本次完整选择 {{preview.total}} 本 · 可新排队 {{preview.eligible}} 本 · 已有任务 {{preview.reused}} 本 · 预检失败／跳过 {{preview.skipped}} 本。</p><p>目录次序：{{preview.providers.map(identityProviderLabel).join(' → ')}}</p><p>{{IDENTITY_DISCLOSURE}}</p><ul v-if="preview.failed.length"><li v-for="item in preview.failed.slice(0,50)" :key="item.id">#{{item.id}} · {{item.reason}}</li></ul><p v-if="preview.failed.length>50">仅显示前 50 条，共 {{preview.failed.length}} 条预检失败。</p><div class="toolbar"><button class="primary" :disabled="busy||!preview.eligible" @click="confirmEnqueue">确认发送摘录并加入队列</button><button @click="preview=null">返回调整</button></div></div></section>
<section v-if="busy" class="panel" role="status"><p>{{progress.stage}}：{{progress.done}} / {{progress.total}}</p><progress :value="progress.done" :max="Math.max(1,progress.total)" aria-label="识别与审核批量进度"></progress><button :disabled="cancelled" @click="cancelled=true">{{cancelled?'正在停止后续批次…':'停止后续批次'}}</button><p class="muted">已提交的任务可在下面取消；停止会保留已完成结果。</p></section>
<section v-if="failures.length" class="panel"><h2>失败与冲突（{{failures.length}} 条）</h2><ul class="failures"><li v-for="item in failures" :key="item.id">#{{item.id}} · {{item.reason}}</li></ul></section>
<section class="panel"><div class="section-title"><h2>识别候选审核</h2><button :disabled="reviewLoading||busy" @click="loadReviews">刷新候选</button></div><div class="toolbar"><label>状态<select v-model="reviewStatus" aria-label="候选状态" :disabled="busy"><option value="pending">待审核</option><option value="applied">已应用</option><option value="rejected">已拒绝</option></select></label><label>书库<select v-model="reviewLibrary" aria-label="审核书库" :disabled="busy"><option value="">所有可访问书库</option><option v-for="item in libraries" :key="item.id" :value="String(item.id)">{{item.name}}</option></select></label><label>关键词<input v-model="reviewQ" aria-label="候选关键词" type="search" :disabled="busy"></label></div>
<p role="status">共 {{reviewTotal}} 条{{reviewStatus==='pending'?'待审核':'记录'}} · 已选 {{selectedCount}} 条</p><div v-if="reviewStatus==='pending'" class="toolbar"><button :disabled="busy||!reviews.length" @click="selectPage">选择／取消本页</button><button v-if="reviewTotal>selectedCount" :disabled="busy||reviewLoading" @click="selectAllReviews">选中全部 {{reviewTotal}} 条待审核</button><button v-if="selectedCount" :disabled="busy" @click="selected=new Map()">清除候选选择</button><button class="primary" :disabled="busy||!selectedCount||!canApplySelected" @click="askReview('apply')">应用选中（{{selectedCount}}）</button><button :disabled="busy||!selectedCount" @click="askReview('reject')">拒绝选中（{{selectedCount}}）</button></div>
<p v-if="reviewError" class="error" role="alert">{{reviewError}}</p><p v-if="reviewLoading&&!reviews.length">正在读取候选…</p><p v-else-if="!reviews.length&&!reviewError" class="muted">此范围没有候选。</p><IdentityReviewCard v-for="review in reviews" :key="review.id" :review="review" :selected="selected.has(review.id)" :disabled="busy" @toggle="toggleReview(review)"/>
<div v-if="reviewTotal" class="pagination"><button :disabled="reviewPage<=1||busy" @click="changePage(-1)">上一页</button><span>{{reviewPage}} / {{reviewPages}} 页 · 共 {{reviewTotal}} 条</span><button :disabled="reviewPage>=reviewPages||busy" @click="changePage(1)">下一页</button></div></section>
<section class="panel"><div class="section-title"><h2>内容识别＋刮削任务</h2><RouterLink class="button" to="/admin/metadata">完整共享队列</RouterLink></div><div class="toolbar"><button @click="refreshQueue">刷新任务</button><button @click="retryQueue">重试共享队列全部失败任务</button></div><p class="muted">共享队列共 {{sharedQueueTotal}} 条；最近 {{sharedQueueShown}} 条中有 {{queue.length}} 条内容识别任务。</p><p v-if="queueError" class="error" role="alert">{{queueError}}</p><p v-if="!queue.length&&!queueError">最近任务中没有内容识别记录。</p><div v-for="entry in queue" :key="entry.id" class="list-row"><div><strong>{{entry.title||('图书 #'+entry.book_id)}}</strong><p>{{identityProviderLabel(entry.provider)}} · {{identityStatusLabel(entry.status)}}<template v-if="entry.error"> · {{entry.error}}</template></p><p v-for="(outcome,index) in entry.outcomes" :key="index">{{identityProviderLabel(outcome.provider)}} · {{identityStatusLabel(outcome.status)}} · {{outcome.reviews?outcome.reviews+' 个候选待审核':outcome.error||outcome.note||'已完成此阶段'}}</p></div><button v-if="entry.status==='pending'||entry.status==='running'" @click="cancelOne(entry)">取消任务</button></div></section>
<div v-if="reviewConfirmation" class="modal-backdrop" @click.self="reviewConfirmation=null"><section class="sheet" role="dialog" aria-modal="true" aria-label="候选审核确认"><h2>{{reviewConfirmation.action==='apply'?'应用':'拒绝'}} {{reviewConfirmation.ids.length}} 条候选</h2><p v-if="reviewConfirmation.action==='apply'">审核后更新书名、作者、简介、封面与系列卷号。失效或资料冲突的候选会保留待核对；每批最多 20 条，成功结果会保留。</p><p v-else>选中的候选将标为已拒绝，图书当前资料保持不变。每批最多 20 条。</p><div class="toolbar"><button class="primary" @click="confirmReview">确认{{reviewConfirmation.action==='apply'?'应用':'拒绝'}} {{reviewConfirmation.ids.length}} 条</button><button @click="reviewConfirmation=null">返回核对</button></div></section></div>
</template></main></template>
<style scoped>
.admin-identity{overflow-wrap:anywhere}.admin-identity .toolbar{align-items:end}.admin-identity .toolbar label{display:grid;gap:6px;min-width:0}.admin-identity .toolbar label input,.admin-identity .toolbar label select{width:100%;min-width:0}.disclosure{font-size:14px;line-height:1.7}.muted{font-size:13px;line-height:1.6;color:var(--muted)}.identity-preview{margin-top:18px;border:1px solid var(--accent);border-radius:12px;padding:16px;background:var(--bg)}.identity-preview h3{font-size:16px;margin-top:0}.identity-preview p{line-height:1.7}.section-title{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}.section-title h2{margin:0 0 12px}.failures{max-height:300px;overflow:auto;padding-left:22px;font-size:13px}.failures li{margin:8px 0}.admin-identity progress{width:100%;display:block;margin:10px 0}.admin-identity .list-row>div{min-width:0}.admin-identity .list-row p{font-size:13px;line-height:1.6}.admin-identity .sheet{max-height:90vh;overflow:auto}.admin-identity .pagination{flex-wrap:wrap}@media(max-width:500px){.admin-identity .toolbar{display:flex;flex-wrap:wrap}.admin-identity .toolbar label{flex:1 1 130px}.admin-identity .toolbar button{max-width:100%;white-space:normal}.identity-preview{padding:12px}.admin-identity .list-row{align-items:start;flex-wrap:wrap}}
</style>
