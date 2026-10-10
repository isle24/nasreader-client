<script setup lang="ts">
// 元数据刮削与 AI 辅助（管理员，/#/admin/metadata）。
//
// 三段式：AI 引擎配置（含 获取模型 / 测试连接）、离线优先的整库刮削队列、
// 两种 AI 辅助模式（失败重试 / 全部），外加随时可用的手动元数据编辑。
// 所有网络调用都走 src/api/metadata.ts 的辅助函数；页面只管理状态与呈现，
// 服务端未实现时显示明确的「暂不可用」，绝不伪造数字或列表。
import {computed,onBeforeUnmount,onMounted,reactive,ref} from 'vue';
import {identityProviderLabel,identityStatusLabel} from '../api/identity';
import ScrapeSources from '../components/ScrapeSources.vue';
import {api,state} from '../state';
import {integrationError} from '../api/errors';
import {
  AI_ASSIST_LIMIT,
  AI_BASE_HINTS,
  AI_PROVIDERS,
  DEFAULT_SCRAPE_LIMIT,
  MAX_SCRAPE_LIMIT,
  QUEUE_PAGE_LIMIT,
  SCRAPE_FILTERS,
  SCRAPE_PROVIDERS,
  aiAssistConfirmText,
  buildAIConfigUpdate,
  buildScrapeQueueBody,
  cancelAllScrapes,
  cancelScrapeEntry,
  clearCover,
  enqueueScrape,
  extractCover,
  fetchAIConfig,
  fetchAIModels,
  fetchScrapeQueue,
  fetchScrapeStatus,
  isActiveQueue,
  previewAIAssist,
  retryFailedScrapes,
  runAIAssist,
  saveAIConfig,
  searchBooks,
  updateBook,
  uploadCover,
  type AIModel,
  type AIMode,
  type AIProvider,
  type EditBook,
  type QueueStatus,
  type ScrapeFilter,
  type ScrapeProvider,
  type ScrapeQueueEntry,
  type ScrapeStatusCounts,
} from '../api/metadata';

const isAdmin = computed(() => state.user?.role === 'admin');
const error = ref('');
const message = ref('');

/* ---------- AI 配置 ---------- */

const ai = reactive({
  provider: 'openai' as AIProvider,
  base_url: '',
  model: '',
  has_api_key: false,
  temperature: 0.2,
  max_tokens: 1024,
  configured: false,
});
const apiKey = ref('');
const aiLoaded = ref(false);
const saveBusy = ref(false);
const models = ref<AIModel[]>([]);
const modelsBusy = ref(false);
const modelsNote = ref('');
const baseHint = computed(() => AI_BASE_HINTS[ai.provider] || '自定义端点需要填写完整地址');

async function loadAI() {
  error.value = '';
  try {
    Object.assign(ai, await fetchAIConfig(api));
    aiLoaded.value = true;
  } catch (e) {
    aiLoaded.value = false;
    error.value = integrationError('读取 AI 配置', e);
  }
}

async function discoverModels() {
  modelsBusy.value = true;
  modelsNote.value = '';
  error.value = '';
  try {
    models.value = await fetchAIModels(api);
    modelsNote.value = models.value.length ? `获取到 ${models.value.length} 个模型，选择一个后点击「保存」。` : '端点可访问，但没有返回任何模型。';
  } catch (e) {
    models.value = [];
    modelsNote.value = integrationError('获取模型', e);
  } finally {
    modelsBusy.value = false;
  }
}

async function saveAI(clearKey = false) {
  saveBusy.value = true;
  error.value = '';
  message.value = '';
  try {
    Object.assign(ai, await saveAIConfig(api, buildAIConfigUpdate(ai, apiKey.value, clearKey)));
    apiKey.value = '';
    message.value = clearKey ? '已清除 API 密钥' : 'AI 配置已保存';
  } catch (e) {
    error.value = integrationError('保存 AI 配置', e);
  } finally {
    saveBusy.value = false;
  }
}

async function testConnection() {
  await discoverModels();
  if (models.value.length) message.value = `连接成功：端点返回 ${models.value.length} 个模型`;
}

/* ---------- 刮削队列 ---------- */

