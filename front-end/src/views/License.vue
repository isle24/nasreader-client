<script setup lang="ts">
import {onMounted,ref} from 'vue';
import {api,state} from '../state';
import {licenseDate,type LicenseStatus} from '../licensing';
import {errorMessage} from '../api/errors';
const busy=ref(false),error=ref(''),notice=ref(''),code=ref('');
async function refresh(){busy.value=true;error.value='';try{state.license=await api.get<LicenseStatus>('/license/status')}catch(e){error.value=errorMessage(e)}finally{busy.value=false}}
async function renew(){if(!code.value.trim())return;busy.value=true;error.value='';notice.value='';try{state.license=await api.post<LicenseStatus>('/license/activate',{code:code.value.trim()});code.value='';notice.value='激活码已兑换，授权期限已更新'}catch(e){error.value=errorMessage(e)}finally{busy.value=false}}
onMounted(()=>{if(state.user?.role==='admin')void refresh()});
</script>
<template><main class="page"><div class="page-title"><div><h1>授权与续期</h1><p>按 NAS 实例授权；时间按北京时间显示。</p></div><RouterLink to="/manage">返回管理</RouterLink></div>
<p v-if="state.user?.role!=='admin'" class="error" role="alert">仅管理员可管理授权。</p>
<section v-else class="panel license-panel"><h2>当前授权</h2><p><strong>状态：</strong>{{state.license?.state||'读取中'}}</p><p><strong>实例 ID：</strong><code>{{state.license?.instance_id||'—'}}</code></p><p><strong>到期：</strong>{{state.license?.license_expires_at_ms?licenseDate(state.license.license_expires_at_ms):state.license?'永久':'—'}}</p><p v-if="state.license?.lease_until_ms"><strong>本次可用至：</strong>{{licenseDate(state.license.lease_until_ms)}}</p><button type="button" :disabled="busy" @click="refresh">刷新状态</button><form @submit.prevent="renew"><label>兑换新激活码续期<input v-model="code" autocomplete="off" placeholder="NR-XXXX-XXXX-XXXX-XXXX" required></label><button :disabled="busy||!code.trim()">{{busy?'校验中…':'兑换并续期'}}</button></form><p v-if="notice" role="status">{{notice}}</p><p v-if="error" class="error" role="alert">{{error}}</p></section>
</main></template>
<style scoped>.license-panel{max-width:650px}.license-panel p{line-height:1.65}.license-panel code{overflow-wrap:anywhere}.license-panel form{display:flex;gap:12px;align-items:end;margin-top:28px}.license-panel label{display:grid;gap:8px;flex:1;min-width:0}.license-panel input{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px}@media(max-width:600px){.license-panel form{display:grid}}</style>
