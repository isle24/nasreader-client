<script setup lang="ts">
// 「在线书源」 — one search box over every enabled adapter, multi-select batch import
// and a paste-a-title-list flow. Compliance boundary (plan §1.3): nasReader bundles
// NO book sources; the list below is whatever the administrator configured in their own
// SoNovel / reader, and an upstream request only happens on an explicit search action.
import {ref,computed,onMounted,onBeforeUnmount,watch,nextTick} from 'vue';import {useRoute,useRouter} from 'vue-router';
import LibraryTargetPicker from '../components/LibraryTargetPicker.vue';
import type {ContentKind} from '../api/libraries';
import {api,state} from '../state';
import {RESULT_LABEL,createSourcePluginsApi} from '../api/sourcePlugins';
import {errorMessage,integrationError,isUnavailable} from '../api/errors';
import {
  createDiscoverApi,enabledAdapters,searchAllSources,pendingOutcomes,mergeRows,
  pickBestMatch,parseTitleList,unfinishedLines,titleListReport,runBatchImport,formatBatchReport,libraryNotice,
  discoverQueryOf,canImport,importCandidateResult,
  type AdapterRef,type SourceOutcome,type DiscoverRow,type TitleLine,type TitleReport,type BatchReport,type ImportSummary,
} from '../api/discover';

const route=useRoute(),router=useRouter();
const client=createDiscoverApi(api),sourceClient=createSourcePluginsApi(api);
const associateBusy=ref(''),associateError=ref('');
const targetKind=ref<ContentKind>('book'),targetLibrary=ref(0);
const isAdmin=computed(()=>state.user?.role==='admin');

const adapters=ref<AdapterRef[]>([]),adaptersLoading=ref(true),adaptersError=ref('');
const q=ref(''),searched=ref(false),searching=ref(false),statusMessage=ref('');
const outcomes=ref<SourceOutcome[]>([]);
let searchGeneration=0;
onBeforeUnmount(()=>{searchGeneration++});
const selected=ref<Record<string,boolean>>({});
const rows=computed(()=>mergeRows(outcomes.value));
const importable=computed(()=>rows.value.filter(canImport));
const selectedRows=computed(()=>rows.value.filter(row=>canImport(row)&&selected.value[row.key]));
const selectedCount=computed(()=>selectedRows.value.length);
const allSelected=computed(()=>importable.value.length>0&&selectedCount.value===importable.value.length);
const failedSources=computed(()=>outcomes.value.filter(source=>source.status==='error'||source.status==='unavailable'));

const batchRunning=ref(false),batchReport=ref<BatchReport|null>(null),batchError=ref('');
const chunkDone=ref(0),chunkTotal=ref(0),pollSummary=ref<ImportSummary|null>(null);
const jobErrors=ref<{id:number;error:string}[]>([]);

const bulkText=ref(''),bulkRunning=ref(false),bulkCancel=ref(false),bulkStage=ref('');
const bulkLines=ref<TitleLine[]>([]),bulkReport=ref<TitleReport|null>(null),bulkBatch=ref<BatchReport|null>(null);
const addedBooks=ref(0),bulkProgress=ref({done:0,total:0}),reviewBusy=ref<number|null>(null),reviewMessage=ref('');
const reviewLines=computed(()=>bulkLines.value.filter(line=>line.status==='review'));
const BULK_DELAY_MS=350;

function sourceLabel(source:SourceOutcome):string{
  if(source.status==='ok')return `${source.candidates.length} 条`;
  if(source.status==='pending'||source.status==='searching')return '搜索中…';
  return source.error||'搜索失败';
}
function selectionKey(){return 'nasreader.discover.selection:'+state.server+':'+(state.user?.id??0)+':'+targetLibrary.value}
function saveSelection(){
  try{localStorage.setItem(selectionKey(),JSON.stringify({q:q.value,keys:Object.keys(selected.value).filter(key=>selected.value[key])}))}catch{/* private mode */}
}
function restoreSelection(query:string){
  try{
    const raw=localStorage.getItem(selectionKey());if(!raw)return;
    const saved=JSON.parse(raw) as {q?:string;keys?:string[]};
    if(!saved||saved.q!==query)return;
    const valid=new Set(importable.value.map(row=>row.key)),next:Record<string,boolean>={};
    for(const key of saved.keys??[])if(valid.has(key))next[key]=true;
    selected.value=next;
  }catch{/* ignore malformed selection */}
}
function applyOutcome(outcome:SourceOutcome){
  const index=outcomes.value.findIndex(source=>source.adapter_id===outcome.adapter_id);
  if(index>=0)outcomes.value.splice(index,1);
  outcomes.value.push(outcome);
}
async function loadAdapters(){
  adaptersLoading.value=true;adaptersError.value='';
  try{adapters.value=await client.listAdapters()}
  catch(e){adaptersError.value=integrationError('外部书源',e)}
  finally{adaptersLoading.value=false}
}
function toggleAll(){
  if(allSelected.value){selected.value={};saveSelection();return}
  const next:Record<string,boolean>={};
  for(const row of importable.value)next[row.key]=true;
  selected.value=next;saveSelection();
}
function toggleRow(key:string){selected.value[key]=!selected.value[key];saveSelection()}
function clearSelection(){selected.value={};saveSelection()}