const providers=ref<ScrapeProvider[]>(['embedded','neodb','openlibrary','google']);
const filter = ref<ScrapeFilter>('all');
const limit = ref(DEFAULT_SCRAPE_LIMIT);
const queueStatus = ref<QueueStatus | ''>('');
const queue = ref<ScrapeQueueEntry[]>([]);
const queueTotal = ref(0);
const queueBusy = ref(false);
const counts = ref<ScrapeStatusCounts>({pending: 0, running: 0, done: 0, completed: 0, failed: 0, cancelled: 0, total: 0, last_error: ''});
let poll: ReturnType<typeof setInterval> | undefined;
let generation = 0;

async function refreshQueue() {
  const g = ++generation;
  try {
    const data = await fetchScrapeQueue(api, queueStatus.value, QUEUE_PAGE_LIMIT);
    if (g !== generation) return;
    queue.value = data.items;
    queueTotal.value = data.total;
  } catch (e) {
    if (g !== generation) return;
    queue.value = [];
    queueTotal.value = 0;
    error.value = integrationError('读取刮削队列', e);
  }
}

async function refreshStatus() {
  try {
    counts.value = await fetchScrapeStatus(api);
    if (isActiveQueue(counts.value)) startPolling();
    else stopPolling();
  } catch (e) {
    error.value = integrationError('读取刮削进度', e);
  }
}

function startPolling() {
  if (poll) return;
  poll = setInterval(() => {
    void refreshStatus();
    void refreshQueue();
  }, 2000);
}

function stopPolling() {
  if (!poll) return;
  clearInterval(poll);
  poll = undefined;
}

async function startScrape() {
  queueBusy.value = true;
  error.value = '';
  message.value = '';
  try {
    const result = await enqueueScrape(api, buildScrapeQueueBody({providers: providers.value, filter: filter.value, limit: limit.value}));
    const failed = result.failed?.length ?? 0;
    message.value = `已加入 ${result.enqueued} 本（复用 ${result.reused ?? 0} 本，跳过 ${result.skipped} 本）` + (failed ? `，${failed} 本无效` : '');
    await refreshStatus();
    await refreshQueue();
  } catch (e) {
    error.value = integrationError('加入刮削队列', e);
  } finally {
    queueBusy.value = false;
  }
}

async function cancelOne(entry: ScrapeQueueEntry) {
  try {
    await cancelScrapeEntry(api, entry.id);
    message.value = `已取消《${entry.title || entry.book_id}》的刮削`;
    await refreshQueue();
    await refreshStatus();
  } catch (e) {
    error.value = integrationError('取消刮削', e);
  }
}

async function cancelEverything() {
  try {
    const result = await cancelAllScrapes(api);
    message.value = `已取消 ${result.cancelled} 条刮削任务`;
    await refreshQueue();
    await refreshStatus();
  } catch (e) {
    error.value = integrationError('取消全部刮削', e);
  }
}

async function retryFailed() {
  try {
    const result = await retryFailedScrapes(api);
    message.value = `已重新排队 ${result.retried ?? result.requeued ?? 0} 条失败任务`;
    await refreshStatus();
    await refreshQueue();
  } catch (e) {
    error.value = integrationError('重试失败任务', e);
  }
}

/* ---------- AI 辅助 ---------- */

const confirm = ref<{mode: AIMode; total: number; text: string} | null>(null);
const confirmBusy = ref(false);

async function askAssist(mode: AIMode) {
  error.value = '';
  message.value = '';
  if (!ai.configured) {
    error.value = 'AI 尚未配置：请先填写服务地址、模型与 API 密钥并保存。';
    return;
  }
  try {
    const preview = await previewAIAssist(api, mode, filter.value, AI_ASSIST_LIMIT);
    confirm.value = {mode, total: preview.total, text: aiAssistConfirmText(preview.total, mode)};
  } catch (e) {
    error.value = integrationError('AI 辅助', e);
  }
}

async function runConfirmedAssist() {
  const pending = confirm.value;
  if (!pending) return;
  confirmBusy.value = true;
  try {
    const result = await runAIAssist(api, {mode: pending.mode, filter: filter.value || 'all', limit: AI_ASSIST_LIMIT});
    message.value = `AI 辅助已加入 ${result.enqueued} 本（跳过 ${result.skipped} 本）；结果会进入元数据审核。`;
    confirm.value = null;
    await refreshStatus();
    await refreshQueue();
  } catch (e) {
    error.value = integrationError('AI 辅助', e);
  } finally {
    confirmBusy.value = false;
  }
}

