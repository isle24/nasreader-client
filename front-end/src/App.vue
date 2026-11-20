<script setup lang="ts">
import {onMounted,onUnmounted} from 'vue';import {useRoute,useRouter} from 'vue-router';
import {state,connect,syncQueue,refreshAccess,api} from './state';
const route=useRoute(),router=useRouter();
async function checkAccess(){
 if(document.visibilityState!=='visible'||!state.user)return;
 const id=route.path.startsWith('/read/')?Number(route.params.id):0;
 try{const me=await api.get<any>('/me');if(state.user)state.user={...state.user,username:me.username??state.user.username,role:me.role??state.user.role};const denied=await refreshAccess(id?[id]:[]);if(id&&denied.includes(id)){state.syncMessage='当前图书的访问权限已变更';await router.replace('/')}}catch{if(!api.session&&state.user){state.user=null;await router.replace('/login')}}
}
function visibleAccess(){if(document.visibilityState==='visible')void checkAccess()}
onMounted(async()=>{
 window.addEventListener('focus',visibleAccess);window.addEventListener('online',visibleAccess);document.addEventListener('visibilitychange',visibleAccess);
 if(!state.server){state.ready=true;await router.replace('/login');return}
 try{await connect(state.server,state.serverManual);if(!state.user&&route.path!='/login')await router.replace('/login');else{await checkAccess();void syncQueue()}}
 catch(e:any){state.error='连接服务器失败：'+e.message;state.ready=true;await router.replace('/login')}
});onUnmounted(()=>{window.removeEventListener('focus',visibleAccess);window.removeEventListener('online',visibleAccess);document.removeEventListener('visibilitychange',visibleAccess)});
</script>
<template>
 <div v-if="!state.ready" class="loading">正在打开书房…</div>
 <template v-else>
  <header v-if="!route.path.startsWith('/read/')" class="app-header"><RouterLink to="/" class="brand"><img src="/brand-icon.svg" class="brand-symbol" alt="" width="42" height="42"><span class="brand-word">nasReader</span><span>家庭书房</span></RouterLink><nav v-if="state.user" aria-label="主导航"><RouterLink to="/">书库</RouterLink><RouterLink to="/comics">漫画</RouterLink><RouterLink to="/shelves">书架</RouterLink><RouterLink to="/search">搜索</RouterLink><RouterLink v-if="state.user.role==='admin'" to="/manage">管理</RouterLink><RouterLink to="/settings">我的</RouterLink></nav></header>
  <p v-if="state.offline" class="status-banner">离线模式 · 可打开已下载的书籍，修改将在联网后同步</p><p v-if="state.syncMessage" role="status" class="status-banner">{{state.syncMessage}}</p>
  <RouterView :key="route.path" />
 </template>
</template>
<style scoped>
@media(max-width:650px){.app-header nav a{padding:10px 8px}}
</style>