async function runSearch(){
  if(!targetLibrary.value){statusMessage.value='请选择有贡献权限的目标书库';return}
  const query=q.value.trim();
  statusMessage.value='';batchReport.value=null;batchError.value='';
  if(!query){statusMessage.value='请输入要搜索的书名或作者。';return}
  if(!adapters.value.length){
    statusMessage.value='还没有可用的书源：nasReader 不内置任何书源，请先在「我的 → 外部书源」添加你自己的 SoNovel / reader 连接。';
    searched.value=false;return;
  }
  const targets=enabledAdapters(adapters.value);
  if(!targets.length){statusMessage.value='没有已启用的兼容书源，请管理员检查书源配置。';searched.value=false;return}
  const generation=++searchGeneration;
  searching.value=true;searched.value=false;selected.value={};outcomes.value=pendingOutcomes(targets);
  if(discoverQueryOf(route.query)!==query)void router.replace({path:'/discover',query:{q:query}}).catch(()=>undefined);
  try{
    await searchAllSources(targets,query,(adapter,keyword)=>client.searchAdapter(adapter.id,keyword,targetLibrary.value),outcome=>{if(generation===searchGeneration)applyOutcome(outcome)});
  }catch(e){
    // searchAllSources isolates per-source failures; this only catches a programming error.
    if(generation===searchGeneration)statusMessage.value=errorMessage(e);
  }finally{if(generation===searchGeneration){searching.value=false;searched.value=true}}
  if(generation!==searchGeneration)return;
  if(failedSources.value.length)statusMessage.value=`${failedSources.value.length} 个书源没有返回结果，其余书源的结果已保留。`;
  else if(!rows.value.length)statusMessage.value=`所有书源都没有找到「${query}」。`;
  saveSelection();
}
/** Reload-safe restore: the server keeps the last remote candidates per adapter+query. */
async function restore(query:string){
  const targets=enabledAdapters(adapters.value);
  if(!targets.length)return;
  const generation=++searchGeneration;
  const receive=(outcome:SourceOutcome)=>{if(generation===searchGeneration)applyOutcome(outcome)};
  searching.value=true;searched.value=false;outcomes.value=pendingOutcomes(targets);selected.value={};
  await Promise.all(targets.map(async adapter=>{
    try{receive({adapter_id:adapter.id,adapter_name:adapter.name,status:'ok',candidates:await client.cachedCandidates(adapter.id,query,200,targetLibrary.value),error:''})}
    catch(e){receive({adapter_id:adapter.id,adapter_name:adapter.name,status:isUnavailable(e)?'unavailable':'error',candidates:[],error:isUnavailable(e)?integrationError('候选缓存',e):errorMessage(e)})}
  }));
  if(generation!==searchGeneration)return;
  searching.value=false;searched.value=true;
  restoreSelection(query);
  if(!rows.value.length&&!failedSources.value.length)statusMessage.value=`没有「${query}」的缓存结果，点「搜索」重新查一次。`;
}