/* ---------- 手动编辑 ---------- */

const query = ref('');
const results = ref<EditBook[]>([]);
const searchBusy = ref(false);
const selected = ref<EditBook | null>(null);
const bookBusy = ref(false);
const edit = reactive({title: '', author: '', description: ''});
const coverInput = ref<HTMLInputElement | null>(null);

async function search() {
  searchBusy.value = true;
  error.value = '';
  try {
    results.value = await searchBooks(api, query.value);
    if (!results.value.length) message.value = '没有匹配的图书';
  } catch (e) {
    results.value = [];
    error.value = integrationError('搜索图书', e);
  } finally {
    searchBusy.value = false;
  }
}

function selectBook(book: EditBook) {
  selected.value = book;
  edit.title = book.title ?? '';
  edit.author = book.author ?? '';
  edit.description = book.description ?? '';
  message.value = '';
}

async function saveBook() {
  if (!selected.value) return;
  bookBusy.value = true;
  try {
    const saved = await updateBook(api, selected.value.id, {title: edit.title, author: edit.author, description: edit.description});
    selected.value = {...selected.value, ...saved};
    message.value = '元数据已保存';
  } catch (e) {
    error.value = integrationError('保存元数据', e);
  } finally {
    bookBusy.value = false;
  }
}

async function reloadSelected() {
  if (!selected.value) return;
  const found = results.value.find((item) => item.id === selected.value?.id);
  if (found) selected.value = found;
}

async function pickCover(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !selected.value) return;
  bookBusy.value = true;
  try {
    await uploadCover(api, selected.value.id, file);
    message.value = '封面已上传';
    await reloadSelected();
  } catch (e) {
    error.value = integrationError('上传封面', e);
  } finally {
    bookBusy.value = false;
    if (coverInput.value) coverInput.value.value = '';
  }
}

async function pullCoverFromEPUB() {
  if (!selected.value) return;
  bookBusy.value = true;
  try {
    await extractCover(api, selected.value.id);
    message.value = '已从文件内提取封面';
    await reloadSelected();
  } catch (e) {
    error.value = integrationError('提取封面', e);
  } finally {
    bookBusy.value = false;
  }
}

async function removeCover() {
  if (!selected.value) return;
  bookBusy.value = true;
  try {
    await clearCover(api, selected.value.id);
    message.value = '封面已删除';
    await reloadSelected();
  } catch (e) {
    error.value = integrationError('删除封面', e);
  } finally {
    bookBusy.value = false;
  }
}

onMounted(async () => {
  if (!isAdmin.value) return;
  await loadAI();
  await refreshStatus();
  await refreshQueue();
});
onBeforeUnmount(stopPolling);
</script>

