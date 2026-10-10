<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import {api} from '../state';
import {createCollectionsApi,loadCollectionMembersForEdit,moveCollectionMember,type Collection,type CollectionMember} from '../api/collections';
import {bookKind} from '../api/libraries';
import type {Book} from '../api/client';
import {errorMessage} from '../api/errors';
const props=defineProps<{collection:Collection}>(),emit=defineEmits<{close:[];saved:[Collection]}>();
const client=createCollectionsApi(api),snapshot=ref<Collection|null>(null),members=ref<CollectionMember[]>([]),candidates=ref<Book[]>([]),q=ref(''),page=ref(1),total=ref(0),loading=ref(true),candidateLoading=ref(false),saving=ref(false),error=ref(''),candidateError=ref(''),conflict=ref(false);
const selectedIDs=computed(()=>new Set(members.value.map(book=>book.id)));let closed=false,generation=0;
async function search(){
 const current=snapshot.value;if(!current)return;
 const g=++generation;candidateLoading.value=true;candidateError.value='';candidates.value=[];
 try{const response=await client.candidates(current.library_id,current.content_kind,q.value,page.value);if(closed||g!==generation)return;candidates.value=response.items.filter(book=>book.library_id===current.library_id&&bookKind(book)===current.content_kind);total.value=response.total}
 catch(e){if(!closed&&g===generation)candidateError.value=errorMessage(e)}finally{if(!closed&&g===generation)candidateLoading.value=false}
}
async function init(){
 try{const result=await loadCollectionMembersForEdit(client,props.collection.id);if(closed)return;if(!result.collection.can_manage||result.collection.deleted)throw new Error('当前集合不可管理，请关闭后重新打开');snapshot.value=result.collection;members.value=result.members;await search()}
 catch(e){if(!closed)error.value=errorMessage(e)}finally{if(!closed)loading.value=false}
}
function add(book:Book){if(!snapshot.value||book.library_id!==snapshot.value.library_id||bookKind(book)!==snapshot.value.content_kind||selectedIDs.value.has(book.id))return;members.value.push({...book,position:members.value.length})}
async function save(){
 const current=snapshot.value;if(!current||loading.value||saving.value||conflict.value)return;saving.value=true;error.value='';
 try{const result=await client.replaceMembers(current.id,members.value.map(book=>book.id),current.revision);if(!closed)emit('saved',result)}
 catch(e:any){if(!closed){error.value=errorMessage(e);if([403,404,409].includes(e?.status))conflict.value=true}}
 finally{if(!closed)saving.value=false}
}
function escape(e:KeyboardEvent){if(e.key==='Escape'&&!saving.value)emit('close')}
onMounted(()=>{void init();window.addEventListener('keydown',escape)});onBeforeUnmount(()=>{closed=true;generation++;window.removeEventListener('keydown',escape)});
</script>
<template><div class="modal-backdrop" @click.self="!saving&&emit('close')"><section class="sheet collection-members-editor" role="dialog" aria-modal="true" aria-label="管理集合成员">
<div class="editor-title"><div><h2>管理集合成员</h2><p>{{collection.name}} · 仅可添加本库同类型内容</p></div><button :disabled="saving" @click="emit('close')">关闭</button></div>
<p v-if="loading" role="status">正在读取全部成员…</p><p v-if="error" role="alert" class="error">{{error}}</p><p v-if="conflict">本次修改尚未保存，请关闭并重新打开成员管理。</p>
<template v-if="snapshot&&!loading"><p v-if="snapshot.automatic&&!snapshot.customized" class="collection-hint">保存后成员与顺序由你维护，自动扫描不再覆盖。</p>
<div class="member-editor-columns"><section aria-label="已选成员"><h3>已选 {{members.length}} 册</h3><p v-if="!members.length" class="muted">搜索并添加第一册。</p><ol class="selected-members"><li v-for="(book,index) in members" :key="book.id"><span class="member-number">{{index+1}}</span><div class="member-title"><strong>{{book.title}}</strong><small>{{book.author||'佚名'}}</small></div><div class="member-actions"><button :aria-label="book.title+' 上移'" :disabled="index===0||saving||conflict" @click="members=moveCollectionMember(members,index,-1)">↑</button><button :aria-label="book.title+' 下移'" :disabled="index===members.length-1||saving||conflict" @click="members=moveCollectionMember(members,index,1)">↓</button><button :aria-label="book.title+' 移除'" :disabled="saving||conflict" @click="members.splice(index,1)">移除</button></div></li></ol></section>
<section aria-label="候选书籍"><h3>添加成员</h3><form class="candidate-search" @submit.prevent="page=1;search()"><input v-model="q" aria-label="搜索候选书籍" placeholder="搜索本库书名或作者"><button :disabled="candidateLoading">搜索候选</button></form><p v-if="candidateError" role="alert" class="error">{{candidateError}} <button @click="search">重试</button></p><p v-if="candidateLoading" role="status">正在搜索…</p><p v-else-if="!candidates.length" class="muted">没有匹配的内容，试试其他名称。</p><ul v-else class="candidate-members"><li v-for="book in candidates" :key="book.id"><div class="member-title"><strong>{{book.title}}</strong><small>{{book.author||'佚名'}}</small></div><button :aria-label="'添加 '+book.title" :disabled="selectedIDs.has(book.id)||saving||conflict" @click="add(book)">{{selectedIDs.has(book.id)?'已添加':'添加'}}</button></li></ul><div v-if="total>20" class="candidate-pagination"><button :disabled="page===1||candidateLoading" @click="page--;search()">候选上一页</button><span>{{page}} / {{Math.ceil(total/20)}}</span><button :disabled="page*20>=total||candidateLoading" @click="page++;search()">候选下一页</button></div></section></div>
</template><div class="editor-footer"><span v-if="snapshot">已选 {{members.length}} 册</span><button :disabled="saving" @click="emit('close')">取消</button><button class="primary" :disabled="loading||!snapshot||saving||conflict" @click="save">{{saving?'正在保存…':'保存成员顺序'}}</button></div>
</section></div></template>
<style scoped>
.collection-members-editor{width:min(1080px,calc(100% - 32px));max-width:1080px;max-height:calc(100dvh - 32px);overflow:auto;padding:24px}.editor-title{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.editor-title h2{margin:0 0 6px}.editor-title p,.muted{color:var(--muted);font-size:13px}.editor-title button{flex:none}.collection-hint{font-size:13px;background:#e7efea;border-radius:8px;padding:10px 12px}.member-editor-columns{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:24px}.member-editor-columns section{min-width:0}.selected-members,.candidate-members{list-style:none;margin:14px 0;padding:0;max-height:48dvh;overflow:auto;border:1px solid var(--border);border-radius:8px}.selected-members li,.candidate-members li{display:flex;align-items:center;gap:8px;padding:10px;border-bottom:1px solid var(--border)}li:last-child{border-bottom:0}.member-number{color:var(--muted);font-size:12px;width:24px;flex:none}.member-title{flex:1;min-width:0;display:grid;gap:4px}.member-title strong{font-size:13px;overflow-wrap:anywhere}.member-actions{display:flex;gap:4px;flex:none}.member-actions button{min-width:36px;min-height:44px;padding:6px 8px;font-size:12px}.candidate-members button{font-size:13px;padding:8px 10px;flex:none}.candidate-search{display:flex;gap:6px;margin:14px 0}.candidate-search input{min-width:0;flex:1}.candidate-search button{flex:none;margin:0;font-size:13px;padding:8px 10px}.candidate-pagination{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:12px}.candidate-pagination button{font-size:12px;padding:8px}.editor-footer{position:sticky;bottom:-24px;display:flex;gap:8px;align-items:center;justify-content:flex-end;background:var(--surface);border-top:1px solid var(--border);padding:16px 0 4px;margin-top:20px}.editor-footer>span{margin-right:auto;color:var(--muted);font-size:13px}@media(max-width:650px){.collection-members-editor{width:calc(100% - 16px);padding:16px;max-height:calc(100dvh - 16px)}.member-editor-columns{grid-template-columns:minmax(0,1fr);gap:12px}.selected-members{max-height:27dvh}.candidate-members{max-height:24dvh}.editor-footer{bottom:-16px;flex-wrap:wrap}.editor-footer>span{flex:1 1 100%}.editor-title h2{font-size:19px}.member-actions button{padding:6px}.member-title strong{font-size:12px}}
</style>
