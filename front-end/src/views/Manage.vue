<script setup lang="ts">
// "我的书房" / "导入与书库".
//
// Every remote surface keeps its own loading / error / empty state and every mutation
// reports the real server answer. Integration routes (adapters, metadata reviews, TTS
// engines) are implemented after the core service: when the connected server does not
// provide them the section says 暂不可用 instead of showing invented data.
import {ref,reactive,onMounted,onBeforeUnmount,computed,watch} from 'vue';import {useRoute,useRouter} from 'vue-router';
import {api,state} from '../state';
import {clearCached} from '../api/cache';
import {errorMessage,integrationError,isUnavailable} from '../api/errors';
import {meUpdateBody,updateMe,accountError} from '../api/accounts';
import {fetchTtsModels,modelsError,type ServerEngine} from '../api/tts';
import SourcePlugins from '../components/SourcePlugins.vue';
import {RESULT_LABEL} from '../api/sourcePlugins';
import LibraryTargetPicker from '../components/LibraryTargetPicker.vue';
import ScanReport from '../components/ScanReport.vue';
import {readableLibraries} from '../api/libraries';
import AuthenticatedImage from '../components/AuthenticatedImage.vue';

interface Section{items:any[];loading:boolean;error:string;loaded:boolean}
const blank=():Section=>({items:[],loading:false,error:'',loaded:false});
const S=reactive<Record<'libraries'|'jobs'|'devices'|'reviews',Section>>({
  libraries:blank(),jobs:blank(),devices:blank(),reviews:blank(),
});
const route=useRoute(),router=useRouter();
const isImport=computed(()=>route.path==='/import');
const settingsSection=computed(()=>route.path==='/admin/sources'?'sources':route.path==='/admin/speech'?'speech':'');
const isAdmin=computed(()=>state.user?.role==='admin');
const error=ref(''),message=ref('');
const targetLibrary=ref(0);
const deviceName=ref(''),deviceHint=ref(''),issued=ref(''),oldPassword=ref(''),newPassword=ref('');
const upload=ref<File|null>(null),uploadPercent=ref(0),uploadBusy=ref(false),uploadHint=ref('');
const reviewDetail=ref<any|null>(null),reviewMessage=ref(''),reviewBusy=ref(0),jobDetail=ref<any|null>(null),jobLogs=ref<any[]>([]),jobMessage=ref('');
const tts=ref<any>({edge_enabled:false,custom_enabled:false,base_url:'',model:'',voice:'',has_api_key:false,api_key:''});
const ttsState=ref({loading:false,error:'',unavailable:false,saved:''});
const meName=ref(state.user?.username??''),meNameError=ref(''),meNameBusy=ref(false),passwordError=ref('');
const ttsModels=ref<{id:string}[]>([]),ttsModelsMessage=ref(''),ttsModelsError=ref(''),ttsModelsBusy=ref(false);
const location=window.location,navigator=window.navigator;
let timer:ReturnType<typeof setInterval>|undefined;

const STATUS_LABEL:Record<string,string>={pending:'等待中',running:'进行中',completed:'已完成',failed:'失败',cancelled:'已取消',applied:'已应用',rejected:'已丢弃'};
const statusLabel=(value:string)=>STATUS_LABEL[value]??(value||'未知');
const fmtTime=(value:number)=>{try{return value?new Date(value).toLocaleString():'—'}catch{return '—'}};
const scoreText=(value:number)=>Number.isFinite(Number(value))?Math.round(Number(value)<=1?Number(value)*100:Number(value))+'%':'—';

