<script setup lang="ts">
import {computed} from 'vue';
import {categoryOptions,type Category} from '../api/categories';
import type {ContentKind} from '../api/libraries';
const props=defineProps<{modelValue:number[];items:Category[];library:number;kind:ContentKind;disabled?:boolean}>(),emit=defineEmits<{ 'update:modelValue':[number[]] }>();
const options=computed(()=>categoryOptions(props.items,props.library,props.kind));
function choose(id:number,checked:boolean){if(props.disabled)return;const ids=props.modelValue.filter(value=>value!==id);if(checked&&ids.length<20)ids.push(id);emit('update:modelValue',ids)}
</script>
<template><fieldset class="category-picker" :disabled="disabled"><legend>选择分类（可多选，最多 20 个）</legend><p v-if="!options.length" class="muted">本库还没有分类，请先在分类页创建。</p><label v-for="item in options" :key="item.id" :style="{'--depth':item.depth}" class="category-option"><input type="checkbox" :aria-label="item.name" :checked="modelValue.includes(item.id)" :disabled="!modelValue.includes(item.id)&&modelValue.length>=20" @change="choose(item.id,($event.target as HTMLInputElement).checked)"><span>{{item.path}}</span></label></fieldset></template>
<style scoped>.category-picker{border:1px solid var(--border);border-radius:8px;padding:12px;margin:16px 0;max-height:300px;overflow:auto;min-width:0}.category-picker legend{font-size:13px;padding:0 4px}.category-option{display:flex;align-items:center;gap:10px;margin:0;padding:10px 4px 10px calc(4px + var(--depth)*10px);min-height:44px;font-weight:400;font-size:14px}.category-option input{width:18px;height:18px;flex:none;margin:0}.category-option span{overflow-wrap:anywhere}.muted{font-size:13px;color:var(--muted)}</style>
