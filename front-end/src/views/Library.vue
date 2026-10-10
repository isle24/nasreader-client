<script setup lang="ts">
// Library / shelves / search. Shows real server state, real errors and the explicit
// offline ("已下载") state; downloads the reading payload into the per server+user
// IndexedDB cache.
import {ref,onMounted,onBeforeUnmount,watch,computed,nextTick} from 'vue';import {useRoute,useRouter} from 'vue-router';
import {api,state,refreshAccess} from '../state';
import {cachedBooks,saveBook} from '../api/cache';
import type {Book} from '../api/client';
import {errorMessage,integrationError} from '../api/errors';
import {createSourcePluginsApi,RESULT_LABEL,type BookSource} from '../api/sourcePlugins';
import {catalogKind,booksOfKind,readableLibraries,type LibraryRef} from '../api/libraries';
import {discoverHash} from '../api/discover';
import BookCover from '../components/BookCover.vue';
import CategoryFilter from '../components/CategoryFilter.vue';
import CategoryAssignment from '../components/CategoryAssignment.vue';
import ScrapeSources from '../components/ScrapeSources.vue';
import type {ScrapeProvider} from '../api/metadata';

const route=useRoute(),router=useRouter();
const books=ref<Book[]>([]),total=ref(0),page=ref(1),q=ref(''),sort=ref('recent'),kind=ref(''),shelves=ref<any[]>([]),libraries=ref<any[]>([]);
const shelf=ref(''),library=ref(typeof route.query.library==='string'?route.query.library:''),newShelf=ref(''),loading=ref(true),error=ref(''),selected=ref<Book|null>(null),message=ref('');
const category=ref(typeof route.query.category==='string'?route.query.category:'');
const recent=ref<Book[]>([]),coverFile=ref<File|null>(null),coverBusy=ref(false),downloaded=ref<Set<number>>(new Set()),downloadBusy=ref(false),sheet=ref<HTMLElement|null>(null),scrapeProviders=ref<ScrapeProvider[]>(['embedded','neodb','openlibrary','google']),scrapeBusy=ref(false);
const canManageSelected=computed(()=>selected.value?.can_manage===true),editingMetadata=ref(false),deletingBook=ref(false),metadataBusy=ref(false),metadataDraft=ref({title:'',author:'',description:''});
const sourceClient=createSourcePluginsApi(api),bookSource=ref<BookSource|null>(null),sourceError=ref(''),sourceBusy=ref(false),updateBusy=ref(false);let sourceGeneration=0,updateTimer:ReturnType<typeof setTimeout>|undefined;
let generation=0,detailGeneration=0,viewClosed=false;
const title=computed(()=>route.path==='/shelves'?'我的书架':route.path==='/search'?'找一本书':'全部图书');
const portalKind=computed(()=>catalogKind(route.path)),activeKind=computed(()=>portalKind.value||(kind.value==='book'||kind.value==='comic'?kind.value:undefined));
const visibleLibraries=computed(()=>readableLibraries(libraries.value as LibraryRef[],activeKind.value));
const online=computed(()=>!state.offline&&navigator.onLine);

