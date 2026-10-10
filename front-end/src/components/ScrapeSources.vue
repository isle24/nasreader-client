<script setup lang="ts">
import {computed} from 'vue';
import {SCRAPE_PROVIDERS,type ScrapeProvider} from '../api/metadata';
const props=defineProps<{modelValue:ScrapeProvider[];disabled?:boolean}>();
const emit=defineEmits<{ 'update:modelValue':[ScrapeProvider[]] }>();
const selected=computed(()=>['embedded',...props.modelValue.filter((p,i,a)=>p!=='embedded'&&a.indexOf(p)===i)] as ScrapeProvider[]);
const available=computed(()=>SCRAPE_PROVIDERS.filter(p=>!selected.value.includes(p.value)));
function toggle(p:ScrapeProvider){emit('update:modelValue',selected.value.includes(p)?selected.value.filter(x=>x!==p):[...selected.value,p])}
function move(i:number,delta:number){const value=[...selected.value];const j=i+delta;if(i<1||j<1||j>=value.length)return;[value[i],value[j]]=[value[j]!,value[i]!];emit('update:modelValue',value)}
function label(p:ScrapeProvider){return SCRAPE_PROVIDERS.find(x=>x.value===p)?.label??p}
</script>
<template>
<fieldset class="scrape-sources" :disabled="disabled"><legend>刮削来源与优先级</legend>
<p class="hint">书内资料优先，之后按顺序尝试；可靠匹配只补齐缺失字段，其他结果进入审核。</p>
<ol><li v-for="(p,i) in selected" :key="p"><label><input type="checkbox" checked :disabled="p==='embedded'" @change="toggle(p)">{{label(p)}}</label><span v-if="i" class="priority"><button type="button" :disabled="i===1" :aria-label="label(p)+' 提高优先级'" @click="move(i,-1)">↑</button><button type="button" :disabled="i===selected.length-1" :aria-label="label(p)+' 降低优先级'" @click="move(i,1)">↓</button></span><small v-else>首先提取</small></li></ol>
<div class="available"><label v-for="p in available" :key="p.value"><input type="checkbox" @change="toggle(p.value)">{{p.label}}</label></div>
</fieldset>
</template>
<style scoped>
.scrape-sources{border:1px solid var(--border);border-radius:12px;padding:12px;min-width:0;margin:8px 0;max-width:650px}.hint{font-size:13px;line-height:1.5;color:var(--muted);margin:0 0 8px}.scrape-sources ol{padding-left:24px;margin:0}.scrape-sources li{padding:4px 0}.scrape-sources label{display:inline-flex;align-items:center;gap:7px;font-size:14px;line-height:24px;margin:0}.scrape-sources input{width:16px;height:16px;padding:0}.priority{display:inline-flex;gap:4px;margin-left:12px}.priority button{padding:0;width:30px;min-height:28px;margin:0;font-size:15px}.available{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px}.scrape-sources small{margin-left:12px;color:var(--muted)}
</style>
