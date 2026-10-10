<script setup lang="ts">
import {computed,ref,nextTick,onMounted,watch} from 'vue';
import type {Book,Chapter} from '../api/client';
import BookCover from './BookCover.vue';
const props=defineProps<{book:Book|null;chapters:Chapter[];documentToc:any[];activeIndex:number;positionText:string;percent:number;tab:'toc'|'notes';noteCount:number}>();
const emit=defineEmits<{select:[{index:number;locator?:string}];tab:['toc'|'notes']}>();
const list=ref<HTMLElement|null>(null),reversed=ref(false);
function flatten(items:any[],level=0):{index:number;title:string;locator:string;level:number}[]{
 const out:{index:number;title:string;locator:string;level:number}[]=[];
 for(const item of items){out.push({index:out.length,title:item.label??item.title??'章节',locator:item.locator??item.href??'',level});if(item.subitems?.length||item.children?.length){for(const row of flatten(item.subitems??item.children,level+1))out.push({...row,index:out.length})}}
 return out;
}
const rows=computed(()=>props.chapters.length?props.chapters.map(c=>({index:c.idx,title:c.title,locator:'',level:0})):flatten(props.documentToc));
const visibleRows=computed(()=>reversed.value?[...rows.value].reverse():rows.value);
async function locate(){await nextTick();list.value?.querySelector('[aria-current="location"]')?.scrollIntoView({block:'center',behavior:'auto'})}
watch(()=>[props.tab,props.activeIndex],()=>{if(props.tab==='toc')void locate()});onMounted(locate);
</script>
<template>
<header class="catalog-book"><div v-if="book" class="catalog-cover"><BookCover :book="book"/></div><div><h2>{{book?.title??'这本书'}}</h2><p v-if="book?.author">{{book.author}}</p></div></header>
<div class="catalog-tabs" role="tablist" aria-label="阅读记录">
<button role="tab" :aria-selected="tab==='toc'" :class="{selected:tab==='toc'}" @click="emit('tab','toc')">目录</button>
<button role="tab" :aria-selected="tab==='notes'" :class="{selected:tab==='notes'}" @click="emit('tab','notes')">笔记<span v-if="noteCount"> {{noteCount}}</span></button>
</div>
<template v-if="tab==='toc'">
<div class="catalog-summary"><span>共 {{rows.length}} {{book?.format==='pdf'?'页':'章'}}</span><div><button class="locate-current" @click="locate">定位当前</button><button class="chapter-order" @click="reversed=!reversed" :aria-label="reversed?'切换正序':'切换倒序'">{{reversed?'倒序':'正序'}} <span aria-hidden="true">⌄</span></button></div></div>
<div ref="list" class="catalog-list" role="list" aria-label="章节列表">
<div v-for="row in visibleRows" :key="row.index+'-'+row.locator" class="catalog-entry" role="listitem">
<button class="catalog-chapter" :class="{current:row.index===activeIndex,group:row.level>0}" :style="{paddingLeft:row.level*14+'px'}" :aria-current="row.index===activeIndex?'location':undefined" @click="emit('select',{index:row.index,locator:row.locator||undefined})"><span>{{row.title}}</span><small>{{row.index+1}}</small></button>
<div v-if="row.index===activeIndex" class="catalog-reading"><svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M3 5q5-2 9 1q4-3 9-1v14q-5-2-9 1q-4-3-9-1zM12 6v14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg><span>当前读到</span><small>{{positionText}}</small></div>
</div>
<p v-if="!rows.length" class="catalog-empty">正在读取目录…</p>
</div>
</template>
</template>
<style scoped>
.catalog-book{display:flex;align-items:center;gap:17px;padding:30px 4px 20px;min-height:118px}.catalog-cover{width:49px;flex:none}.catalog-cover :deep(.book-cover){padding:5px;border-left-width:2px;border-radius:3px}.catalog-cover :deep(.book-cover strong){font-size:10px}.catalog-cover :deep(.book-cover span){font-size:7px}.catalog-book h2{font:650 18px/1.5 system-ui;margin:0;padding:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.catalog-book p{font:13px/1.5 system-ui;color:var(--muted);margin:5px 0 0}.catalog-tabs{display:flex;padding:3px;border-radius:999px;background:color-mix(in srgb,currentColor 11%,transparent);min-height:43px;flex:none}.catalog-tabs button{flex:1;border:0;border-radius:999px;background:none;min-height:38px;margin:0;padding:7px 12px;font-size:16px;color:var(--muted)}.catalog-tabs button.selected{background:var(--catalog-selected,#fffdf7);color:inherit;font-weight:650;box-shadow:0 0 0 1px #00000008}.catalog-tabs span{font-size:12px}.catalog-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 1px 13px;font:13px/1.4 system-ui;color:var(--muted);flex:none}.catalog-summary>div{display:flex;gap:3px}.catalog-summary button{font-size:12px;border:0;min-height:36px;border-radius:999px;padding:7px 10px;margin:0}.locate-current{background:transparent;color:var(--muted)}.chapter-order{background:color-mix(in srgb,currentColor 5%,transparent);color:inherit}.catalog-list{overflow-y:auto;overscroll-behavior:contain;min-height:80px;flex:1;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,currentColor 25%,transparent) transparent}.catalog-entry{border-bottom:1px solid color-mix(in srgb,currentColor 11%,transparent)}.catalog-chapter{display:flex;justify-content:space-between;align-items:center;gap:14px;width:100%;text-align:left;border:0;border-radius:0;background:transparent;color:inherit;min-height:58px;padding:13px 3px;margin:0!important;box-shadow:none;font:15px/1.65 system-ui}.catalog-chapter span{min-width:0}.catalog-chapter small{flex:none;color:var(--muted);font:12px/1.4 system-ui;font-variant-numeric:tabular-nums}.catalog-chapter.current{font-weight:650}.catalog-reading{display:flex;gap:8px;align-items:center;padding:12px 3px 15px 15px;color:var(--catalog-accent,#b68c2d);font:14px/1.5 system-ui}.catalog-reading small{margin-left:auto;color:inherit;font:12px/1.5 system-ui;font-variant-numeric:tabular-nums}.catalog-empty{padding:35px 5px;text-align:center;color:var(--muted)}
@media(min-width:700px){.catalog-book{padding-top:30px}.catalog-chapter{font-size:16px;min-height:62px}.catalog-cover{width:55px}}
</style>