function readRecent():number[]{try{const ids=JSON.parse(localStorage.getItem('nasreader.recent:'+state.server+':'+(state.user?.id??0))??'[]');return Array.isArray(ids)?ids:[]}catch{return []}}
async function loadDownloaded(){
  if(!state.user)return;
  try{downloaded.value=new Set((await cachedBooks(state.server,state.user.id)).map(x=>x.book.id))}catch{/* cache unavailable (private mode) */ }
}
async function load(){
  const g=++generation;
  loading.value=true;error.value='';
  try{
    if(!state.user){await router.replace('/login');return}
    if(state.offline){books.value=(await cachedBooks(state.server,state.user.id)).map(x=>x.book).filter(b=>!state.revokedBookIDs.includes(b.id));books.value=booksOfKind(books.value,activeKind.value);total.value=books.value.length;return}
    const path=shelf.value&&route.path==='/shelves'?`/shelves/${shelf.value}/books?`:'/books?';
    const query=new URLSearchParams({page:String(page.value),page_size:'40',q:q.value,sort:sort.value,...(activeKind.value?{content_kind:activeKind.value}:{}),...(library.value?{library:library.value}:{}),...(category.value?{category:category.value}:{})});
    const data=await api.get<{items:Book[];total:number}>(path+query);
    if(g===generation){books.value=booksOfKind(data.items,activeKind.value).filter(book=>!state.revokedBookIDs.includes(book.id));total.value=data.total}
  }catch(e:any){if(g===generation)error.value=errorMessage(e)}
  finally{if(g===generation)loading.value=false}
}
async function init(){
  if(!state.user){await router.replace('/login');return}
  try{const [s,l]=await Promise.all([api.get<{items:any[]}>('/shelves'),api.get<{items:any[]}>('/libraries')]);shelves.value=s.items;libraries.value=l.items;if(library.value&&!readableLibraries(libraries.value as LibraryRef[],activeKind.value).some(lib=>String(lib.id)===library.value))library.value=''}
  catch(e:any){message.value='书架与书库列表读取失败：'+errorMessage(e)}
  try{recent.value=booksOfKind((await Promise.all(readRecent().slice(0,20).map((id:number)=>api.get<Book>(`/books/${id}`).catch(()=>null)))).filter(Boolean) as Book[],portalKind.value).filter(book=>!state.revokedBookIDs.includes(book.id)).slice(0,8)}catch{/* optional row */ }
  await loadDownloaded();
  await load();
}
async function createShelf(){
  try{
    const created=await api.post<any>('/shelves',{name:newShelf.value});
    shelves.value.push(created);newShelf.value='';shelf.value=String(created.id);message.value='书架已创建';await load();
  }catch(e:any){error.value=errorMessage(e)}
}
async function addToShelf(id:number){
  try{await api.post(`/shelves/${id}/books`,{book_id:selected.value!.id});message.value='已加入书架'}
  catch(e:any){message.value=errorMessage(e)}
}
async function download(){
  if(!selected.value||!state.user||downloadBusy.value)return;
  const book=selected.value;
  downloadBusy.value=true;message.value='正在下载离线内容…';
  try{
    const [progress,notes]=await Promise.all([
      api.get(`/progress/${book.id}`).catch(()=>undefined),
      api.get<{items:any[]}>(`/notes?book_id=${book.id}`).catch(()=>({items:[]})),
    ]);
    if(book.format==='txt'){
      const chapters=(await api.get<{items:any[]}>(`/books/${book.id}/chapters`)).items;
      const texts:Record<number,string>={};
      for(let i=0;i<chapters.length;i++){
        texts[chapters[i].idx]=(await api.get<{text:string}>(`/books/${book.id}/chapters/${chapters[i].idx}`)).text;
        message.value=`正在下载离线内容… ${Math.round(((i+1)/Math.max(1,chapters.length))*100)}%`;
      }
      await saveBook(state.server,state.user.id,book,{chapters,texts,progress,notes:notes.items});
    }else{
      await saveBook(state.server,state.user.id,book,{chapters:[],texts:{},file:await api.blob(`/books/${book.id}/file`),progress,notes:notes.items});
    }
    await loadDownloaded();
    message.value='已下载，可离线阅读';
  }catch(e:any){message.value='离线下载失败：'+errorMessage(e)}
  finally{downloadBusy.value=false}
}
async function scrape(){
  if(!selected.value||scrapeBusy.value)return;
  const id=selected.value.id,g=detailGeneration;
  scrapeBusy.value=true;message.value='正在按优先级补齐元数据和封面…';
  try{
    const result=await api.post<{total:number;applied_fields:string[];book:Book;outcomes:{provider:string;status:string;error?:string}[]}>('/books/'+id+'/scrape',{providers:scrapeProviders.value});
    if(!isCurrentDetail(id,g))return;
    applyCover(result.book,g);
    const labels:Record<string,string>={cover:'封面',author:'作者',description:'简介',title:'书名'};
    const applied=result.applied_fields.map(f=>labels[f]??f);
    message.value=[applied.length?'已补齐'+applied.join('、'):'未找到可自动补齐的数据',result.total?`${result.total} 个候选待审核`: '',result.outcomes.filter(o=>o.status==='failed').map(o=>`${providerLabels[o.provider]??o.provider}：${o.error}`).join('；')].filter(Boolean).join('；');
  }catch(e:any){if(isCurrentDetail(id,g))message.value=integrationError('刮削元数据',e)}
  finally{scrapeBusy.value=false}
}
// A cover change also changes `has_cover`, which the grid already loaded: patch
// the cached rows so the shelf reflects it without another round trip.
function isCurrentDetail(id:number,g:number){return !viewClosed&&g===detailGeneration&&selected.value?.id===id}
async function loadBookDetail(id:number,g:number){
  try{
    const detail=await api.get<Book>('/books/'+id);
    if(isCurrentDetail(id,g))applyCover({...detail,can_manage:detail.can_manage===true},g);
  }catch(e){if(isCurrentDetail(id,g))message.value='图书详情读取失败：'+errorMessage(e)}
}
function applyCover(updated:Book,g:number){
  if(isCurrentDetail(updated.id,g))selected.value={...selected.value!,...updated};
  const index=books.value.findIndex(b=>b.id===updated.id);
  if(index>=0)books.value[index]={...books.value[index],...updated};
  const recentIndex=recent.value.findIndex(b=>b.id===updated.id);
  if(recentIndex>=0)recent.value[recentIndex]={...recent.value[recentIndex],...updated};
}
async function uploadCover(){
  if(!selected.value||!coverFile.value)return;
  const id=selected.value.id,g=detailGeneration,file=coverFile.value;
  coverBusy.value=true;
  try{
    const updated=await api.request<Book>('/books/'+id+'/cover/upload',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});
    if(isCurrentDetail(id,g)){applyCover(updated,g);message.value='封面已更新'}
  }catch(e:any){if(isCurrentDetail(id,g))message.value='上传封面失败：'+errorMessage(e)}
  finally{coverBusy.value=false;coverFile.value=null}
}
async function extractCover(){
  if(!selected.value)return;
  const id=selected.value.id,g=detailGeneration;
  coverBusy.value=true;
  try{
    const updated=await api.request<Book>('/books/'+id+'/cover/upload',{method:'POST',headers:{'Content-Type':'application/epub+zip'}});
    if(isCurrentDetail(id,g)){applyCover(updated,g);message.value='已从 EPUB 文件内提取封面'}
  }catch(e:any){if(isCurrentDetail(id,g))message.value='提取封面失败：'+errorMessage(e)}
  finally{coverBusy.value=false}
}
async function clearCover(){
  if(!selected.value)return;
  const id=selected.value.id,g=detailGeneration;
  coverBusy.value=true;
  try{
    const updated=await api.delete<Book>('/books/'+id+'/cover');
    if(isCurrentDetail(id,g)){applyCover(updated,g);message.value='封面已移除，将显示排版封面'}
  }catch(e:any){if(isCurrentDetail(id,g))message.value='移除封面失败：'+errorMessage(e)}
  finally{coverBusy.value=false}
}
const providerLabels:Record<string,string>={embedded:'书内元数据',filename:'文件名',ai:'AI',openlibrary:'Open Library',google:'Google Books',neodb:'NeoDB'}
function editMetadata(){if(!selected.value)return;metadataDraft.value={title:selected.value.title,author:selected.value.author||'',description:selected.value.description||''};editingMetadata.value=true}
async function saveMetadata(){if(!selected.value||!canManageSelected.value||metadataBusy.value)return;const id=selected.value.id,g=detailGeneration;metadataBusy.value=true;try{await api.send('/books/'+id,'PATCH',{...metadataDraft.value});const detail=await api.get<Book>('/books/'+id);if(isCurrentDetail(id,g)){applyCover({...detail,can_manage:detail.can_manage===true},g);editingMetadata.value=false;message.value='书籍信息已保存'}}catch(e){if(isCurrentDetail(id,g))message.value=errorMessage(e)}finally{metadataBusy.value=false}}
async function deleteRecord(){if(!selected.value||!canManageSelected.value||metadataBusy.value)return;const id=selected.value.id,g=detailGeneration;metadataBusy.value=true;try{await api.delete('/books/'+id);if(isCurrentDetail(id,g)){closeSheet();message.value='书籍目录记录已删除，源文件保留'}await init()}catch(e){if(isCurrentDetail(id,g))message.value=errorMessage(e)}finally{metadataBusy.value=false}}
function closeSheet(){detailGeneration++;editingMetadata.value=false;deletingBook.value=false;coverFile.value=null;selected.value=null;message.value='';bookSource.value=null;sourceGeneration++;clearTimeout(updateTimer);updateBusy.value=false}
function onKeydown(e:KeyboardEvent){if(e.key==='Escape'&&selected.value)closeSheet()}
async function loadBookSource(id:number){const g=++sourceGeneration;bookSource.value=null;sourceError.value='';sourceBusy.value=true;try{const value=await sourceClient.bookSource(id);if(g===sourceGeneration)bookSource.value=value}catch(e){if(g===sourceGeneration)sourceError.value=integrationError('书源信息',e)}finally{if(g===sourceGeneration)sourceBusy.value=false}}
async function trackBookUpdate(jobID:number,id:number,g:number){try{const job=await api.get<any>('/imports/'+jobID);if(g!==sourceGeneration||selected.value?.id!==id)return;if(job.status==='pending'||job.status==='running'){message.value='正在检查并导入连载更新…';updateTimer=setTimeout(()=>void trackBookUpdate(jobID,id,g),1500);return}updateBusy.value=false;message.value=RESULT_LABEL[job.result_kind]||job.error||'更新任务已结束';if(job.result_book_id&&job.result_book_id!==id)message.value+=' · 结果见导入任务';await load();if(g!==sourceGeneration||selected.value?.id!==id)return;const fresh=books.value.find(book=>book.id===id);if(fresh)selected.value={...selected.value,...fresh};await loadBookDetail(id,detailGeneration);if(g===sourceGeneration&&selected.value?.id===id)await loadBookSource(id)}catch(e){if(g===sourceGeneration){updateBusy.value=false;message.value=integrationError('连载更新结果',e)}}}
async function updateBook(){if(!selected.value||!bookSource.value?.can_update||updateBusy.value)return;updateBusy.value=true;const id=selected.value.id,g=sourceGeneration;try{const job=await sourceClient.updateBook(id);if(g!==sourceGeneration)return;message.value='已提交连载更新';void trackBookUpdate(job.id,id,g)}catch(e){if(g===sourceGeneration){updateBusy.value=false;message.value=integrationError('连载更新',e)}}}
async function openSheet(book:Book){const g=++detailGeneration;selected.value={...book,can_manage:false};editingMetadata.value=false;deletingBook.value=false;coverFile.value=null;message.value='';updateBusy.value=false;clearTimeout(updateTimer);if(book.content_kind!=='comic')void loadBookSource(book.id);else{sourceGeneration++;bookSource.value=null;sourceError.value=''}if(!state.offline)void loadBookDetail(book.id,g);await nextTick();if(isCurrentDetail(book.id,g))sheet.value?.querySelector<HTMLElement>('button,a,input,select,textarea')?.focus()}
function libraryFocus(){if(document.visibilityState==='visible'&&!state.offline){void refreshAccess([...books.value.map(book=>book.id),...recent.value.map(book=>book.id),...(selected.value?[selected.value.id]:[])]).catch(()=>{});void init()}}
onMounted(()=>{window.addEventListener('focus',libraryFocus);window.addEventListener('online',libraryFocus);window.addEventListener('keydown',onKeydown);void init()});
watch(()=>state.accessEpoch,()=>{const denied=state.revokedBookIDs;if(selected.value&&denied.includes(selected.value.id))closeSheet();books.value=books.value.filter(book=>!denied.includes(book.id));recent.value=recent.value.filter(book=>!denied.includes(book.id));void loadDownloaded();void init()});
onBeforeUnmount(()=>{viewClosed=true;detailGeneration++;window.removeEventListener('focus',libraryFocus);window.removeEventListener('online',libraryFocus);sourceGeneration++;clearTimeout(updateTimer);window.removeEventListener('keydown',onKeydown)});
watch(()=>route.path,()=>{page.value=1;shelf.value='';closeSheet();void init()});
watch([library,kind,shelf],()=>{category.value='';page.value=1},{flush:'sync'});
watch([page,sort,shelf,library,kind,category],load);
</script>
<template><main class="page">
<div class="page-title"><div><h1>{{title}}</h1><p>{{state.offline?'已下载书籍':`共 ${total} 本 · 与家人共享的阅读收藏`}}</p></div><div class="row-actions"><RouterLink v-if="state.user&&!state.offline" class="button" :to="{path:'/categories',query:{content_kind:activeKind||'book',...(library?{library}:{})}}">分类</RouterLink><RouterLink v-if="state.user&&portalKind" class="button" :to="{path:'/collections',query:{content_kind:portalKind,...(library?{library}:{})}}">系列集合</RouterLink><RouterLink v-if="state.user" to="/import" class="button primary">导入图书</RouterLink><RouterLink v-if="state.user" to="/admin/libraries" class="button">{{state.user.role==='admin'?'书库管理':'管理我的书库'}}</RouterLink></div></div>
<section v-if="recent.length&&route.path==='/'" class="continue"><h2>继续阅读</h2><div class="continue-row">
<RouterLink v-for="b in recent" :key="b.id" :to="'/read/'+b.id"><BookCover :book="b"/><div><strong>{{b.title}}</strong><p>回到上次的位置</p></div></RouterLink>
</div></section>
<form class="toolbar" @submit.prevent="page=1;load()">
<label class="sr-only" for="library-search">搜索书名或作者</label><input id="library-search" v-model="q" placeholder="搜索书名或作者">
<button>搜索</button>
<select v-if="!portalKind" v-model="kind" aria-label="内容类型"><option value="">全部内容</option><option value="book">图书</option><option value="comic">漫画</option></select>
<select v-model="sort" aria-label="排序"><option value="recent">最近添加</option><option value="title">书名</option></select>
<select v-model="library" aria-label="书库筛选"><option value="">所有书库</option><option v-for="l in visibleLibraries" :key="l.id" :value="String(l.id)">{{l.name}}</option></select>
<CategoryFilter v-if="!state.offline&&!(route.path==='/shelves'&&shelf)" v-model="category" :library="library" :kind="activeKind" :libraries="visibleLibraries"/>
</form>
<section v-if="route.path==='/shelves'" class="shelves-toolbar">
<select v-model="shelf" aria-label="选择书架"><option value="">全部图书</option><option v-for="s in shelves" :key="s.id" :value="String(s.id)">{{s.name}}</option></select>
<form @submit.prevent="createShelf"><label class="sr-only" for="new-shelf">新书架名称</label><input id="new-shelf" v-model="newShelf" placeholder="新书架名称" required><button>新建书架</button></form>
<button v-if="shelf" @click="api.delete('/shelves/'+shelf).then(init)">删除空书架</button>
</section>
<p v-if="error" role="alert" class="error">{{error}} <button @click="load">重试</button></p>
<p v-if="message&&!selected" role="status" class="status-banner">{{message}}</p>
<div class="book-grid" v-if="loading"><div v-for="n in 12" :key="n" class="skeleton book-cover" aria-hidden="true"></div></div>
<div v-else class="book-grid"><article v-for="book in books" :key="book.id">
<RouterLink :to="'/read/'+book.id"><BookCover :book="book"/><h3>{{book.title}}</h3></RouterLink>
<p>{{book.author||'佚名'}}</p>
<small v-if="downloaded.has(book.id)" class="downloaded">已下载 · 可离线阅读</small>
<small v-else-if="book.status==='missing'" class="missing">源文件缺失</small>
<button class="text-button" @click="openSheet(book)">详情</button>
</article></div>
<div v-if="!loading&&!books.length" class="empty"><h2>{{q?'没有找到这本书':'书房还没有图书'}}</h2><p>导入 TXT、EPUB 或 PDF，或从启用的在线书源加入图书，开始你们的收藏。</p><RouterLink v-if="q&&state.user" class="button online-search" :to="discoverHash(q)">在在线书源里搜索「{{q}}」</RouterLink></div>
<div v-if="total>40" class="pagination"><button :disabled="page===1" @click="page--">上一页</button><span>{{page}} / {{Math.ceil(total/40)}}</span><button :disabled="page*40>=total" @click="page++">下一页</button></div>
</main>
<div v-if="selected" class="modal-backdrop" @click.self="closeSheet"><section ref="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="图书详情">
<button class="close" @click="closeSheet">关闭</button>
<div class="detail-cover"><BookCover :book="selected" eager/></div>
<h2>{{selected.title}}</h2>
<p>{{selected.author||'佚名'}} · {{selected.format.toUpperCase()}} · {{(selected.size/1024).toFixed(1)}} KB<template v-if="selected.word_count"> · {{selected.word_count}} 字</template></p>
<p>{{selected.description||'暂无简介'}}</p>
<CategoryAssignment v-if="!state.offline" :key="selected.id" :book="selected"/>
<RouterLink class="button primary" :to="'/read/'+selected.id">开始阅读</RouterLink>
<button v-if="selected.content_kind!=='comic'" :disabled="downloadBusy" @click="download">{{downloadBusy?'正在下载…':'下载离线阅读'}}</button>
<section v-if="selected.content_kind!=='comic'" aria-label="连载书源"><h3>连载书源</h3><p v-if="sourceBusy" role="status">正在读取书源信息…</p><p v-else-if="sourceError" class="muted">{{sourceError}}</p><template v-else-if="bookSource"><p v-if="bookSource.binding_id">{{bookSource.adapter_name||'原书源'}} · {{RESULT_LABEL[bookSource.status]||'已绑定书源'}}<template v-if="bookSource.last_checked"> · 上次检查 {{new Date(bookSource.last_checked).toLocaleString()}}</template></p><button v-if="bookSource.can_update" :disabled="!online||updateBusy" @click="updateBook">{{updateBusy?'正在检查更新…':'检查连载更新'}}</button><p v-else>当前图书未绑定可更新的书源。</p></template></section>
<h3>加入书架</h3>
<button v-for="s in shelves" :key="s.id" @click="addToShelf(s.id)">{{s.name}}</button>
<p v-if="!shelves.length">在书架页创建你的第一个书架。</p>
<template v-if="canManageSelected"><h3>书籍信息与封面</h3><button :disabled="!online||metadataBusy" @click="editMetadata">编辑书籍信息</button><form v-if="editingMetadata" @submit.prevent="saveMetadata"><label>书名<input v-model="metadataDraft.title" required></label><label>作者<input v-model="metadataDraft.author"></label><label>简介<textarea v-model="metadataDraft.description" rows="4"></textarea></label><button :disabled="metadataBusy">保存书籍信息</button><button type="button" @click="editingMetadata=false">取消编辑</button></form><template v-if="state.user?.role==='admin'">
<ScrapeSources v-model="scrapeProviders" :disabled="scrapeBusy" />
<button :disabled="!online||scrapeBusy" @click="scrape">{{scrapeBusy?'正在刮削…':'刮削元数据和封面'}}</button>
<p v-if="!online"><small>离线时无法搜索元数据。</small></p>
</template><h4>手动设置封面</h4>
<p><small>外网不可用或书源没收录时用这两条路：EPUB 可以直接从文件里取封面，其他格式上传一张图片即可。</small></p>
<button v-if="selected.format==='epub'" :disabled="coverBusy" @click="extractCover">{{coverBusy?'处理中…':'从文件提取封面'}}</button>
<label>上传封面图片<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传封面图片" @change="coverFile=($event.target as HTMLInputElement).files?.[0]??null"></label>
<button :disabled="coverBusy||!coverFile" @click="uploadCover">{{coverBusy?'上传中…':'上传这张图片'}}</button>
<button v-if="selected.has_cover" :disabled="coverBusy||!online" @click="clearCover">移除封面</button><button :disabled="!online||metadataBusy" @click="deletingBook=true">删除记录</button><section v-if="deletingBook" class="status-banner"><p>确认删除「{{selected.title}}」的书籍记录？相关阅读关联会移除，源文件保留；目录再次扫描时可能重新加入。</p><button :disabled="metadataBusy" @click="deleteRecord">确认删除记录</button><button :disabled="metadataBusy" @click="deletingBook=false">取消</button></section>
</template>
<p v-if="message" role="status" class="status-banner">{{message}}</p>
</section></div>
</template>

<style scoped>
.shelves-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:nowrap}
.shelves-toolbar form{display:flex;align-items:center;gap:8px;margin:0;width:auto;min-width:0}
.shelves-toolbar input,.shelves-toolbar select,.shelves-toolbar button{box-sizing:border-box;height:44px;min-height:44px;margin:0;align-self:center}
.shelves-toolbar select{width:180px;flex:0 0 180px}
.shelves-toolbar input{width:240px;min-width:0}
.shelves-toolbar button{white-space:nowrap;flex-shrink:0}
@media(max-width:650px){
  .shelves-toolbar{flex-wrap:wrap}
  .shelves-toolbar form{width:100%;flex:1 1 100%}
  .shelves-toolbar input{width:0;flex:1 1 0}
}
</style>
