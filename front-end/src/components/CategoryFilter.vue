<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {api} from '../state';
import {categoryOptions,createCategoriesApi,type Category} from '../api/categories';
import type {ContentKind,LibraryRef} from '../api/libraries';
const props=defineProps<{modelValue:string;library?:string|number;kind?:ContentKind;libraries?:LibraryRef[];label?:string;disabled?:boolean}>(),emit=defineEmits<{'update:modelValue':[string]}>();
const items=ref<Category[]>([]),error=ref(''),loading=ref(false),client=createCategoriesApi(api);let generation=0,closed=false;
const options=computed(()=>categoryOptions(items.value,Number(props.library)||undefined,props.kind));
function name(c:Category&{path:string}){const library=props.libraries?.find(lib=>lib.id===c.library_id)?.name;return !props.library&&library?library+' · '+c.path:c.path}
async function load(){const g=++generation;items.value=[];error.value='';if(props.disabled)return;loading.value=true;try{const data=await client.list({library:Number(props.library)||undefined,content_kind:props.kind});if(closed||g!==generation)return;items.value=data.items;if(props.modelValue&&props.modelValue!=='uncategorized'&&!options.value.some(c=>String(c.id)===props.modelValue))emit('update:modelValue','')}catch(e:any){if(!closed&&g===generation)error.value=e.message}finally{if(!closed&&g===generation)loading.value=false}}
watch(()=>[props.library,props.kind,props.disabled],()=>void load(),{immediate:true});onBeforeUnmount(()=>{closed=true;generation++});
</script>
<template><div class="category-filter"><select :value="modelValue" :aria-label="label||'分类筛选'" :disabled="disabled||loading" @change="emit('update:modelValue',($event.target as HTMLSelectElement).value)"><option value="">全部分类</option><option value="uncategorized">未分类</option><option v-for="item in options" :key="item.id" :value="String(item.id)">{{name(item)}}</option></select><span v-if="error" class="category-filter-error" role="alert">分类读取失败 <button type="button" @click="load">重试</button></span></div></template>
<style scoped>.category-filter{min-width:0;max-width:100%}.category-filter select{width:100%;max-width:100%;min-width:0}.category-filter-error{display:block;font-size:12px;color:var(--danger);margin-top:4px}.category-filter-error button{font-size:12px;padding:4px 8px}@media(max-width:650px){.category-filter{flex:1 1 160px}}</style>
