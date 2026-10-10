<script setup lang="ts">
import CategoryAssignment from '../components/CategoryAssignment.vue';
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {api,state} from '../state';
import {createCollectionsApi,type Collection,type CollectionMember} from '../api/collections';
import {readableLibraries,type LibraryRef,type ContentKind} from '../api/libraries';
import {errorMessage} from '../api/errors';
import BookCover from '../components/BookCover.vue';
import CollectionMembersEditor from '../components/CollectionMembersEditor.vue';
const categoryEditor=ref(false);
const route=useRoute(),router=useRouter(),client=createCollectionsApi(api);
const kind=computed<ContentKind>(()=>detail.value?.content_kind??(route.query.content_kind==='comic'?'comic':'book'));
const libraries=ref<LibraryRef[]>([]),visibleLibraries=computed(()=>readableLibraries(libraries.value,kind.value)),managedLibraries=computed(()=>visibleLibraries.value.filter(lib=>lib.can_manage));
const rows=ref<Collection[]>([]),detail=ref<Collection|null>(null),members=ref<CollectionMember[]>([]),total=ref(0),page=ref(1),memberTotal=ref(0),memberPage=ref(1),library=ref(typeof route.query.library==='string'?route.query.library:''),q=ref(''),deleted=ref(route.query.deleted==='1'),loading=ref(true),error=ref(''),message=ref(''),busyID=ref(0);
const infoMode=ref<'create'|'edit'|null>(null),draft=ref({name:'',description:'',library_id:0,revision:0}),infoError=ref(''),saving=ref(false),infoConflict=ref(false),memberEditor=ref(false),deleteConfirm=ref(false);
const detailID=computed(()=>Number(route.params.id)||0),portalPath=computed(()=>kind.value==='comic'?'/comics':'/'),listPath=computed(()=>({path:'/collections',query:{content_kind:kind.value,...(library.value?{library:library.value}:{})}}));
let closed=false,generation=0,accessGeneration=0;
function libraryName(id:number){return libraries.value.find(lib=>lib.id===id)?.name??'所属书库'}
function label(row:Collection){return row.customized?'已手动维护':row.automatic?'自动归组':'手动集合'}
async function load(){
 const g=++generation;loading.value=true;error.value='';rows.value=[];detail.value=null;members.value=[];
 try{
  if(state.offline||!navigator.onLine)throw new Error('集合需要连接服务器，请联网后重试');
  if(detailID.value){const row=await client.detail(detailID.value);if(closed||g!==generation)return;detail.value=row;if(!row.deleted){const response=await client.members(row.id,memberPage.value);if(closed||g!==generation)return;members.value=response.items.filter(book=>!state.revokedBookIDs.includes(book.id));memberTotal.value=response.total}}
  else{const response=await client.list({content_kind:kind.value,library:Number(library.value)||undefined,q:q.value,page:page.value,deleted:deleted.value});if(closed||g!==generation)return;rows.value=response.items;total.value=response.total}
 }catch(e){if(!closed&&g===generation){detail.value=null;members.value=[];error.value=errorMessage(e)}}finally{if(!closed&&g===generation)loading.value=false}
}
async function init(){
 try{const response=await api.get<{items:LibraryRef[]}>('/libraries');if(closed)return;libraries.value=response.items;if(library.value&&!visibleLibraries.value.some(lib=>String(lib.id)===library.value))library.value='';if(!managedLibraries.value.length)deleted.value=false}
 catch(e){if(!closed){libraries.value=[];error.value=errorMessage(e)}}
 await load();
}
function search(){page.value=1;void load()}
function openInfo(mode:'create'|'edit'){
 infoError.value='';infoConflict.value=false;infoMode.value=mode;
 draft.value=mode==='edit'&&detail.value?{name:detail.value.name,description:detail.value.description,library_id:detail.value.library_id,revision:detail.value.revision}:{name:'',description:'',library_id:managedLibraries.value.some(lib=>String(lib.id)===library.value)?Number(library.value):managedLibraries.value[0]?.id??0,revision:0};
}
async function saveInfo(){
 if(saving.value||infoConflict.value||!draft.value.name.trim())return;saving.value=true;infoError.value='';
 try{
  let row:Collection;
  if(infoMode.value==='create'){if(!managedLibraries.value.some(lib=>lib.id===draft.value.library_id))throw new Error('请选择可管理的书库');row=await client.create({name:draft.value.name.trim(),description:draft.value.description,library_id:draft.value.library_id})}
  else{if(!detail.value?.can_manage)return;row=await client.update(detail.value.id,{name:draft.value.name.trim(),description:draft.value.description,revision:draft.value.revision})}
  if(closed)return;infoMode.value=null;message.value='集合已保存';if(detailID.value)await load();else await router.push({path:'/collections/'+row.id,query:{content_kind:row.content_kind,library:String(row.library_id)}});
 }catch(e:any){if(!closed){infoError.value=errorMessage(e);if([403,404,409].includes(e?.status))infoConflict.value=true}}finally{if(!closed)saving.value=false}
}
async function restore(row:Collection){
 if(!row.can_manage||busyID.value)return;busyID.value=row.id;error.value='';
 try{await client.restore(row.id,row.revision);message.value='集合已恢复';await load()}catch(e){error.value=errorMessage(e)}finally{busyID.value=0}
}
async function remove(){
 const row=detail.value;if(!row?.can_manage||busyID.value)return;busyID.value=row.id;error.value='';
 try{await client.remove(row.id,row.revision);deleteConfirm.value=false;message.value='集合已删除，可在已删除集合中恢复';await router.push({path:'/collections',query:{content_kind:row.content_kind,library:String(row.library_id),deleted:'1'}})}catch(e){error.value=errorMessage(e)}finally{busyID.value=0}
}
async function savedMembers(){memberEditor.value=false;memberPage.value=1;message.value='成员顺序已保存';await load()}
function refresh(){
 accessGeneration++;generation++;infoMode.value=null;memberEditor.value=false;categoryEditor.value=false;deleteConfirm.value=false;rows.value=[];detail.value=null;members.value=[];loading.value=true;void init();
}
async function recheck(){
 const open=infoMode.value||memberEditor.value||categoryEditor.value||deleteConfirm.value;
 if(!open||state.revokedBookIDs.some(id=>members.value.some(book=>book.id===id))){refresh();return}
 // Returning from another app keeps an authorized draft and the revision it was read at.
 const current=detail.value,g=++accessGeneration;
 try{
  const [libs,row]=await Promise.all([api.get<{items:LibraryRef[]}>('/libraries'),current?client.detail(current.id):Promise.resolve(null)]);
  if(closed||g!==accessGeneration)return;
  libraries.value=libs.items;
  const allowed=row?row.can_manage&&!row.deleted:managedLibraries.value.some(lib=>lib.id===draft.value.library_id);
  if(!allowed)refresh();
 }catch(e:any){if(!closed&&g===accessGeneration&&[403,404].includes(e?.status))refresh()}
}
function focus(){if(document.visibilityState==='visible')void recheck()}
function escape(e:KeyboardEvent){if(e.key==='Escape'&&!saving.value&&!busyID.value){infoMode.value=null;categoryEditor.value=false;deleteConfirm.value=false}}
watch(()=>[route.query.content_kind,route.query.library,route.query.deleted],()=>{library.value=typeof route.query.library==='string'?route.query.library:'';deleted.value=route.query.deleted==='1';page.value=1;refresh()});
watch(()=>state.accessEpoch,()=>void recheck());
onMounted(()=>{void init();window.addEventListener('focus',focus);window.addEventListener('online',focus);window.addEventListener('keydown',escape)});
onBeforeUnmount(()=>{closed=true;generation++;accessGeneration++;window.removeEventListener('focus',focus);window.removeEventListener('online',focus);window.removeEventListener('keydown',escape)});
</script>
<template><main class="page collections-page">
<div class="collection-breadcrumb"><RouterLink :to="detailID?listPath:portalPath">← {{detailID?'系列集合':kind==='comic'?'漫画库':'书库'}}</RouterLink></div>
<div class="page-title"><div><h1>{{detail?.name||'系列集合'}}</h1><p v-if="detail">{{libraryName(detail.library_id)}} · {{detail.book_count}} 册 · {{label(detail)}}</p><p v-else>{{kind==='comic'?'漫画':'图书'}} · {{total}} 个集合</p></div><button v-if="!detailID&&managedLibraries.length&&!deleted" class="primary" @click="openInfo('create')">新建集合</button></div>
<p v-if="message" role="status" class="status-banner">{{message}}</p>
<form v-if="!detailID" class="collection-filters" @submit.prevent="search"><label>集合书库<select v-model="library" @change="search"><option value="">全部可读书库</option><option v-for="lib in visibleLibraries" :key="lib.id" :value="String(lib.id)">{{lib.name}}</option></select></label><label class="collection-search">搜索集合<input v-model="q" placeholder="搜索系列或集合名称"></label><button :disabled="loading">搜索</button><label v-if="managedLibraries.length" class="inline deleted-toggle"><input v-model="deleted" type="checkbox" @change="search">显示已删除集合</label></form>
<p v-if="error" role="alert" class="error">{{error}} <button @click="init">重试</button></p><p v-if="loading" role="status">正在读取集合…</p>
<template v-else-if="detail"><p v-if="detail.description" class="collection-description">{{detail.description}}</p><div v-if="detail.can_manage" class="collection-actions"><template v-if="!detail.deleted"><button @click="openInfo('edit')">编辑集合信息</button><button @click="memberEditor=true">管理成员</button><button @click="categoryEditor=true">批量设置分类</button><button @click="deleteConfirm=true">删除集合</button></template><button v-else :disabled="busyID===detail.id" @click="restore(detail)">恢复集合</button></div><p v-if="detail.deleted" class="empty">此集合已删除。恢复后可继续阅读原有成员。</p><template v-else><div v-if="members.length" class="book-grid collection-book-grid"><article v-for="book in members" :key="book.id"><RouterLink :to="'/read/'+book.id" :aria-label="'阅读 '+book.title"><BookCover :book="book"/><h3><span class="volume-position">{{book.position+1}}.</span> {{book.title}}</h3></RouterLink><p>{{book.author||'佚名'}}</p></article></div><section v-else class="empty"><h2>集合还没有成员</h2><p>{{detail.can_manage?'打开“管理成员”，从本库添加内容并调整阅读顺序。':'管理者添加成员后，可在这里按顺序阅读。'}}</p></section><div v-if="memberTotal>24" class="pagination"><button :disabled="memberPage===1" @click="memberPage--;load()">成员上一页</button><span>{{memberPage}} / {{Math.ceil(memberTotal/24)}}</span><button :disabled="memberPage*24>=memberTotal" @click="memberPage++;load()">成员下一页</button></div></template></template>
<template v-else-if="!detailID&&!error"><div v-if="rows.length" class="collection-grid"><article v-for="row in rows" :key="row.id" class="collection-card"><RouterLink :to="{path:'/collections/'+row.id,query:{content_kind:row.content_kind,library:String(row.library_id)}}" :aria-label="'打开集合 '+row.name"><div class="collection-preview"><BookCover v-for="book in row.preview_books.slice(0,4)" :key="book.id" :book="book"/><div v-if="!row.preview_books.length" class="collection-placeholder" aria-hidden="true">▤</div></div><h2>{{row.name}}</h2><p>{{libraryName(row.library_id)}} · {{row.book_count}} 册</p><small>{{label(row)}}</small></RouterLink><button v-if="row.deleted&&row.can_manage" class="restore-collection" :aria-label="'恢复 '+row.name" :disabled="busyID!==0" @click="restore(row)">恢复集合</button></article></div><section v-else class="empty"><h2>{{deleted?'没有已删除集合':q?'没有找到集合':'这里还没有系列集合'}}</h2><p>{{deleted?'删除的集合可在这里恢复。':q?'换一个名称或书库试试。':'同库的系列内容会自动归组，管理者也可以建立手动集合。'}}</p></section><div v-if="total>24" class="pagination"><button :disabled="page===1" @click="page--;load()">上一页</button><span>{{page}} / {{Math.ceil(total/24)}}</span><button :disabled="page*24>=total" @click="page++;load()">下一页</button></div></template>
</main>
<div v-if="infoMode" class="modal-backdrop" @click.self="!saving&&(infoMode=null)"><section class="sheet collection-info" role="dialog" aria-modal="true" :aria-label="infoMode==='create'?'新建集合':'编辑集合信息'"><div class="info-heading"><h2>{{infoMode==='create'?'新建集合':'编辑集合信息'}}</h2><button :disabled="saving" @click="infoMode=null">关闭</button></div><form @submit.prevent="saveInfo"><label v-if="infoMode==='create'">所属书库<select v-model="draft.library_id"><option v-for="lib in managedLibraries" :key="lib.id" :value="lib.id">{{lib.name}}</option></select></label><label>集合名称<input v-model="draft.name" maxlength="100" required></label><label>集合说明<textarea v-model="draft.description" rows="4" maxlength="2000"></textarea></label><p v-if="infoMode==='edit'&&detail?.automatic&&!detail.customized" class="muted">编辑后成员与顺序由你维护，自动扫描不再覆盖。</p><p v-if="infoError" role="alert" class="error">{{infoError}}</p><p v-if="infoConflict">本次修改尚未保存，请关闭并重新打开。</p><div class="info-actions"><button type="button" :disabled="saving" @click="infoMode=null">取消</button><button class="primary" :disabled="saving||infoConflict||!draft.name.trim()||(infoMode==='create'&&!draft.library_id)">{{saving?'正在保存…':infoMode==='create'?'创建集合':'保存集合信息'}}</button></div></form></section></div>
<div v-if="deleteConfirm&&detail" class="modal-backdrop" @click.self="!busyID&&(deleteConfirm=false)"><section class="sheet collection-info" role="dialog" aria-modal="true" aria-label="删除集合确认"><h2>删除集合</h2><p>删除「{{detail.name}}」后，书籍与原文件保留，集合可在已删除列表中恢复。</p><div class="info-actions"><button :disabled="busyID!==0" @click="deleteConfirm=false">取消</button><button :disabled="busyID!==0" @click="remove">确认删除集合</button></div></section></div>
<div v-if="categoryEditor&&detail?.can_manage&&!detail.deleted" class="modal-backdrop" @click.self="categoryEditor=false"><section class="sheet collection-info" role="dialog" aria-modal="true" aria-label="集合分类"><div class="info-heading"><h2>集合分类</h2><button @click="categoryEditor=false">关闭</button></div><CategoryAssignment :collection="detail" @saved="categoryEditor=false;message='集合成员分类已更新'"/></section></div>
<CollectionMembersEditor v-if="memberEditor&&detail?.can_manage&&!detail.deleted" :collection="detail" @close="memberEditor=false" @saved="savedMembers"/>
</template>
<style scoped>
.collection-breadcrumb{margin-bottom:20px;color:var(--accent);font-size:14px}.collection-filters{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:24px 0}.collection-filters label{margin:0;flex:0 1 220px;min-width:0}.collection-filters .collection-search{flex:1 1 220px}.collection-filters>button{margin:0}.collection-filters .deleted-toggle{flex:1 1 100%;font-weight:400;gap:8px;padding-top:4px}.deleted-toggle input{flex:none}.collection-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px}.collection-card{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;padding:16px}.collection-preview{display:flex;gap:8px;align-items:center;height:150px;background:#eef2ef;padding:12px;border-radius:8px;overflow:hidden}.collection-preview .book-cover{width:calc((100% - 24px)/4);min-width:0;padding:5px;border-left-width:2px;flex:none}.collection-preview :deep(.book-cover strong){font-size:11px;-webkit-line-clamp:3}.collection-preview :deep(.book-cover span){font-size:7px}.collection-placeholder{width:100%;text-align:center;font-size:64px;color:var(--accent)}.collection-card h2{font-size:18px;overflow-wrap:anywhere;margin:14px 0 6px}.collection-card p{font-size:13px;color:var(--muted);margin:0 0 6px}.restore-collection{margin-top:14px;width:100%}.collection-actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}.collection-description{color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;max-width:760px}.volume-position{color:var(--muted)}.collection-info{width:min(580px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:24px}.info-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.info-heading h2{margin:0}.info-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:24px}.info-actions button{margin:0}.muted{font-size:13px;color:var(--muted)}@media(max-width:650px){.collections-page .page-title{align-items:flex-start}.collections-page h1{font-size:25px;overflow-wrap:anywhere}.collections-page .page-title>button{flex:none;padding:8px 12px}.collection-filters label{flex-basis:100%}.collection-filters .collection-search{flex:1 1 200px}.collection-grid{grid-template-columns:minmax(0,1fr)}.collection-preview{height:170px;justify-content:center}.collection-preview .book-cover{max-width:88px}.collection-info{padding:20px}.collection-book-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.collection-actions button{font-size:13px;padding:9px 11px}}
</style>