async function loadJobErrors(ids:number[]){
  try{
    const jobs=await client.importsByIds(ids);
    jobErrors.value=jobs.filter(job=>job.status==='failed'||job.status==='cancelled').map(job=>({id:job.id,error:job.error||'导入失败，详情见「我的 → 导入任务」'}));
  }catch{/* the jobs page holds the details; the summary counts still stand */}
}
async function associateSource(row:DiscoverRow){
  if(!isAdmin.value||!row.local_book_id||row.can_update||associateBusy.value)return;
  const generation=searchGeneration;associateBusy.value=row.key;associateError.value='';
  try{
    const binding=await sourceClient.associateSource(row.local_book_id,row.adapter_id,row.id);
    if(generation!==searchGeneration)return;
    for(const source of outcomes.value)if(source.adapter_id===row.adapter_id)for(const candidate of source.candidates)if(candidate.id===row.id)candidate.can_update=binding.can_update;
    statusMessage.value=binding.can_update?'书源已关联，可检查连载更新':'书源已关联，请管理员检查执行状态';
  }catch(e){if(generation===searchGeneration)associateError.value=integrationError('关联书源',e)}
  finally{associateBusy.value=''}
}
async function downloadSelected(){
  const items=selectedRows.value.map(row=>({adapter_id:row.adapter_id,candidate_id:row.id,title:row.title}));
  if(!items.length){statusMessage.value='请先勾选要下载的图书。';return}
  state.syncMessage='';
  batchRunning.value=true;batchReport.value=null;batchError.value='';jobErrors.value=[];
  chunkDone.value=0;chunkTotal.value=0;pollSummary.value=null;
  try{
    const report=await runBatchImport(items,(adapterId,ids)=>client.importBatch(adapterId,ids,targetLibrary.value),{
      getSummary:ids=>client.importsSummary(ids),getJobs:ids=>client.importsByIds(ids),
      poll:{attempts:90,delayMs:2000},
      onChunk:(_chunk,done,total)=>{chunkDone.value=done;chunkTotal.value=total},
      onPoll:summary=>{pollSummary.value=summary},
    });
    batchReport.value=report;
    if(report.summary&&report.success>0){
      // The message follows the admin back to the library; App.vue shows it globally.
      state.syncMessage=libraryNotice(report);
      for(const row of selectedRows.value)delete selected.value[row.key];
      saveSelection();
    }
    if(report.summary&&report.summary.failed>0)void loadJobErrors(report.job_ids);
  }catch(e){batchError.value=integrationError('批量导入',e)}
  finally{batchRunning.value=false}
}

function syncBulkLines(){
  const previous=new Map(bulkLines.value.map(line=>[line.raw,line]));
  bulkLines.value=parseTitleList(bulkText.value).map(line=>previous.get(line.raw)??line);
}
function refreshBulkReport(){bulkReport.value=titleListReport(bulkLines.value,addedBooks.value)}
watch(bulkText,()=>{if(!bulkRunning.value)syncBulkLines()});