async function perform<T>(action:()=>Promise<T>,success=''):Promise<T|undefined>{
  error.value='';message.value='';
  try{const result=await action();if(success)message.value=success;return result}
  catch(e:any){error.value=errorMessage(e);return undefined}
}
async function loadList(key:'libraries'|'jobs'|'devices'|'reviews',path:string,label:string){
  const section=S[key];section.loading=true;section.error='';
  try{const data=await api.get<{items:any[]}>(path);section.items=Array.isArray(data?.items)?data.items:[];section.loaded=true}
  catch(e:any){section.items=[];section.error=integrationError(label,e)}
  finally{section.loading=false}
}
async function loadTts(){
  ttsState.value={...ttsState.value,loading:true,error:'',unavailable:false,saved:''};
  try{
    tts.value={...(await api.get<any>('/tts/engines')),api_key:''};
  }catch(e:any){
    ttsState.value={loading:false,error:integrationError('朗读引擎配置',e),unavailable:isUnavailable(e),saved:''};
    return;
  }
  ttsState.value={...ttsState.value,loading:false};
}
async function loadAll(){
  if(!state.user){await router.replace('/login');return}
  if(!isImport.value&&!settingsSection.value)await loadList('devices','/device-tokens','设备凭据');
  if(isImport.value)await loadList('jobs','/imports','导入任务');
  if(!isAdmin.value)return;
  await Promise.all([
    ...(isImport.value?[loadList('libraries','/libraries','书库目录')]:[]),
    ...(isImport.value?[loadList('reviews','/metadata/reviews','元数据审核')]:[]),
    ...(settingsSection.value==='speech'?[loadTts()]:[]),
  ]);
}

/* ---------- uploads ---------- */