<template>
  <main class="page metadata-admin">
    <div class="page-title">
      <div><h1>元数据刮削</h1><p>离线优先补全书名、作者、简介与封面；AI 辅助可选，结果都进入元数据审核。</p></div>
    </div>

    <p v-if="!isAdmin" role="alert" class="error">仅管理员可以配置刮削与 AI 辅助。</p>
    <template v-else>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="message" role="status" class="status-banner">{{ message }}</p>

      <section class="panel">
        <h2>AI 引擎（可选）</h2>
        <p v-if="!aiLoaded" class="muted">正在读取配置…</p>
        <p v-else-if="!ai.configured" class="status-banner">AI 未配置：刮削仍可用「内嵌元数据」和「文件名解析」离线完成；配置后可启用 AI 辅助。</p>
        <form @submit.prevent="saveAI(false)">
          <label>服务类型
            <select v-model="ai.provider" aria-label="AI 服务类型">
              <option v-for="item in AI_PROVIDERS" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label>服务地址
            <input v-model="ai.base_url" type="url" :placeholder="baseHint" aria-label="AI 服务地址">
          </label>
          <label>模型
            <input v-model="ai.model" aria-label="AI 模型" placeholder="例如 gpt-4o-mini">
          </label>
          <div class="toolbar">
            <button type="button" :disabled="modelsBusy" @click="discoverModels">{{ modelsBusy ? '获取中…' : '获取模型' }}</button>
            <button type="button" :disabled="modelsBusy" @click="testConnection">测试连接</button>
          </div>
          <p v-if="modelsNote" role="status">{{ modelsNote }}</p>
          <ul v-if="models.length" class="list-row model-list">
            <li v-for="model in models" :key="model.id">
              <button type="button" class="text-button" :class="{selected: ai.model === model.id}" @click="ai.model = model.id">
                {{ model.name || model.id }}
              </button>
            </li>
          </ul>
          <label>API 密钥
            <input v-model="apiKey" type="password" autocomplete="off" :placeholder="ai.has_api_key ? '已配置（留空保留）' : '未配置'" aria-label="API 密钥">
          </label>
          <p v-if="ai.has_api_key" class="muted">已配置密钥；留空保存会保留原密钥。</p>
          <div class="toolbar">
            <label class="inline">温度<input v-model.number="ai.temperature" type="number" min="0" max="2" step="0.1" aria-label="温度"></label>
            <label class="inline">最大 tokens<input v-model.number="ai.max_tokens" type="number" min="1" max="8192" aria-label="最大 tokens"></label>
          </div>
          <div class="toolbar">
            <button class="primary" type="submit" :disabled="saveBusy">{{ saveBusy ? '保存中…' : '保存' }}</button>
            <button v-if="ai.has_api_key" type="button" @click="saveAI(true)">清除密钥</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <h2>刮削队列</h2>
        <div class="toolbar chips" role="group" aria-label="筛选">
          <button v-for="item in SCRAPE_FILTERS" :key="item.value" type="button" class="chip" :class="{selected: filter === item.value}" @click="filter = item.value">
            {{ item.label }}
          </button>
        </div>
        <form @submit.prevent="startScrape">
          <ScrapeSources v-model="providers" :disabled="queueBusy" />
          <label>本次最多处理
            <input v-model.number="limit" type="number" min="1" :max="MAX_SCRAPE_LIMIT" aria-label="本次最多处理">
          </label>
          <button class="primary" type="submit" :disabled="queueBusy">{{ queueBusy ? '正在加入…' : '开始刮削' }}</button>
        </form>
        <div class="progress" role="status">
          <span>等待 {{ counts.pending }}</span><span>进行中 {{ counts.running }}</span><span>完成 {{ counts.done }}</span><span>失败 {{ counts.failed }}</span>
        </div>
        <p v-if="counts.last_error" class="error">最近失败：{{ counts.last_error }}</p>
        <div class="toolbar">
          <button type="button" @click="retryFailed">重试失败</button>
          <button type="button" @click="cancelEverything">取消全部</button>
          <label class="inline">状态
            <select v-model="queueStatus" aria-label="队列状态" @change="refreshQueue">
              <option value="">全部</option>
              <option value="pending">等待</option>
              <option value="running">进行中</option>
              <option value="completed">完成</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </select>
          </label>
          <button type="button" @click="refreshQueue">刷新</button>
        </div>
        <p v-if="!queue.length" class="muted">队列为空。</p>
        <div v-for="entry in queue" :key="entry.id" class="list-row">
          <div>
            <strong>{{ entry.title || ('图书 #' + entry.book_id) }}</strong>
            <p>{{ entry.provider === "identity" ? identityProviderLabel(entry.provider) : entry.providers?.map(identityProviderLabel).join(" → ") || identityProviderLabel(entry.provider) }} · {{ identityStatusLabel(entry.status) }}<template v-if="entry.error"> · {{ entry.error }}</template></p>
            <p v-for="(outcome,i) in entry.outcomes" :key="i">{{identityProviderLabel(outcome.provider)}}：{{outcome.applied_fields?.length ? "已补齐 "+outcome.applied_fields.join("、") : outcome.reviews ? outcome.reviews+" 个候选待审核" : outcome.error || outcome.note || identityStatusLabel(outcome.status)}}</p>
          </div>
          <button v-if="entry.status === 'pending' || entry.status === 'running'" type="button" @click="cancelOne(entry)">取消</button>
        </div>
        <RouterLink v-if="queue.some(entry=>entry.provider==='identity')" class="button" to="/admin/identify">审核内容识别候选</RouterLink>
        <p v-if="queueTotal > queue.length" class="muted">共 {{ queueTotal }} 条，显示最近 {{ queue.length }} 条。</p>
      </section>

      <section class="panel">
        <h2>AI 辅助</h2>
        <p>两种模式都会先显示将影响多少本书，确认后才加入同一个刮削队列；AI 结果进入元数据审核，不会直接改写图书。</p>
        <p v-if="!ai.configured" class="status-banner" role="status">AI 未配置：填写并保存上面的服务地址、模型与 API 密钥后即可使用。</p>
        <div class="toolbar">
          <button type="button" :disabled="!ai.configured" @click="askAssist('retry_failed')">刮削失败后辅助重试</button>
          <button type="button" :disabled="!ai.configured" @click="askAssist('all')">全部辅助</button>
        </div>
      </section>

      <section class="panel">
        <h2>手动编辑元数据</h2>
        <form @submit.prevent="search">
          <label>搜索图书<input v-model="query" aria-label="搜索图书" placeholder="书名或作者"></label>
          <button type="submit" :disabled="searchBusy">{{ searchBusy ? '搜索中…' : '搜索' }}</button>
        </form>
        <div v-for="book in results" :key="book.id" class="list-row">
          <div><strong>{{ book.title }}</strong><p>{{ book.author || '佚名' }} · {{ book.format.toUpperCase() }}</p></div>
          <button type="button" @click="selectBook(book)">编辑</button>
        </div>
        <form v-if="selected" @submit.prevent="saveBook" class="edit-form">
          <p>正在编辑 #{{ selected.id }}</p>
          <label>书名<input v-model="edit.title" aria-label="书名"></label>
          <label>作者<input v-model="edit.author" aria-label="作者"></label>
          <label>简介<textarea v-model="edit.description" rows="4" aria-label="简介"></textarea></label>
          <div class="toolbar">
            <button class="primary" type="submit" :disabled="bookBusy">保存</button>
            <button type="button" :disabled="bookBusy" @click="coverInput?.click()">上传封面</button>
            <button type="button" :disabled="bookBusy" @click="pullCoverFromEPUB">从 EPUB 提取</button>
            <button type="button" :disabled="bookBusy" @click="removeCover">删除封面</button>
            <button type="button" @click="selected = null">关闭</button>
          </div>
          <input ref="coverInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden-file" aria-label="选择封面图片" @change="pickCover">
        </form>
      </section>
    </template>

    <div v-if="confirm" class="modal-backdrop" @click.self="confirm = null">
      <section class="sheet" role="dialog" aria-modal="true" aria-label="确认 AI 辅助">
        <h2>{{ confirm.mode === 'retry_failed' ? '刮削失败后辅助重试' : '全部辅助' }}</h2>
        <p>{{ confirm.text }}</p>
        <div class="toolbar">
          <button class="primary" type="button" :disabled="confirmBusy || confirm.total === 0" @click="runConfirmedAssist">{{ confirmBusy ? '正在加入…' : '确认开始' }}</button>
          <button type="button" @click="confirm = null">取消</button>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.metadata-admin .panel{margin-bottom:18px}