async function importBulkLines(targets:TitleLine[]){
  const items=targets.map(line=>({adapter_id:line.candidate!.adapter_id,candidate_id:line.candidate!.id,title:line.candidate!.title}));
  const report=await runBatchImport(items,(adapterId,ids)=>client.importBatch(adapterId,ids,targetLibrary.value),{
    getSummary:ids=>client.importsSummary(ids),getJobs:ids=>client.importsByIds(ids),
    poll:{attempts:90,delayMs:2000},
    onChunk:(chunk,done,total)=>{
      bulkStage.value=`正在提交第 ${done}/${total} 批（每批最多 50 项）…`;
      for(const line of targets){
        if(!line.candidate||line.candidate.adapter_id!==chunk.adapter_id||!chunk.candidate_ids.includes(line.candidate.id))continue;
        if(chunk.status==='error'){line.status='failed';line.reason=chunk.error}
      }
    },
    onPoll:summary=>{bulkStage.value=`正在导入：已处理 ${summary.processed}/${summary.total}，已入库 ${summary.books_added} 本`},
  });
  bulkBatch.value=report;
  for(const line of targets){
    if(!line.candidate)continue;
    const row=line.candidate,result=importCandidateResult(report,row.adapter_id,row.id);
    const failedChunk=report.chunks.find(chunk=>chunk.adapter_id===row.adapter_id&&chunk.status==='error'&&chunk.candidate_ids.includes(row.id));
    if(failedChunk){line.status='failed';line.reason=failedChunk.error;continue}
    if(result?.status==='failed'||result?.status==='cancelled'){line.status='failed';line.reason=result.error||'导入任务失败';continue}
    if(result?.result_kind){line.status=result.result_kind==='added'?'imported':result.result_kind;line.reason=RESULT_LABEL[result.result_kind];continue}
    line.status='queued';line.reason='已提交，结果见导入任务';
  }
  addedBooks.value+=report.summary?report.success:0;
  const notice=libraryNotice(report);
  if(notice)state.syncMessage=notice;
}
async function runBulk(){
  if(!targetLibrary.value){statusMessage.value='请选择有贡献权限的目标书库';return}
  const text=bulkText.value.trim();
  statusMessage.value='';bulkBatch.value=null;reviewMessage.value='';
  if(!text){statusMessage.value='请先粘贴书名清单：每行一本，「书名」或「书名,作者」。';return}
  if(!adapters.value.length){
    statusMessage.value='还没有可用的书源：批量查找需要至少一个已启用的 SoNovel / reader 连接，请先在「我的 → 外部书源」添加。';
    return;
  }
  const targets=enabledAdapters(adapters.value);
  if(!targets.length){statusMessage.value='没有已启用的兼容书源，请管理员检查书源配置。';return}
  syncBulkLines();
  const toSearch=unfinishedLines(bulkLines.value).filter(line=>!line.candidate);
  if(!bulkLines.value.length){statusMessage.value='清单里没有可用的行：以 # 开头的行会被忽略。';return}
  bulkRunning.value=true;bulkCancel.value=false;bulkProgress.value={done:0,total:toSearch.length};
  try{
    for(let index=0;index<toSearch.length;index++){
      const line=toSearch[index];
      if(bulkCancel.value){
        for(const rest of toSearch.slice(index))if(rest.status==='pending'||rest.status==='searching')rest.status='cancelled';
        break;
      }
      line.status='searching';
      bulkStage.value=`正在查找 ${index+1}/${toSearch.length}：${line.query!.title}`;
      let queried=await searchAllSources(targets,line.query!.title,(adapter,keyword)=>client.searchAdapter(adapter.id,keyword,targetLibrary.value));
      let matches=mergeRows(queried);
      if(!matches.length&&queried.some(source=>source.status==='error'||source.status==='unavailable')){line.status='failed';line.reason=queried.filter(source=>source.error).map(source=>source.adapter_name+'：'+source.error).join('；');bulkProgress.value={done:index+1,total:toSearch.length};continue}
      let best=pickBestMatch(line.query!,matches);
      if(best.kind==='none'&&line.query!.author){
        // Second chance for 「书名,作者」 lines: retry the upstream search with both.
        queried=await searchAllSources(targets,`${line.query!.title} ${line.query!.author}`,(adapter,keyword)=>client.searchAdapter(adapter.id,keyword,targetLibrary.value));
        matches=mergeRows(queried);
        best=pickBestMatch(line.query!,matches);
      }
      line.reason=best.reason;line.choices=best.matches;
      if(best.kind==='exact'||best.kind==='exact-author'||best.kind==='title-author'){line.candidate=best.candidate;line.status='matched'}
      else if(best.kind==='ambiguous'){line.status='review'}
      else if(best.kind==='local'){line.status='local'}
      else if(queried.some(source=>source.status==='error'||source.status==='unavailable')){line.status='failed';line.reason=queried.filter(source=>source.error).map(source=>source.adapter_name+'：'+source.error).join('；')}
      else{line.status='notfound'}
      bulkProgress.value={done:index+1,total:toSearch.length};
      if(index+1<toSearch.length&&!bulkCancel.value&&BULK_DELAY_MS>0)await new Promise(resolve=>setTimeout(resolve,BULK_DELAY_MS));
    }
    const ready=bulkLines.value.filter(line=>line.candidate&&(line.status==='matched'||line.status==='failed'));
    if(ready.length&&!bulkCancel.value)await importBulkLines(ready);
  }catch(e){
    statusMessage.value=integrationError('批量查找',e);
  }finally{
    bulkRunning.value=false;bulkStage.value='';bulkCancel.value=false;refreshBulkReport();
  }
}
async function importChoice(line:TitleLine,row:DiscoverRow){
  if(!canImport(row)){reviewMessage.value='这本书已在本机，且未绑定可更新的书源';return}
  reviewBusy.value=line.index;reviewMessage.value='';
  try{
    const report=await runBatchImport([{adapter_id:row.adapter_id,candidate_id:row.id,title:row.title}],(adapterId,ids)=>client.importBatch(adapterId,ids,targetLibrary.value),{
      getSummary:ids=>client.importsSummary(ids),getJobs:ids=>client.importsByIds(ids),poll:{attempts:90,delayMs:2000},
    });
    const result=importCandidateResult(report,row.adapter_id,row.id);
    line.candidate=row;
    if(result?.result_kind){line.status=result.result_kind==='added'?'imported':result.result_kind;line.reason=RESULT_LABEL[result.result_kind];if(result.result_kind==='added')addedBooks.value++}
    else if(result?.status==='failed'||result?.status==='cancelled'||report.failed>0){line.status='failed';line.reason=result?.error||'导入失败，详情见导入任务'}
    else{line.status='queued';line.reason='已提交，结果见导入任务';reviewMessage.value='已提交导入，请到导入任务查看最终结果。'}
    const notice=libraryNotice(report);if(notice)state.syncMessage=notice;refreshBulkReport();
  }catch(e){reviewMessage.value=integrationError('导入',e)}
  finally{reviewBusy.value=null}
}

