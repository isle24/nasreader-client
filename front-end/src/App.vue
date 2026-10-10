<script setup lang="ts">
import {onMounted,onUnmounted,ref,watch,computed} from 'vue';import {useRoute,useRouter} from 'vue-router';
import {state,connect,syncQueue,refreshAccess,api} from './state';import {mayReadWithLease,licenseDate,type LicenseStatus} from './licensing';
const route=useRoute(),router=useRouter();const code=ref(''),busy=ref(false),licenseError=ref(''),clock=ref(Date.now());
let timer:number|undefined,refreshTimer:number|undefined;const usable=computed(()=>mayReadWithLease(state.license,clock.value));
const label=computed(()=>{const stateName=state.license?.state;if(!stateName)return '尚未取得授权状态';return ({checking:'正在等待联网校验',unactivated:'此 NAS 尚未激活',active:'授权有效',network_grace:'授权服务器暂不可达',expired:'授权已到期',revoked:'授权已被禁用',device_replaced:'此设备的授权已被解除',conflict:'检测到重复运行',clock_error:'NAS 系统时间异常'} as Record<string,string>)[stateName]??'授权暂不可用'});
async function refreshLicense(){if(!state.user||!state.server)return;try{state.license=await api.get<LicenseStatus>('/license/status');licenseError.value=''}catch(e:any){if(!state.license||navigator.onLine)licenseError.value='读取授权状态失败：'+e.message}}
async function activate(){if(!code.value.trim())return;busy.value=true;licenseError.value='';try{state.license=await api.post<LicenseStatus>('/license/activate',{code:code.value.trim()});code.value='';await syncQueue()}catch(e:any){licenseError.value=e.message}finally{busy.value=false}}
watch(()=>state.user?.id,()=>{if(state.user)void refreshLicense();else state.license=null});
watch(()=>state.offline,(offline)=>{if(!offline&&state.user)void refreshLicense()});
async function checkAccess(){
 if(document.visibilityState!=='visible'||!state.user)return;
 const id=route.path.startsWith('/read/')?Number(route.params.id):0;
 try{const me=await api.get<any>('/me');if(state.user)state.user={...state.user,username:me.username??state.user.username,role:me.role??state.user.role};const denied=await refreshAccess(id?[id]:[]);if(id&&denied.includes(id)){state.syncMessage='当前图书的访问权限已变更';await router.replace('/')}}catch{if(!api.session&&state.user){state.user=null;await router.replace('/login')}}
}
function visibleAccess(){if(document.visibilityState==='visible')void checkAccess()}
onMounted(async()=>{
 window.addEventListener('focus',visibleAccess);window.addEventListener('online',visibleAccess);document.addEventListener('visibilitychange',visibleAccess);
 timer=window.setInterval(()=>{clock.value=Date.now()},1000);
 refreshTimer=window.setInterval(()=>{if(navigator.onLine&&state.user)void refreshLicense()},5*60_000);
 if(!state.server){state.ready=true;await router.replace('/login');return}
 try{await connect(state.server,state.serverManual);if(!state.user&&route.path!='/login')await router.replace('/login');else{await refreshLicense();if(usable.value){await checkAccess();void syncQueue()}}}
 catch(e:any){state.error='连接服务器失败：'+e.message;state.ready=true;await router.replace('/login')}
});onUnmounted(()=>{window.removeEventListener('focus',visibleAccess);window.removeEventListener('online',visibleAccess);document.removeEventListener('visibilitychange',visibleAccess);if(timer!==undefined)clearInterval(timer);if(refreshTimer!==undefined)clearInterval(refreshTimer)});
</script>
<template>
 <div v-if="!state.ready" class="loading">正在打开书房…</div>
 <template v-else>
  <header v-if="!route.path.startsWith('/read/')" class="app-header"><RouterLink to="/" class="brand"><img src="/brand-icon.svg" class="brand-symbol" alt="" width="42" height="42"><span class="brand-word">nasReader</span><span>家庭书房</span></RouterLink><nav v-if="state.user" aria-label="主导航"><RouterLink to="/">书库</RouterLink><RouterLink to="/comics">漫画</RouterLink><RouterLink to="/shelves">书架</RouterLink><RouterLink to="/search">搜索</RouterLink><RouterLink v-if="state.user.role==='admin'" to="/manage">管理</RouterLink><RouterLink to="/settings">我的</RouterLink></nav></header>
  <p v-if="state.offline" class="status-banner">离线模式 · 可打开已下载的书籍，修改将在联网后同步</p><p v-if="state.syncMessage" role="status" class="status-banner">{{state.syncMessage}}</p>
  <section v-if="state.user&&route.path!='/login'&&!usable" class="license-screen" role="status"><div class="license-card"><p class="license-kicker">NASREADER 授权</p><h1>{{label}}</h1><p v-if="state.license?.license_expires_at_ms">授权到期：{{licenseDate(state.license.license_expires_at_ms)}}</p><p v-if="state.license?.lease_until_ms">本次最晚可用：{{licenseDate(state.license.lease_until_ms)}}</p><p v-if="state.license?.instance_id" class="license-id">设备码：<code>{{state.license.instance_id}}</code></p><p v-if="state.license?.max_devices" class="license-hint">本授权最多可绑定 {{state.license.max_devices}} 台设备。</p><p class="license-hint">请连接 NAS 和激活服务器进行校验。书籍、阅读进度和笔记会保留。</p><p v-if="state.license?.last_error==='stale_challenge'" class="license-error">NAS 系统时间与授权中心相差超过 2 分钟，请先同步系统时间；修改时区不能代替校时。</p><p v-else-if="state.license?.last_error==='device_replaced'" class="license-hint">设备已被替换或解绑。使用原激活码可重新激活当前设备，满额时会替换最早激活的设备。</p><p v-else-if="state.license?.last_error" class="license-hint">校验原因：{{state.license.last_error}}</p><form v-if="state.user.role==='admin'" @submit.prevent="activate"><label>激活码<input v-model="code" autocomplete="off" placeholder="AC-XXXX-XXXX-XXXX-XXXX"></label><button :disabled="busy||!code.trim()">{{busy?'校验中…':'激活或续期'}}</button></form><button class="license-retry" @click="refreshLicense">重新检查授权</button><p v-if="licenseError" role="alert" class="license-error">{{licenseError}}</p></div></section>
  <template v-else><p v-if="state.license?.state==='network_grace'" class="status-banner">授权服务器暂不可达；授权可用至 {{licenseDate(state.license.lease_until_ms)}}</p><RouterView :key="route.path" /></template>
 </template>
</template>
<style scoped>
@media(max-width:650px){.app-header nav a{padding:10px 8px}}
.license-screen{min-height:calc(100vh - 120px);display:grid;place-items:center;padding:24px;background:#f4f7f3}.license-card{width:min(100%,520px);background:white;padding:32px;border:1px solid #d8e6da;border-radius:18px;box-shadow:0 16px 40px #213a2514}.license-kicker{font-size:12px;letter-spacing:.15em;color:#56916d;font-weight:700}.license-card h1{font-size:27px;margin:8px 0 22px}.license-card p{color:#536458}.license-card form{display:grid;gap:12px;margin-top:24px}.license-card label{display:grid;gap:8px;font-size:14px}.license-card input{width:100%;padding:11px;border:1px solid #bdcfbf;border-radius:8px}.license-card form button,.license-retry{border:0;background:#256947;color:white;padding:11px 15px;border-radius:8px;cursor:pointer}.license-retry{background:#e6efe7;color:#265839;margin-top:14px}.license-id{overflow-wrap:anywhere}.license-hint{font-size:14px;line-height:1.7}.license-error{color:#a33c33!important}
</style>
