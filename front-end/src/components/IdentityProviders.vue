<script setup lang="ts">
import {computed} from 'vue';
import {IDENTITY_PROVIDERS, identityProviderLabel, type IdentityProvider} from '../api/identity';
const props = defineProps<{modelValue: IdentityProvider[]; disabled?: boolean}>();
const emit = defineEmits<{'update:modelValue': [IdentityProvider[]]}>();
const available = computed(() => IDENTITY_PROVIDERS.filter(item => !props.modelValue.includes(item.value)));
function toggle(provider: IdentityProvider) {
  if (props.modelValue.length === 1 && props.modelValue.includes(provider)) return;
  emit('update:modelValue', props.modelValue.includes(provider) ? props.modelValue.filter(item => item !== provider) : [...props.modelValue, provider]);
}
function move(index: number, delta: number) {
  const providers = [...props.modelValue], next = index + delta;
  if (next < 0 || next >= providers.length) return;
  [providers[index], providers[next]] = [providers[next]!, providers[index]!];
  emit('update:modelValue', providers);
}
</script>
<template><fieldset class="identity-providers" :disabled="disabled"><legend>后续目录来源与顺序</legend>
<p class="muted">先按正文识别整书名，再依次查询所选来源；可靠简介或封面匹配后停止。至少保留一个来源；查询失败仍可审核内容识别。</p>
<ol><li v-for="(provider,index) in modelValue" :key="provider"><label><input type="checkbox" checked :disabled="modelValue.length===1" @change="toggle(provider)">{{identityProviderLabel(provider)}}</label><span><button type="button" :disabled="index===0" :aria-label="identityProviderLabel(provider)+' 提高优先级'" @click="move(index,-1)">↑</button><button type="button" :disabled="index===modelValue.length-1" :aria-label="identityProviderLabel(provider)+' 降低优先级'" @click="move(index,1)">↓</button></span></li></ol>
<div class="available"><label v-for="item in available" :key="item.value"><input type="checkbox" @change="toggle(item.value)">{{item.label}}</label></div>
</fieldset></template>
<style scoped>
.identity-providers{border:1px solid var(--border);border-radius:12px;padding:12px;min-width:0;margin:14px 0}.identity-providers p{font-size:13px;line-height:1.6;margin:0 0 8px}.identity-providers ol{padding-left:24px;margin:0}.identity-providers li{padding:4px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.identity-providers label{display:inline-flex;align-items:center;gap:7px;font-size:14px;margin:0}.identity-providers input{width:16px;height:16px;padding:0}.identity-providers li span{display:inline-flex;gap:4px}.identity-providers button{padding:0;width:32px;min-height:30px;margin:0}.available{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:8px}
</style>