onMounted(async()=>{
  if(!state.user){await router.replace('/login');return}
  await loadAdapters();
  const initial=discoverQueryOf(route.query);
  if(initial){q.value=initial;await nextTick();if(targetLibrary.value)await restore(initial)}
});
watch(targetLibrary,(value,previous)=>{searchGeneration++;outcomes.value=[];selected.value={};searched.value=false;batchReport.value=null;if(value&&q.value&&value!==previous)void restore(q.value)});
watch(()=>state.accessEpoch,()=>{searchGeneration++;outcomes.value=[];selected.value={};searched.value=false;});
watch(()=>discoverQueryOf(route.query),(value,previous)=>{
  if(value===q.value||(!value&&!previous))return;
  q.value=value;
  if(value)void runSearch();
});
</script>

<template><main class="page discover">
<div class="page-title"><div><h1>在线书源</h1><p>一次搜索所有已启用的书源，勾选后下载并自动入库。</p></div>
<RouterLink v-if="isAdmin" :to="{path:'/admin/sources'}" class="button">源配置</RouterLink><RouterLink v-else class="button" to="/import">我的导入任务</RouterLink></div>
<p class="source-hint">使用管理员启用的书源；点击搜索才会请求外部网站。导入默认进入自己的个人库。选择有贡献权限的目标库后，按该库授权共享。<span v-if="isAdmin">可在「我的 → 外部书源」管理订阅和连接。</span><span v-else>书源配置由管理员维护。</span></p>

<section v-if="state.user" class="panel import-target"><label>本次内容<select v-model="targetKind" :disabled="batchRunning||bulkRunning"><option value="book">图书</option><option value="comic">漫画</option></select></label><LibraryTargetPicker v-model="targetLibrary" :kind="targetKind" :disabled="batchRunning||bulkRunning"/></section>
<template v-if="state.user">
<p v-if="associateError" role="alert" class="error">{{associateError}}</p>
<p v-if="statusMessage" role="status" class="status-banner">{{statusMessage}}</p>
<p v-if="adaptersError" role="alert" class="error">{{adaptersError}} <button @click="loadAdapters">重试</button></p>
<p v-if="adaptersLoading" role="status" class="muted">正在读取外部书源…</p>

<form v-else class="toolbar" @submit.prevent="runSearch">
<label class="sr-only" for="discover-search">搜索书名或作者</label>
<input id="discover-search" v-model="q" placeholder="搜索书名或作者" autocomplete="off">
<button class="primary" >{{searching?'重新搜索':'搜索'}}</button>
</form>

<section v-if="!adaptersLoading&&!adaptersError&&!adapters.length" class="empty" aria-label="没有书源">
<h2>还没有可用的书源</h2>
<p>nasReader 不内置任何书源。请先在「我的 → 外部书源」添加你自己的 SoNovel / reader 连接并启用，然后回到这里搜索。</p>
<RouterLink v-if="isAdmin" class="button primary" :to="{path:'/admin/sources'}">去「我的 → 外部书源」</RouterLink><p v-else>请管理员添加并启用兼容书源。</p>
</section>
<template v-else-if="!adaptersLoading&&!adaptersError">
<section v-if="!enabledAdapters(adapters).length" class="empty" aria-label="书源都已停用">
<h2>没有已启用的兼容书源</h2>
<p>已配置 {{adapters.length}} 个连接，但没有一个处于启用状态，因此不会发出任何上游搜索。</p>
<RouterLink v-if="isAdmin" class="button primary" :to="{path:'/admin/sources'}">去启用书源</RouterLink><p v-else>请管理员检查兼容性并启用书源。</p>
</section>