async function uploadFile(){
  if(!upload.value||uploadBusy.value||!targetLibrary.value)return;
  const file=upload.value;
  uploadBusy.value=true;uploadPercent.value=0;error.value='';uploadHint.value='';
  try{
    const key=`nasreader.upload:${state.server}:${state.user?.id??0}:${targetLibrary.value}:${file.name}:${file.size}:${file.lastModified}`;
    let saved=JSON.parse(localStorage.getItem(key)??'null');
    if(saved){uploadHint.value='正在续传上次中断的上传…'}
    if(!saved){saved={session:await api.post<any>('/uploads/init',{name:file.name,size:file.size,library_id:targetLibrary.value}),next:0};localStorage.setItem(key,JSON.stringify(saved))}
    const session=saved.session;
    for(let i=saved.next;i<session.parts;i++){
      await api.request(`/uploads/${session.id}/part?index=${i}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file.slice(i*session.part_size,(i+1)*session.part_size)});
      saved.next=i+1;localStorage.setItem(key,JSON.stringify(saved));
      uploadPercent.value=Math.round(((i+1)/session.parts)*100);
    }
    await api.post(`/uploads/${session.id}/complete`);
    localStorage.removeItem(key);
    message.value='上传完成，正在导入。失败后重新选择同一文件可继续上传。';
    upload.value=null;
    await loadList('jobs','/imports','导入任务');
  }catch(e:any){error.value='上传失败：'+errorMessage(e)}
  finally{uploadBusy.value=false}
}

/* ---------- import jobs ---------- */

async function openJob(job:any){
  jobMessage.value='';jobLogs.value=[];jobDetail.value=job;
  try{
    const [detail,logs]=await Promise.all([api.get(`/imports/${job.id}`),api.get<{items:any[]}>(`/imports/${job.id}/logs`)]);
    jobDetail.value=detail;jobLogs.value=logs.items??[];
  }catch(e:any){jobMessage.value=errorMessage(e)}
}
async function retryJob(job:any){await perform(async()=>{await api.post(`/imports/${job.id}/retry`);await loadList('jobs','/imports','导入任务')},'已请求重试')}
async function cancelJob(job:any){await perform(async()=>{await api.post(`/imports/${job.id}/cancel`);await loadList('jobs','/imports','导入任务')},'已请求取消')}

/* ---------- metadata reviews ---------- */

async function applyReview(review:any){
  reviewBusy.value=review.id;reviewMessage.value='';
  try{
    const book=await api.post<any>(`/metadata/reviews/${review.id}/apply`);
    reviewMessage.value=`已应用到《${book?.title??review.title}》${book?.author?'（'+book.author+'）':''}`;
    await loadList('reviews','/metadata/reviews','元数据审核');
  }catch(e:any){reviewMessage.value=integrationError('应用候选',e)}
  finally{reviewBusy.value=0}
}
async function discardReview(review:any){
  reviewBusy.value=review.id;reviewMessage.value='';
  try{
    await api.delete(`/metadata/reviews/${review.id}`);
    S.reviews.items=S.reviews.items.filter(x=>x.id!==review.id);
    if(reviewDetail.value?.id===review.id)reviewDetail.value=null;
    reviewMessage.value='候选已丢弃';
  }catch(e:any){reviewMessage.value=integrationError('丢弃候选',e)}
  finally{reviewBusy.value=0}
}

/* ---------- account ---------- */

async function issueDevice(){
  await perform(async()=>{
    const result=await api.post<any>('/device-tokens',{name:deviceName.value});
    issued.value=result.token;deviceName.value='';deviceHint.value='设备密码只显示一次，请立即保存。';
    await loadList('devices','/device-tokens','设备凭据');
  });
}
async function revokeDevice(device:any){await perform(async()=>{await api.delete('/device-tokens/'+device.id);await loadList('devices','/device-tokens','设备凭据')},'设备凭据已撤销')}
async function saveMeName(){
  const parsed=meUpdateBody({username:meName.value},state.user?.username??'');
  if(parsed.error){meNameError.value=parsed.error;return}
  meNameBusy.value=true;meNameError.value='';
  try{
    const updated=await updateMe(api,parsed.body);
    if(state.user)state.user={...state.user,username:updated.username??state.user.username};
    meName.value=state.user?.username??'';
    message.value='用户名已更新；当前登录保持有效';
  }catch(e:any){meNameError.value=accountError(e)}
  finally{meNameBusy.value=false}
}
async function changePassword(){
  const parsed=meUpdateBody({password:newPassword.value,currentPassword:oldPassword.value},state.user?.username??'');
  if(parsed.error){passwordError.value=parsed.error;return}
  passwordError.value='';
  try{
    await updateMe(api,parsed.body);
    oldPassword.value='';newPassword.value='';
    message.value='密码已更新；其他设备上的登录已注销，当前会话保持有效';
  }catch(e:any){passwordError.value=accountError(e)}
}
async function loadTtsModels(){
  const engine:ServerEngine=tts.value.custom_enabled?'custom':'edge';
  ttsModelsBusy.value=true;ttsModelsError.value='';ttsModelsMessage.value='';
  try{
    const models=await fetchTtsModels(api,engine);
    ttsModels.value=models;
    if(!models.length)ttsModelsError.value='朗读服务没有返回任何模型；可以手动填写模型名，或直接使用浏览器语音';
    else{ttsModelsMessage.value=`已获取 ${models.length} 个模型`;if(!tts.value.model)tts.value.model=models[0].id}
  }catch(e:any){ttsModelsError.value=modelsError(e,engine)}
  finally{ttsModelsBusy.value=false}
}
async function saveTts(clearKey=false){
  ttsState.value={...ttsState.value,saved:'',error:''};
  try{
    const body:any={edge_enabled:tts.value.edge_enabled,custom_enabled:tts.value.custom_enabled,base_url:tts.value.base_url,model:tts.value.model,voice:tts.value.voice};
    if(clearKey)body.api_key=null;
    else if(tts.value.api_key)body.api_key=tts.value.api_key;
    tts.value={...(await api.put<any>('/tts/engines',body)),api_key:''};
    ttsState.value={loading:false,error:'',unavailable:false,saved:clearKey?'API 密钥已清除':'朗读引擎已保存'};
  }catch(e:any){ttsState.value={...ttsState.value,error:integrationError('朗读引擎配置',e),unavailable:isUnavailable(e)}}
}
async function logout(){await perform(async()=>{if(navigator.onLine)await api.post('/auth/logout',{refresh_token:api.session?.refresh_token});await api.setSession(null);state.user=null;await router.replace('/login')})}
async function clearDownloads(){await perform(()=>clearCached(state.server,state.user?.id??0),'本账户的离线图书已清除')}
async function scanLibrary(item:any){await perform(async()=>{await api.post(`/libraries/${item.id}/scan`);await loadList('jobs','/imports','导入任务')},'扫描任务已加入队列')}
function copyIssued(){
  try{
    const writing=navigator.clipboard?.writeText(issued.value);
    if(writing)void writing.catch(()=>{error.value='复制失败，请手动选择密码文本'});
    else error.value='当前环境不支持自动复制，请手动选择密码文本';
  }catch{error.value='复制失败，请手动选择密码文本'}
}

function onKeydown(event:KeyboardEvent){
  if(event.key!=='Escape')return;
  if(reviewDetail.value)reviewDetail.value=null;
  else if(jobDetail.value)jobDetail.value=null;
}

onMounted(async()=>{
  const legacy=route.query.section;if(route.path==='/settings'&&(legacy==='sources'||legacy==='speech')){await router.replace(isAdmin.value?'/admin/'+legacy:'/settings');return}
  window.addEventListener('keydown',onKeydown);
  await loadAll();
  meName.value=state.user?.username??'';
});
onBeforeUnmount(()=>{clearInterval(timer);window.removeEventListener('keydown',onKeydown);});
watch([isImport,isAdmin],()=>{
  if(timer){clearInterval(timer);timer=undefined}
  if(!isImport.value||!navigator.onLine)return;
  timer=setInterval(()=>{
    if(!navigator.onLine)return;
    if(S.jobs.items.some(job=>['pending','running'].includes(job.status)))void loadList('jobs','/imports','导入任务');
  },2000);
},{immediate:true});
</script>
<template><main class="page manage">
<div class="page-title"><div><h1>{{isImport?'导入与书库':settingsSection==='sources'?'外部书源':settingsSection==='speech'?'朗读设置':'我的书房'}}</h1><p>{{state.user?.username}} · {{isAdmin?'管理员':'家庭成员'}}</p></div><button v-if="!isImport" @click="logout">退出登录</button></div>
<p v-if="error" role="alert" class="error">{{error}}</p>
<p v-if="message" role="status" class="status-banner">{{message}}</p>
<section v-if="isAdmin&&!isImport&&!settingsSection&&state.license" class="panel"><h2>NAS 授权设备</h2><p>设备码：<code style="overflow-wrap:anywhere">{{state.license.instance_id}}</code></p><p v-if="state.license.max_devices">本授权最多可绑定 {{state.license.max_devices}} 台设备。</p><p>更新或重建容器时保留 NAS 数据目录，设备码会保持不变。</p></section>

<template v-if="isImport||!!settingsSection">
<section v-if="isImport" class="panel"><h2>上传一本书</h2>
<p>支持 TXT、EPUB、PDF，最大 256 MB。中断后重新选择同一文件可续传。</p>
<form @submit.prevent="uploadFile"><LibraryTargetPicker v-model="targetLibrary" kind="book" :disabled="uploadBusy"/>
<label>选择图书文件<input type="file" accept=".txt,.epub,.pdf" :disabled="uploadBusy" @change="upload=($event.target as HTMLInputElement).files?.[0]??null"></label>
<progress :value="uploadPercent" max="100" aria-label="上传进度"></progress>
<span role="status">{{uploadPercent}}%<template v-if="uploadHint"> · {{uploadHint}}</template></span>
<button class="primary" :disabled="!upload||uploadBusy||!targetLibrary">{{uploadBusy?'正在上传…':'上传并导入'}}</button>
</form></section>

<section v-if="isImport&&isAdmin" class="panel"><h2>NAS 目录</h2>
<p>目录必须位于服务器配置的 LIBRARY_ROOT 内，扫描只读取源文件。</p>
<RouterLink class="button" to="/admin/libraries">创建与授权书库</RouterLink>
<p v-if="S.libraries.loading" role="status">正在读取书库目录…</p>
<p v-else-if="S.libraries.error" role="alert" class="error">{{S.libraries.error}} <button @click="loadList('libraries','/libraries','书库目录')">重试</button></p>
<p v-else-if="!S.libraries.items.length" class="empty-inline">还没有配置目录。</p>
<div v-for="item in readableLibraries(S.libraries.items).filter(lib=>lib.storage_kind==='directory'&&lib.can_manage)" :key="item.id" class="list-row">
<div><strong>{{item.name}}</strong><p>{{item.path}} · 上次扫描 {{fmtTime(item.last_scan??0)}}</p></div>
<button @click="scanLibrary(item)">扫描</button>
</div></section>

<section v-if="isImport" class="panel"><h2>导入任务</h2>
<p v-if="S.jobs.loading" role="status">正在读取任务…</p>
<p v-else-if="S.jobs.error" role="alert" class="error">{{S.jobs.error}} <button @click="loadList('jobs','/imports','导入任务')">重试</button></p>
<p v-else-if="!S.jobs.items.length" class="empty-inline">暂无任务。上传或从在线书源导入后，任务会出现在这里。</p>
<div v-for="job in S.jobs.items" :key="job.id" class="job-row">
<strong>任务 #{{job.id}} · {{statusLabel(job.status)}}</strong>
<p>{{isAdmin?(job.path||'（上传）'):'我的导入'}} · 已处理 {{job.processed}} 本</p>
<ScanReport v-if="job.scan_report" :report="job.scan_report"/>
<p v-if="job.result_kind">{{RESULT_LABEL[job.result_kind]||job.result_kind}} <RouterLink v-if="job.result_book_id" :to="'/read/'+job.result_book_id">在书库中打开</RouterLink></p>
<p v-if="job.error" class="error">{{job.error}}</p>
<small>创建 {{fmtTime(job.created_at)}} · 更新 {{fmtTime(job.updated_at)}}</small>
<div class="row-actions">
<button @click="openJob(job)">详情与日志</button>
<button v-if="job.status==='failed'" @click="retryJob(job)">重试</button>
<button v-if="['pending','running'].includes(job.status)" @click="cancelJob(job)">取消</button>
</div>
</div></section>

<section v-if="isImport" class="panel"><h2>从在线书源导入</h2><p>上传和书源导入默认进入自己的个人库。通过库授权与其他成员共享。</p><RouterLink class="button" to="/discover">搜索在线书源</RouterLink><RouterLink class="button" to="/comics">导入漫画</RouterLink></section>
<SourcePlugins v-if="isAdmin&&settingsSection==='sources'" />

<section v-if="isImport&&isAdmin" class="panel"><h2>元数据审核</h2>
<p>候选由图书详情里的“搜索元数据和封面”产生；高置信度可能已自动应用，其余需要你确认。</p>
<p v-if="S.reviews.loading" role="status">正在读取候选…</p>
<p v-else-if="S.reviews.error" role="alert" class="error">{{S.reviews.error}} <button @click="loadList('reviews','/metadata/reviews','元数据审核')">重试</button></p>
<p v-else-if="!S.reviews.items.length" class="empty-inline">暂无候选，在图书详情中发起搜索。</p>
<article v-for="review in S.reviews.items" :key="review.id" class="review">
<h3>{{review.title||'（无标题候选）'}}</h3>
<p>{{review.author||'未知作者'}}</p>
<p class="clamp">{{review.description||'没有简介'}}</p>
<small>{{review.provider||'未知来源'}} · {{statusLabel(review.status)}} · 置信度 {{scoreText(review.score)}}</small>
<div class="row-actions">
<button @click="reviewDetail=review">查看详情</button>
<button class="primary" :disabled="reviewBusy===review.id" @click="applyReview(review)">{{reviewBusy===review.id?'处理中…':'应用'}}</button>
<button :disabled="reviewBusy===review.id" @click="discardReview(review)">丢弃</button>
</div>
</article>
<p v-if="reviewMessage" role="status" class="status-banner">{{reviewMessage}}</p>
</section>

<section v-if="isAdmin&&settingsSection==='speech'" class="panel" id="speech-settings" aria-label="服务器朗读配置"><h2>服务器朗读引擎</h2>
<p>内置中文朗读无需另开容器或填写服务地址；需要服务器联网。启用后在阅读器选择「内置中文朗读」，也可使用设备系统语音。</p>
<p v-if="ttsState.loading" role="status">正在读取朗读引擎配置…</p>
<p v-else-if="ttsState.error" role="alert" class="error">{{ttsState.error}} <button @click="loadTts">重试</button></p>
<template v-else>
<form @submit.prevent="saveTts()">
<label class="inline"><input v-model="tts.edge_enabled" type="checkbox">启用内置中文朗读</label>
<label class="inline"><input v-model="tts.custom_enabled" type="checkbox">启用自定义 HTTP TTS</label>
<template v-if="tts.custom_enabled"><label>HTTP 地址<input v-model="tts.base_url" type="url" placeholder="https://…"></label>
<label>模型
<span class="row-actions">
<select v-if="ttsModels.length" v-model="tts.model"><option v-for="m in ttsModels" :key="m.id" :value="m.id">{{m.id}}</option><option v-if="tts.model&&!ttsModels.some(m=>m.id===tts.model)" :value="tts.model">{{tts.model}}（当前）</option></select>
<input v-else v-model="tts.model" placeholder="tts-1">
<button type="button" :disabled="ttsModelsBusy||!isAdmin" @click="loadTtsModels">{{ttsModelsBusy?'获取中…':'获取模型'}}</button>
</span>
</label>
<p v-if="ttsModelsMessage" role="status">{{ttsModelsMessage}}</p>
<p v-else-if="ttsModelsError" role="alert" class="error">{{ttsModelsError}}</p>
<label>自定义音色<input v-model="tts.voice"></label>
<label>API 密钥<input v-model="tts.api_key" type="password" autocomplete="off" :placeholder="tts.has_api_key?'已配置，留空保留':'未配置'"></label>
</template><p v-if="tts.edge_enabled">内置音色：晓晓、云希、晓伊、云健，在阅读器中选择。无需 API 密钥。</p><div class="row-actions"><button class="primary" :disabled="!isAdmin">保存引擎</button><button type="button" :disabled="!tts.has_api_key" @click="saveTts(true)">清除已保存的密钥</button></div>
</form>
<p v-if="ttsState.saved" role="status">{{ttsState.saved}}</p>
</template>
</section>

<section v-if="isImport&&isAdmin" class="panel"><h2>书籍管理</h2>
<p>按问题视图筛选（源文件缺失、重复内容、无封面、无作者、无简介、从未打开、最近新增），批量加书架 / 改书库 / 扫描 / 提取封面 / 刮削 / 删除记录，并查看存储占用与重复合并。</p>
<div class="list-row"><div><strong>书籍管理页</strong><p>表格视图、批量操作、存储统计与重复内容</p></div><RouterLink class="button" to="/admin/books">打开书籍管理</RouterLink></div>
</section>
</template>

<template v-else>
<section class="panel"><h2>账户安全</h2>
<form @submit.prevent="saveMeName">
<label>用户名<input v-model="meName" required autocomplete="username"></label>
<button :disabled="meNameBusy">{{meNameBusy?'保存中…':'修改用户名'}}</button>
<p v-if="meNameError" role="alert" class="error">{{meNameError}}</p>
</form>
<form @submit.prevent="changePassword">
<label>当前密码<input v-model="oldPassword" type="password" autocomplete="current-password" required></label>
<label>新密码<input v-model="newPassword" type="password" minlength="10" autocomplete="new-password" required></label>
<button>修改密码</button>
<p v-if="passwordError" role="alert" class="error">{{passwordError}}</p>
</form>
<button v-if="state.native" @click="router.push('/login')">切换服务器</button>
</section>

<section class="panel"><h2>电子书设备</h2>
<p>OPDS 地址：{{state.server||location.origin}}/opds/v2<br>KOReader 同步地址：{{state.server||location.origin}}<br>设备使用当前用户名与独立设备密码。</p>
<form @submit.prevent="issueDevice">
<label>设备名称<input v-model="deviceName" required placeholder="例如我的阅读器"></label>
<button>生成设备密码</button>
</form>
<p v-if="issued" class="one-time" role="status">一次性设备密码：<code>{{issued}}</code>
<button @click="copyIssued">复制</button><button @click="issued='';deviceHint=''">隐藏</button></p>
<p v-if="deviceHint" role="status"><small>{{deviceHint}}</small></p>
<p v-if="S.devices.loading" role="status">正在读取设备…</p>
<p v-else-if="S.devices.error" role="alert" class="error">{{S.devices.error}} <button @click="loadList('devices','/device-tokens','设备凭据')">重试</button></p>
<p v-else-if="!S.devices.items.length" class="empty-inline">还没有设备凭据。</p>
<div v-for="device in S.devices.items" :key="device.id" class="list-row">
<div><strong>{{device.name}}</strong><p>创建于 {{fmtTime(device.created_at)}}</p></div>
<button @click="revokeDevice(device)">撤销</button>
</div>
</section>

<section class="panel"><h2>离线书籍</h2>
<p>下载与待同步数据按服务器、账户、图书版本隔离；清除只影响当前账户。</p>
<button @click="clearDownloads">清除本账户下载</button>
</section>

</template>

<div v-if="reviewDetail" class="modal-backdrop" @click.self="reviewDetail=null"><section class="sheet" role="dialog" aria-modal="true" aria-label="元数据候选详情">
<button class="close" @click="reviewDetail=null">关闭</button>
<h2>{{reviewDetail.title||'（无标题候选）'}}</h2>
<div class="cover-preview"><AuthenticatedImage :path="`/books/${reviewDetail.book_id}/cover`" :alt="'当前封面'" eager>
<template #placeholder><p class="empty-inline">正在读取当前封面…</p></template>
<template #fallback><p class="empty-inline">这本书还没有封面</p></template>
</AuthenticatedImage></div>
<p>{{reviewDetail.author||'未知作者'}}</p>
<blockquote>{{reviewDetail.description||'没有简介'}}</blockquote>
<dl class="review-meta">
<dt>来源</dt><dd>{{reviewDetail.provider||'未知'}}</dd>
<dt>状态</dt><dd>{{statusLabel(reviewDetail.status)}}</dd>
<dt>置信度</dt><dd>{{scoreText(reviewDetail.score)}}</dd>
<dt>候选封面</dt><dd><a v-if="reviewDetail.cover_url" :href="reviewDetail.cover_url" target="_blank" rel="noreferrer noopener">在新窗口打开候选封面</a><span v-else>候选没有提供封面</span></dd>
<dt>来源页面</dt><dd><a v-if="reviewDetail.url" :href="reviewDetail.url" target="_blank" rel="noreferrer noopener">打开提供方页面</a><span v-else>未提供</span></dd>
</dl>
<div class="row-actions">
<button class="primary" :disabled="reviewBusy===reviewDetail.id" @click="applyReview(reviewDetail)">{{reviewBusy===reviewDetail.id?'处理中…':'应用这个候选'}}</button>
<button :disabled="reviewBusy===reviewDetail.id" @click="discardReview(reviewDetail)">丢弃</button>
</div>
<p v-if="reviewMessage" role="status" class="status-banner">{{reviewMessage}}</p>
</section></div>

<div v-if="jobDetail" class="modal-backdrop" @click.self="jobDetail=null"><section class="sheet" role="dialog" aria-modal="true" aria-label="导入任务详情">
<button class="close" @click="jobDetail=null">关闭</button>
<h2>任务 #{{jobDetail.id}} · {{statusLabel(jobDetail.status)}}</h2>
<p>{{isAdmin?(jobDetail.path||'（上传）'):'我的导入'}} · 已处理 {{jobDetail.processed}} 本</p>
<ScanReport v-if="jobDetail.scan_report" :report="jobDetail.scan_report"/>
<p v-if="jobDetail.result_kind">{{RESULT_LABEL[jobDetail.result_kind]||jobDetail.result_kind}} <RouterLink v-if="jobDetail.result_book_id" :to="'/read/'+jobDetail.result_book_id">在书库中打开</RouterLink></p>
<p v-if="jobDetail.error" class="error">{{jobDetail.error}}</p>
<p><small>创建 {{fmtTime(jobDetail.created_at)}} · 更新 {{fmtTime(jobDetail.updated_at)}}</small></p>
<h3>日志</h3>
<p v-if="jobMessage" role="alert" class="error">{{jobMessage}}</p>
<p v-else-if="!jobLogs.length" class="empty-inline">暂无日志。</p>
<pre v-else>{{jobLogs.map(log=>`[${fmtTime(log.created_at)}] ${log.message??''}`).join('\n')}}</pre>
<div class="row-actions">
<button v-if="jobDetail.status==='failed'" @click="retryJob(jobDetail)">重试</button>
<button v-if="['pending','running'].includes(jobDetail.status)" @click="cancelJob(jobDetail)">取消</button>
</div>
</section></div>
</main></template>

<style scoped>
.settings-navigation{display:flex;gap:8px;margin:0 0 24px;overflow:auto;padding:4px;background:var(--surface);border:1px solid var(--border);border-radius:14px}
.settings-navigation a{flex:1;min-height:46px;display:flex;align-items:center;justify-content:center;white-space:nowrap;padding:10px 14px;border-radius:10px;font-size:14px;color:var(--muted)}
.settings-navigation a.selected{background:#e5eeea;color:var(--accent);font-weight:650}
@media(max-width:420px){.settings-navigation{gap:2px}.settings-navigation a{padding:10px 7px;font-size:13px}}
</style>
