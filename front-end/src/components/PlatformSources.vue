<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {api,state} from '../state';
import type {AdapterRef} from '../api/discover';
import {integrationError} from '../api/errors';
import {createSourcePluginsApi,isPlatformKind,newPlatformDraft,editPlatformDraft,platformEndpoint,platformReaderOptions,validatePlatformDraft,capabilityStatus,type PlatformDescriptor,type PlatformDraft,type PlatformMode,type ReaderSource} from '../api/sourcePlugins';
const props=defineProps<{adapters:AdapterRef[];loading?:boolean}>();
const emit=defineEmits<{changed:[]}>();
const sources=createSourcePluginsApi(api),admin=computed(()=>state.user?.role==='admin');
const scope=computed(()=>`${state.server}:${state.user?.id??''}:${state.user?.role??''}`);
const catalog=ref<PlatformDescriptor[]>([]),catalogLoading=ref(false),catalogError=ref('');
const draft=ref<PlatformDraft|null>(null),original=ref<AdapterRef|null>(null),busy=ref(false),error=ref(''),message=ref(''),testing=ref<number|null>(null);
const readerFilter=ref(''),sourceFilter=ref(''),readerSources=ref<ReaderSource[]>([]),sourcesLoading=ref(false),sourcesError=ref(''),manualKey=ref(false);
let catalogSequence=0,sourceSequence=0;
const platforms=computed(()=>props.adapters.filter(item=>isPlatformKind(item.kind)));
const readers=computed(()=>platformReaderOptions(props.adapters,readerFilter.value));
const selectedReader=computed(()=>props.adapters.find(item=>item.kind==='reader'&&String(item.id)===draft.value?.reader_adapter_id));
const visibleReaders=computed(()=>selectedReader.value&&!readers.value.some(item=>item.id===selectedReader.value?.id)?[selectedReader.value,...readers.value]:readers.value);
const sourceOptions=computed(()=>readerSources.value.filter(item=>item.name.toLowerCase().includes(sourceFilter.value.trim().toLowerCase())));
const selectedSource=computed(()=>readerSources.value.find(item=>item.key===draft.value?.source_key));
const visibleSources=computed(()=>selectedSource.value&&!sourceOptions.value.some(item=>item.key===selectedSource.value?.key)?[selectedSource.value,...sourceOptions.value]:sourceOptions.value);
const descriptor=computed(()=>catalog.value.find(item=>item.kind===draft.value?.kind));
const endpointChanged=computed(()=>!!original.value&&draft.value?.mode==='api'&&(original.value.platform_config?.mode!=='api'||platformEndpoint(original.value.platform_config.api_base_url??'')!==platformEndpoint(draft.value.api_base_url)));
const modes:{mode:PlatformMode;label:string}[]=[{mode:'web',label:'官网公开网页'},{mode:'api',label:'自配兼容 API'},{mode:'reader',label:'reader 兼容服务'}];
const CAPABILITY:Record<string,string>={'book-link-lookup':'书籍链接 / ID 查询','public-catalog':'公开章节目录','readable-public-text':'正确可读的公开正文','keyword-search':'书名搜索','txt-export':'TXT 导出','chapter-update':'连载更新',book_url_lookup:'书籍链接 / ID 查询',lookup:'书籍链接 / ID 查询',search:'书名搜索',fetch:'内容获取',update:'连载更新'};
const current=(token:string)=>admin.value&&scope.value===token;
async function loadCatalog(){
  if(!admin.value)return;const token=scope.value,sequence=++catalogSequence;catalogLoading.value=true;catalogError.value='';
  try{const result=await sources.platformCatalog();if(current(token)&&sequence===catalogSequence)catalog.value=(result.items??[]).filter(item=>isPlatformKind(item.kind))}
  catch(e){if(current(token)&&sequence===catalogSequence)catalogError.value=integrationError('平台目录',e)}
  finally{if(current(token)&&sequence===catalogSequence)catalogLoading.value=false}
}
function resetForm(){draft.value=null;original.value=null;error.value='';readerFilter.value='';sourceFilter.value='';manualKey.value=false;readerSources.value=[];sourcesError.value='';sourcesLoading.value=false;sourceSequence++}
function selectPlatform(item:PlatformDescriptor){if(busy.value)return;resetForm();draft.value=newPlatformDraft(item.kind,item.name);message.value=''}
function editPlatform(item:AdapterRef){if(busy.value)return;resetForm();original.value=item;draft.value=editPlatformDraft(item);message.value=''}
function setMode(mode:PlatformMode){if(!draft.value||busy.value||draft.value.mode===mode)return;draft.value.mode=mode;draft.value.api_token='';draft.value.clear_api_token=false;error.value='';manualKey.value=false}
function tabKey(event:KeyboardEvent,index:number){
  let next=index;if(event.key==='ArrowRight')next=(index+1)%modes.length;else if(event.key==='ArrowLeft')next=(index+modes.length-1)%modes.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=modes.length-1;else return;
  event.preventDefault();setMode(modes[next].mode);(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}
async function discoverReader(){
  const sequence=++sourceSequence,token=scope.value,id=Number(draft.value?.reader_adapter_id);readerSources.value=[];sourcesError.value='';sourceFilter.value='';sourcesLoading.value=false;
  if(!current(token)||draft.value?.mode!=='reader'||!id)return;sourcesLoading.value=true;
  try{const result=await sources.readerSources(id);if(current(token)&&sequence===sourceSequence){readerSources.value=result.items??[];if(draft.value?.source_key&&!readerSources.value.some(item=>item.key===draft.value?.source_key))manualKey.value=true}}
  catch(e){if(current(token)&&sequence===sourceSequence)sourcesError.value=integrationError('兼容书源发现',e)}
  finally{if(current(token)&&sequence===sourceSequence)sourcesLoading.value=false}
}
function readerChanged(){if(draft.value)draft.value.source_key='';manualKey.value=false}
watch(()=>[draft.value?.mode,draft.value?.reader_adapter_id],()=>{void discoverReader()});
watch(scope,()=>{catalogSequence++;sourceSequence++;catalog.value=[];catalogError.value='';catalogLoading.value=false;message.value='';testing.value=null;busy.value=false;resetForm();if(admin.value)void loadCatalog()},{immediate:true});
async function save(){
  if(!draft.value||busy.value||!admin.value)return;error.value=validatePlatformDraft(draft.value);if(error.value)return;
  if(draft.value.mode==='reader'&&!props.adapters.some(item=>item.kind==='reader'&&String(item.id)===draft.value?.reader_adapter_id)){error.value='所选 reader 服务已不存在，请重新选择';return}
  if(draft.value.mode==='reader'&&!manualKey.value&&readerSources.value.find(item=>item.key===draft.value?.source_key)?.enabled===false){error.value='所选兼容书源已停用，请先在 reader 中启用';return}
  const token=scope.value,value={...draft.value},item=original.value;busy.value=true;message.value='';
  try{if(item)await sources.updatePlatform(item.id,value,item);else await sources.createPlatform(value.kind,value);if(!current(token))return;resetForm();message.value=item?'平台配置已保存':'平台插件已添加，默认停用；可先测试连接，再启用搜索和导入';emit('changed')}
  catch(e){if(current(token))error.value=integrationError(item?'保存平台配置':'添加平台插件',e)}finally{if(current(token))busy.value=false}
}
async function toggle(item:AdapterRef){
  if(busy.value||!admin.value)return;const token=scope.value;busy.value=true;error.value='';message.value='';
  try{await api.send(`/adapters/${item.id}`,'PATCH',{enabled:!item.enabled});if(current(token)){message.value=`「${item.name}」已${item.enabled?'停用':'启用'}`;emit('changed')}}catch(e){if(current(token))error.value=integrationError('切换平台状态',e)}finally{if(current(token))busy.value=false}
}
async function probe(item:AdapterRef){
  if(testing.value!==null||busy.value||!admin.value)return;const token=scope.value;testing.value=item.id;error.value='';message.value='';
  try{const result=await api.post<any>(`/adapters/${item.id}/test`,{});if(current(token))message.value=`「${item.name}」连接正常 · 版本 ${result.version??'未知'}${result.capabilities?.length?' · '+result.capabilities.map((x:string)=>CAPABILITY[x]??x).join('、'):''}`}catch(e){if(current(token))error.value=integrationError('平台连接测试',e)}finally{if(current(token))testing.value=null}
}
async function remove(item:AdapterRef){
  if(busy.value||!admin.value)return;const token=scope.value;busy.value=true;error.value='';message.value='';
  try{await api.delete(`/adapters/${item.id}`);if(current(token)){if(original.value?.id===item.id)resetForm();message.value='平台插件已删除';emit('changed')}}catch(e){if(current(token))error.value=integrationError('删除平台插件',e)}finally{if(current(token))busy.value=false}
}
</script>
<template>
<section v-if="admin" class="platform-sources" aria-label="平台小说插件">
<h3>平台小说插件</h3><p class="muted">选择番茄或七猫，接入官网正常公开可读内容，也可使用自己的兼容 API 或 reader 服务。添加后默认停用。</p>
<p v-if="catalogLoading" role="status">正在读取平台目录…</p><p v-else-if="catalogError" role="alert" class="error">{{catalogError}} <button type="button" @click="loadCatalog">重试平台目录</button></p>
<div v-else class="platform-catalog"><button v-for="item in catalog" :key="item.kind" type="button" class="platform-card" :class="[item.kind,{selected:draft?.kind===item.kind}]" :aria-label="'配置'+item.name" :disabled="busy" @click="selectPlatform(item)"><span class="brand-mark" aria-hidden="true">{{item.kind==='fanqie'?'番':'七'}}</span><span><strong>{{item.name}}</strong><span class="card-detail">官网网页 / 自配 API / reader</span></span><span aria-hidden="true" class="card-arrow">›</span></button></div>
<p v-if="message" role="status" class="status-banner">{{message}}</p><p v-if="error" role="alert" class="error">{{error}}</p>
<form v-if="draft" class="platform-form" @submit.prevent="save">
<h4>{{original?'编辑「'+original.name+'」':'配置'+(descriptor?.name??draft.name)}}</h4><label>插件名称<input v-model="draft.name" required maxlength="80" :disabled="busy"></label>
<div class="mode-tabs" role="tablist" aria-label="平台接入模式"><button v-for="(item,index) in modes" :id="'platform-tab-'+item.mode" :key="item.mode" type="button" role="tab" :aria-selected="draft.mode===item.mode" :tabindex="draft.mode===item.mode?0:-1" aria-controls="platform-mode-panel" :disabled="busy" @click="setMode(item.mode)" @keydown="tabKey($event,index)">{{item.label}}</button></div>
<div id="platform-mode-panel" role="tabpanel" :aria-labelledby="'platform-tab-'+draft.mode" class="mode-panel">
<template v-if="draft.mode==='web'"><p>使用官网正常公开网页。可在在线书源中粘贴官网书籍链接或 ID 查询；书名搜索是否可用取决于平台公开接口。</p><p v-if="draft.kind==='fanqie'" class="issue">番茄公开样本部分正文使用字体私用区字符，无法正确还原时会显示受限，避免导入乱码。</p><p class="issue">仅支持可以正确读取的公开内容。登录、验证码、付费或 App 限制会明确显示；不能保证获取 App 中的全部免费内容。</p><p v-if="descriptor?.origin" class="url">官网：{{descriptor.origin}}</p><p v-if="descriptor?.capabilities?.length" class="muted">当前官网能力：{{descriptor.capabilities.map(x=>CAPABILITY[x]??x).join('、')}}</p><p v-for="limitation in descriptor?.limitations" :key="limitation" class="issue">{{limitation}}</p></template>
<template v-else-if="draft.mode==='api'"><p class="muted">用户配置的兼容服务，非官方开放 API。服务需提供 search / info / content 接口。</p><label>兼容 API 地址<input v-model="draft.api_base_url" type="url" required placeholder="https://your-service.example/v1" autocomplete="off" :disabled="busy"></label><label>API 访问令牌<input v-model="draft.api_token" type="password" autocomplete="new-password" placeholder="可选，填写新令牌可轮换" :disabled="busy||draft.clear_api_token"></label><p v-if="endpointChanged" class="issue">地址已改变，旧令牌不会沿用；需要鉴权时请填写新端点的令牌。</p><p v-else-if="original?.platform_config?.mode==='api'&&original.platform_config.has_api_token" class="muted">已配置令牌；同一端点留空保留现有令牌。</p><p v-else class="muted">令牌仅用于访问此兼容服务，保存后不会回显。</p><label v-if="original" class="inline"><input v-model="draft.clear_api_token" type="checkbox" :disabled="busy">清除已保存的 API 令牌</label></template>
<template v-else><p class="muted">选择已配置的 reader，再选择该服务中可用的兼容书源。</p><label>筛选 reader 服务<input v-model="readerFilter" type="search" placeholder="按服务名称搜索" :disabled="busy"></label><label>reader 服务<select v-model="draft.reader_adapter_id" required @change="readerChanged" :disabled="busy||props.loading"><option value="">请选择 reader 服务</option><option v-for="item in visibleReaders" :key="item.id" :value="String(item.id)">{{item.name}}{{item.enabled===false?'（已停用）':''}}</option></select></label><p v-if="props.loading" role="status">正在读取 reader 服务…</p><p v-else-if="!props.adapters.some(item=>item.kind==='reader')" class="issue">请先在下方服务连接中添加 reader，再回到这里选择。</p><p v-if="selectedReader?.enabled===false" class="issue">此 reader 连接已停用，使用前请启用并测试。</p><p v-if="sourcesLoading" role="status">正在读取兼容书源…</p><p v-else-if="sourcesError" role="alert" class="error">{{sourcesError}} <button type="button" :disabled="busy" @click="discoverReader">重新发现书源</button></p>
<template v-if="readerSources.length"><label>筛选兼容书源<input v-model="sourceFilter" type="search" placeholder="按书源名称搜索" :disabled="busy||manualKey"></label><label>兼容书源<select v-model="draft.source_key" :disabled="busy||manualKey||sourcesLoading"><option value="">请选择兼容书源</option><option v-for="item in visibleSources" :key="item.key" :value="item.key" :disabled="item.enabled===false">{{item.name}}{{item.enabled===false?'（已停用）':''}}</option></select></label></template><p v-else-if="draft.reader_adapter_id&&!sourcesLoading&&!sourcesError" class="muted">此服务未返回可选书源，可检查 reader 中的配置。</p>
<details :open="manualKey" class="advanced"><summary>高级：手动填写源 key</summary><p class="muted">仅在服务版本无法发现书源或缺少已知书源时使用。源 key 来自你自己的 reader 配置。</p><label class="inline"><input v-model="manualKey" type="checkbox" :disabled="busy">使用手动源 key</label><label>手动源 key<input v-model="draft.source_key" placeholder="填写 reader 中的书源 key" :disabled="busy||!manualKey"></label></details></template>
</div><label v-if="original" class="inline"><input v-model="draft.enabled" type="checkbox" :disabled="busy">启用平台插件</label><p v-else class="muted">添加时默认停用。管理员可先测试连接，启用后才能搜索和导入。</p><p v-if="original" class="muted">已有来源绑定或活动导入时，接入身份不可修改；更换来源请添加新插件。</p><div class="row-actions"><button class="primary" :disabled="busy||sourcesLoading">{{busy?'正在保存…':original?'保存平台配置':'添加平台插件'}}</button><button type="button" :disabled="busy" @click="resetForm">取消配置</button></div>
</form>
<p v-if="props.loading" role="status">正在读取已配置平台…</p><article v-for="item in platforms" :key="item.id" class="platform-row"><div><strong>{{item.name}}</strong><p>{{item.kind==='fanqie'?'番茄小说':'七猫小说'}} · {{item.enabled?'已启用':'已停用'}}</p><small>{{capabilityStatus(item)}}</small><p v-if="item.platform_config?.mode==='api'" class="url">{{item.platform_config.api_base_url}} · {{item.platform_config.has_api_token?'已配置令牌':'未配置令牌'}}</p><p v-if="item.platform_config?.mode==='reader'" class="muted">{{props.adapters.find(reader=>reader.id===item.platform_config?.reader_adapter_id)?.name??'已关联 reader 服务'}}</p><p v-for="issue in item.issues" :key="issue" class="issue">{{issue}}</p></div><div class="row-actions"><button type="button" :disabled="busy" @click="toggle(item)">{{item.enabled?'停用':'启用'}}</button><button type="button" :aria-label="'编辑'+item.name" :disabled="busy" @click="editPlatform(item)">编辑</button><button type="button" :disabled="busy||testing!==null" @click="probe(item)">{{testing===item.id?'测试中…':'测试连接'}}</button><button type="button" :disabled="busy" @click="remove(item)">删除</button></div></article>
</section>
</template>
<style scoped>
.platform-catalog{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:16px 0}.platform-card{display:flex;align-items:center;gap:12px;text-align:left;padding:18px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:inherit;min-width:0}.platform-card.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.platform-card strong{font-size:17px}.card-detail{display:block;color:var(--muted);font-size:12px;margin-top:6px}.brand-mark{display:grid;place-items:center;width:44px;height:44px;flex:none;border-radius:12px;color:white;font-size:22px;font-weight:700;background:#ca633f}.qimao .brand-mark{background:#87652b}.card-arrow{margin-left:auto;color:var(--muted);font-size:26px}.platform-form{margin:18px 0;padding:18px;border:1px solid var(--border);border-radius:12px;max-width:700px}.platform-form h4{margin:0 0 14px;font-size:17px;color:inherit}.mode-tabs{display:flex;gap:6px;margin:14px 0;flex-wrap:wrap}.mode-tabs button{flex:1;min-height:44px;padding:9px 10px;font-size:13px}.mode-tabs [aria-selected=true]{background:var(--accent);color:#fff;border-color:var(--accent)}.mode-panel{min-width:0}.mode-panel p{line-height:1.65}.platform-row{display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid var(--border);padding:16px 0}.platform-row>div:first-child{min-width:0}.platform-row p{margin:6px 0}.row-actions{display:flex;gap:8px;flex-wrap:wrap}.platform-row .row-actions{justify-content:flex-end;flex-shrink:0}.inline{display:flex;align-items:center;gap:8px}.inline input{width:20px;height:20px;flex:none}.url,.issue{overflow-wrap:anywhere;font-size:13px}.url{color:var(--muted)}.issue{color:var(--warning-text,#8a551e)}.advanced{margin:14px 0}.advanced summary{cursor:pointer;min-height:32px}.error{overflow-wrap:anywhere}.platform-sources button{min-height:40px}@media(prefers-color-scheme:dark){.issue{color:#dfba87}}@media(max-width:650px){.platform-catalog{grid-template-columns:1fr}.platform-card{padding:14px}.platform-form{padding:12px}.mode-tabs{gap:4px}.mode-tabs button{padding:8px 5px;min-width:0;flex-basis:28%}.platform-row{display:block}.platform-row .row-actions{margin-top:12px;justify-content:flex-start}.platform-sources button{min-height:44px}}
</style>