<template v-else>
<section class="panel sources" aria-label="各书源状态">
<div class="sources-head"><h2>书源状态</h2><small>{{outcomes.length?`本轮查询 ${outcomes.length} 个书源`:'尚未搜索'}}</small></div>
<ul class="source-list">
<li v-for="source in outcomes" :key="source.adapter_id" class="source-row">
<strong>{{source.adapter_name}}</strong>
<small :class="{bad:source.status==='error'||source.status==='unavailable'}">{{sourceLabel(source)}}</small>
</li>
<li v-if="!outcomes.length" class="muted">点上面的「搜索」后，这里会逐个显示每个书源的结果。</li>
</ul>
</section>

<section v-if="searched||searching" class="panel results">
<div class="results-head">
<h2>搜索结果</h2>
<small>共 {{rows.length}} 条 · 可导入或更新 {{importable.length}} 条<template v-if="rows.length-importable.length"> · 已在本机 {{rows.length-importable.length}} 条</template></small>
</div>
<p v-if="searching" role="status" class="muted">正在并发查询所有已启用的书源…</p>
<div v-if="rows.length" class="table-wrap">
<table class="discover-table">
<thead><tr>
<th class="check"><input type="checkbox" aria-label="全选可导入项" :checked="allSelected" @change="toggleAll"></th>
<th>书名</th><th>作者</th><th>格式</th><th>来源</th><th>操作</th>
</tr></thead>
<tbody>
<tr v-for="row in rows" :key="row.key" :class="{local:row.local}">
<td class="check" data-label="选择"><input v-if="canImport(row)" type="checkbox" :checked="!!selected[row.key]" :aria-label="`选择《${row.title}》`" @change="toggleRow(row.key)"></td>
<td data-label="书名"><strong>{{row.title||'（无书名）'}}</strong><br><small v-if="row.filename">{{row.filename}}</small></td>
<td data-label="作者">{{row.author||'佚名'}}</td>
<td data-label="格式">{{(row.format||'未知').toUpperCase()}}</td>
<td data-label="来源">{{row.source_name||row.adapter_name}}</td>
<td data-label="操作">
<span v-if="row.local" class="badge">{{row.can_update?'可检查更新':'已在本机'}}</span>
<RouterLink v-if="row.local&&row.local_book_id" class="text-button" :to="'/read/'+row.local_book_id">在书库中打开</RouterLink>
<span v-else-if="!row.local" class="muted">可导入</span><button v-if="isAdmin&&row.local&&!row.can_update" :disabled="!!associateBusy" title="关联后可检查连载更新，当前内容先保留" @click="associateSource(row)">{{associateBusy===row.key?'关联中…':'关联此源'}}</button>
</td>
</tr>
</tbody>
</table>
</div>
<div v-else-if="!searching" class="empty-inline">
<p><strong>没有找到这本书</strong></p>
<p>{{failedSources.length?'部分书源失败，详细原因见各书源状态。可重试或请管理员检查配置。':'所有已启用的书源都没有返回结果。换一个关键词再搜索。'}}</p>
</div>
</section>

<div v-if="importable.length" class="action-bar" aria-label="已选图书操作">
<span class="count">已选 {{selectedCount}} 项</span>
<button @click="toggleAll">{{allSelected?'取消全选':'全选可导入项'}}</button>
<button v-if="selectedCount" @click="clearSelection">清空选择</button>
<button class="primary" :disabled="!selectedCount||batchRunning" @click="downloadSelected">{{batchRunning?'正在下载并导入…':'下载并导入 / 更新'}}</button>
</div>