.metadata-admin .chips{flex-wrap:wrap;gap:6px}
.metadata-admin .chip{border:1px solid var(--line,#d8d2c4);background:transparent;border-radius:999px;padding:6px 12px}
.metadata-admin .chip.selected{background:var(--accent,#8a5a2b);color:#fff;border-color:transparent}
.metadata-admin .model-list{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:8px 0}
.metadata-admin .model-list .selected{font-weight:600;text-decoration:underline}
.metadata-admin .progress{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0;font-variant-numeric:tabular-nums}
.metadata-admin .muted{opacity:.75}
.metadata-admin .edit-form{margin-top:14px;display:flex;flex-direction:column;gap:10px}
.metadata-admin .hidden-file{display:none}
.metadata-admin textarea{width:100%;font:inherit}
/* Long upstream errors carry URLs and must wrap instead of widening the page. */
.metadata-admin .panel{min-width:0}
.metadata-admin p,.metadata-admin li,.metadata-admin strong{overflow-wrap:anywhere;word-break:break-word}
.metadata-admin input,.metadata-admin select,.metadata-admin textarea,.metadata-admin button{max-width:100%}
@media(max-width:650px){
  .metadata-admin .toolbar{flex-wrap:wrap}
  .metadata-admin .toolbar>*{min-height:40px}
}
</style>
