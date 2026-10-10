<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {api,state} from '../state';
import {createCategoriesApi,categoryOptions,type Category,type BookCategories,type CategoryMode} from '../api/categories';
import {createCollectionsApi,type Collection} from '../api/collections';
import type {Book} from '../api/client';
import {errorMessage} from '../api/errors';
import CategoryPicker from './CategoryPicker.vue';
const props=defineProps<{book?:Book;collection?:Collection}>(),emit=defineEmits<{saved:[]}>();
const client=createCategoriesApi(api),snapshot=ref<BookCategories|null>(null),collectionSnapshot=ref<Collection|null>(null),categories=ref<Category[]>([]),ids=ref<number[]>([]),mode=ref<CategoryMode>('add'),loading=ref(true),saving=ref(false),error=ref(''),conflict=ref(false),message=ref('');let closed=false,generation=0;
const library=computed(()=>snapshot.value?.library_id??collectionSnapshot.value?.library_id??0),kind=computed(()=>snapshot.value?.content_kind??collectionSnapshot.value?.content_kind??'book'),canManage=computed(()=>!state.offline&&(snapshot.value?.can_manage??collectionSnapshot.value?.can_manage)===true);
const labels=computed(()=>categoryOptions(categories.value,library.value,kind.value).filter(c=>snapshot.value?.items.some(item=>item.id===c.id)));
async function init(){const g=++generation;loading.value=true;error.value='';snapshot.value=null;collectionSnapshot.value=null;categories.value=[];conflict.value=false;ids.value=[];
 try{
  const row=props.book?await client.book(props.book.id):props.collection?await createCollectionsApi(api).detail(props.collection.id):null;if(!row||closed||g!==generation)return;
  const list=await client.list({library:row.library_id,content_kind:row.content_kind});if(closed||g!==generation)return;
  categories.value=list.items;if(props.book){snapshot.value=row as BookCategories;ids.value=(row as BookCategories).items.filter(c=>!c.deleted).map(c=>c.id)}else collectionSnapshot.value=row as Collection;
 }catch(e){if(!closed&&g===generation)error.value=errorMessage(e)}finally{if(!closed&&g===generation)loading.value=false}
}
async function save(){if(!canManage.value||saving.value||conflict.value)return;const current=snapshot.value,collection=collectionSnapshot.value,g=generation;saving.value=true;error.value='';message.value='';
 try{
  if(current&&props.book){const result=await client.assignBook(props.book.id,[...ids.value],current.revision);if(closed||g!==generation)return;snapshot.value=result;message.value='分类选择已保存'}
  else if(collection){await client.assignCollection({library_id:collection.library_id,collection_id:collection.id,collection_revision:collection.revision,category_ids:[...ids.value],mode:mode.value});if(closed||g!==generation)return;message.value='集合成员分类已更新'}
  emit('saved');
 }catch(e:any){if(!closed&&g===generation){error.value=errorMessage(e);if([403,404,409].includes(e?.status))conflict.value=true}}finally{if(!closed&&g===generation)saving.value=false}
}
// Focus checks permission without replacing an authorized editor's draft or revision.
async function recheck(){if(loading.value||saving.value||closed)return;const current=snapshot.value,collection=collectionSnapshot.value,g=generation;
 try{const row=props.book?await client.book(props.book.id):collection?await createCollectionsApi(api).detail(collection.id):null;if(!row||closed||g!==generation)return;if(!row.can_manage||row.library_id!==library.value||row.content_kind!==kind.value||('deleted'in row&&row.deleted)){conflict.value=true;error.value='内容归属或管理权限已变更，当前选择未保存'}if(current)current.can_manage=row.can_manage;if(collection)collection.can_manage=row.can_manage}
 catch(e:any){if(!closed&&g===generation&&[403,404].includes(e?.status)){conflict.value=true;error.value=errorMessage(e);if(current)current.can_manage=false;if(collection)collection.can_manage=false}}
}
function focus(){if(document.visibilityState==='visible')void recheck()}
watch(()=>[props.book?.id,props.collection?.id],()=>void init());watch(()=>state.accessEpoch,()=>void recheck());
onMounted(()=>{void init();window.addEventListener('focus',focus)});onBeforeUnmount(()=>{closed=true;generation++;window.removeEventListener('focus',focus)});
</script>
<template><section class="category-assignment" aria-label="内容分类"><h3 v-if="book">分类</h3><p v-if="loading" role="status">正在读取分类…</p><p v-if="error" role="alert" class="error">{{error}}</p><p v-if="conflict" class="draft-notice">当前选择已保留，尚未保存。请关闭后重新打开，核对最新分类与权限。</p><p v-if="message" role="status">{{message}}</p><template v-if="!loading&&(snapshot||collectionSnapshot)"><template v-if="canManage"><p v-if="collectionSnapshot" class="muted">将应用到「{{collectionSnapshot.name}}」的 {{collectionSnapshot.book_count}} 个成员，集合成员和阅读顺序保留。</p><CategoryPicker v-model="ids" :items="categories" :library="library" :kind="kind" :disabled="saving||conflict"/><label v-if="collectionSnapshot">赋值方式<select v-model="mode" :disabled="saving||conflict"><option value="add">追加所选分类</option><option value="replace">替换成员现有分类</option></select></label><p class="muted">保存记作人工分类，AI 后续不会覆盖。清空选择也会保留人工锁定。</p><button class="primary" :disabled="saving||conflict||(collectionSnapshot?.book_count??0)>5000" @click="save">{{saving?'正在保存…':collectionSnapshot?'应用到集合成员':'保存分类选择'}}</button><p v-if="(collectionSnapshot?.book_count??0)>5000" class="error">此集合超过 5000 个成员，无法批量设置分类。</p></template><template v-else-if="snapshot"><ul v-if="labels.length" class="category-labels"><li v-for="item in labels" :key="item.id">{{item.path}}</li></ul><p v-else class="muted">未分类</p></template><RouterLink :to="{path:'/categories',query:{library:String(library),content_kind:kind}}" class="category-link">查看本库分类</RouterLink></template></section></template>
<style scoped>.category-assignment{margin:24px 0;border-top:1px solid var(--border);padding-top:12px;min-width:0}.category-assignment h3{margin:8px 0}.muted,.draft-notice{font-size:13px;color:var(--muted);line-height:1.7}.category-labels{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0}.category-labels li{border-radius:6px;background:#e7efea;padding:6px 10px;font-size:13px;overflow-wrap:anywhere}.category-link{display:block;font-size:13px;color:var(--accent);margin-top:14px}.category-assignment select{max-width:100%}</style>