<section v-if="batchRunning||batchReport||batchError" class="panel batch" aria-label="导入结果">
<h2>批量导入</h2>
<p v-if="batchRunning" role="status">{{chunkTotal?`正在提交第 ${chunkDone}/${chunkTotal} 批（每批最多 50 项）…`:'正在准备导入…'}}</p>
<progress v-if="batchRunning&&pollSummary" :value="pollSummary.processed" :max="Math.max(1,pollSummary.total)"></progress>
<p v-if="batchRunning&&pollSummary" role="status">已处理 {{pollSummary.processed}}/{{pollSummary.total}} · 已入库 {{pollSummary.books_added}} 本</p>
<p v-if="batchError" role="alert" class="error">{{batchError}}</p>
<template v-if="batchReport">
<p role="status" class="report">{{formatBatchReport(batchReport)}}</p><ul v-if="batchReport.results?.length" class="line-list"><li v-for="job in batchReport.results" :key="job.id"><span>任务 #{{job.id}} · {{RESULT_LABEL[job.result_kind||'']||job.status}}<small v-if="job.error"> · {{job.error}}</small></span><RouterLink v-if="job.result_book_id" :to="'/read/'+job.result_book_id">在书库中打开</RouterLink></li></ul>
<p v-if="libraryNotice(batchReport)" role="status" class="report-ok">{{libraryNotice(batchReport)}}　<RouterLink class="text-button" to="/">去书库看看</RouterLink></p>
<p v-if="batchReport.summary_error" role="status" class="muted">{{batchReport.summary_error}}</p>
<ul v-if="batchReport.skipped.length" class="reason-list">
<li v-for="row in batchReport.skipped" :key="'skip-'+row.candidate_id">跳过 {{row.candidate_id}}：{{row.reason}}</li>
</ul>
<ul v-if="batchReport.failed_before_queue.length" class="reason-list">
<li v-for="row in batchReport.failed_before_queue" :key="'fail-'+row.candidate_id">提交失败 {{row.candidate_id}}：{{row.reason}}</li>
</ul>
<ul v-if="jobErrors.length" class="reason-list">
<li v-for="job in jobErrors" :key="'job-'+job.id">导入任务 #{{job.id}} 失败：{{job.error}}</li>
</ul>
</template>
</section>
</template>
</template>

<section class="panel bulk" aria-label="批量书名清单">
<h2>批量书名清单</h2>
<p class="muted">每行一本：「书名」或「书名,作者」。精确匹配会自动下载入库；有多个同名候选的会进入待确认清单，让你逐条决定。搜索逐条进行以保护上游，可随时取消，再次点击只处理未完成的行。</p>
<label for="bulk-list">书名清单</label>
<textarea id="bulk-list" v-model="bulkText" rows="6" placeholder="三体,刘慈欣&#10;银河系漫游指南&#10;# 以 # 开头的行会被忽略"></textarea>
<div class="row-actions">
<button class="primary" :disabled="bulkRunning" @click="runBulk">{{bulkRunning?'正在处理…':'批量查找并下载'}}</button>
<button v-if="bulkRunning" @click="bulkCancel=true">取消</button>
<button v-if="!bulkRunning&&bulkLines.length" @click="syncBulkLines();bulkReport=null">重置清单</button>
</div>
<p v-if="bulkRunning||bulkProgress.total" role="status" class="muted">
<template v-if="bulkStage">{{bulkStage}}</template>
<template v-else-if="bulkProgress.total">查找进度 {{bulkProgress.done}}/{{bulkProgress.total}}</template>
</p>
<progress v-if="bulkRunning&&bulkProgress.total" :value="bulkProgress.done" :max="bulkProgress.total"></progress>
<ul v-if="bulkLines.length" class="line-list">
<li v-for="line in bulkLines" :key="line.index" :class="'line-'+line.status">
<span class="line-raw">{{line.raw}}</span>
<small>{{line.status==='imported'?'已加入':line.status==='updated'?'已更新':line.status==='unchanged'?'无变化':line.status==='conflict'?'内容冲突，已保留现有版本':line.status==='queued'?'已提交，结果见导入任务':line.status==='matched'?'待导入':line.status==='review'?'需人工确认':line.status==='notfound'?'未找到':line.status==='local'?'已在本机':line.status==='failed'?`失败：${line.reason||'提交失败'}`:line.status==='cancelled'?'已取消':line.status==='searching'?'查找中…':'待处理'}}</small>
</li>
</ul>
<p v-if="bulkReport" role="status" class="report">{{bulkReport.text}}</p>
<template v-if="bulkBatch">
<p role="status" class="report">{{formatBatchReport(bulkBatch)}}</p>
<p v-if="libraryNotice(bulkBatch)" role="status" class="report-ok">{{libraryNotice(bulkBatch)}}　<RouterLink class="text-button" to="/">去书库看看</RouterLink></p>
<p v-if="bulkBatch.summary_error" role="status" class="muted">{{bulkBatch.summary_error}}</p>
<ul v-if="bulkBatch.failed_before_queue.length" class="reason-list">
<li v-for="row in bulkBatch.failed_before_queue" :key="'bulk-fail-'+row.candidate_id">提交失败 {{row.candidate_id}}：{{row.reason}}</li>
</ul>
</template>
<p v-if="reviewMessage" role="status" class="muted">{{reviewMessage}}</p>
</section>

<section v-if="reviewLines.length" class="panel review" aria-label="待人工确认">
<h2>需人工确认（{{reviewLines.length}}）</h2>
<p class="muted">这些行有多个可能的匹配或作者不一致，nasReader 不会替你猜。选一条导入，或改清单后重跑。</p>
<article v-for="line in reviewLines" :key="'review-'+line.index" class="review-item">
<h3>{{line.raw}}</h3>
<p><small>{{line.reason}}</small></p>
<ul class="choice-list">
<li v-for="row in line.choices.slice(0,8)" :key="'choice-'+row.key">
<span><strong>{{row.title}}</strong> · {{row.author||'佚名'}} · {{(row.format||'未知').toUpperCase()}} · {{row.source_name||row.adapter_name}}</span>
<RouterLink v-if="!canImport(row)&&row.local_book_id" :to="'/read/'+row.local_book_id">在书库中打开</RouterLink><button v-else :disabled="reviewBusy===line.index" @click="importChoice(line,row)">{{reviewBusy===line.index?'导入中…':'导入这一本'}}</button>
</li>
</ul>
</article>
</section>
</template>
</main></template>

<style scoped>
.discover .source-hint{background:#eef3f0;border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-size:13px;color:#3c4a44}
.discover .panel{margin:0 0 20px}
.sources-head,.results-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.sources-head h2,.results-head h2{margin:0}
.source-list{list-style:none;margin:12px 0 0;padding:0}
.source-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--border);padding:10px 0;font-size:14px}
.source-row small.bad{color:#942f23}
.table-wrap{overflow-x:auto;margin-top:12px}
.discover-table{width:100%;border-collapse:collapse;font-size:14px}
.discover-table th,.discover-table td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
.discover-table th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
.discover-table td.check,.discover-table th.check{width:44px}
.discover-table td.check input{width:22px;height:22px}
.discover-table tr.local strong{color:var(--muted)}
.badge{display:inline-block;background:#e5eeea;color:var(--accent);border-radius:999px;padding:2px 10px;font-size:12px;white-space:nowrap}
.action-bar{position:sticky;bottom:12px;z-index:20;display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 18px #101a1418;padding:10px 14px;margin:0 0 20px}
.action-bar .count{font-weight:600;margin-right:auto;font-variant-numeric:tabular-nums}
.report{font-weight:600;margin:8px 0}
.report-ok{background:#e7efea;color:#315747;border-radius:8px;padding:10px 14px;margin:8px 0}
.reason-list{margin:8px 0 0;padding-left:20px;font-size:13px;color:#942f23}
.line-list{list-style:none;margin:12px 0 0;padding:0;font-size:13px}
.line-list li{display:flex;justify-content:space-between;gap:10px;border-top:1px solid var(--border);padding:8px 0}
.line-list .line-raw{word-break:break-all}
.line-list small{white-space:nowrap}
.line-review small{color:#8a6d1f}
.line-failed small{color:#942f23}
.line-imported small{color:var(--accent)}
.review-item{border-top:1px solid var(--border);padding:12px 0}
.review-item h3{margin:0}
.choice-list{list-style:none;margin:8px 0 0;padding:0}
.choice-list li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;flex-wrap:wrap}
.discover textarea{min-height:140px}
@media(max-width:650px){
  .discover-table thead{display:none}
  .discover-table tr{display:block;border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin:0 0 10px}
  .discover-table td{display:flex;gap:10px;border:0;padding:4px 0}
  .discover-table td.check{width:auto}
  .discover-table td[data-label]::before{content:attr(data-label);color:var(--muted);font-size:12px;min-width:48px;flex-shrink:0}
  .action-bar{bottom:calc(74px + env(safe-area-inset-bottom));padding:8px 10px;gap:8px}
  .action-bar .count{width:100%;margin:0}
  .action-bar button{flex:1 1 auto;font-size:13px;padding:8px 10px}
  .source-row{flex-wrap:wrap}
}
</style>
