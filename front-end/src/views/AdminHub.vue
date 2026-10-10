<script setup lang="ts">
// Administrator hub. The bottom navigation keeps the same five entries for
// everyone (书库/书架/搜索/我的 plus 管理 for admins); the four admin pages live
// here instead of crowding the tab bar, which at 375px squeezed labels onto two
// lines and shrank the font to fit eight entries.
import {useRouter} from 'vue-router';
import {state} from '../state';
const router=useRouter();
const entries=[
  {to:'/admin/license',title:'授权与续期',detail:'查看 NAS 实例授权、到期时间，兑换新的激活码'},
  {to:'/admin/users',title:'用户管理',detail:'分页搜索、创建、停用、恢复和用户库授权'},
  {to:'/admin/libraries',title:'书库管理',detail:'个人与共享书库、授权、归档和恢复'},
  {to:'/import',title:'导入与书库',detail:'上传图书、挂载 NAS 目录、扫描与导入任务、外部书源连接'},
  {to:'/admin/books',title:'书籍管理',detail:'按源文件缺失/重复/无封面等筛选，批量改元数据、封面、书库，删除记录'},
  {to:'/discover',title:'在线书源',detail:'一次搜索所有已配置的 SoNovel / reader 书源，批量下载并入库'},
  {to:'/admin/identify',title:'按内容识别并刮削',detail:'从有限正文辨识整书名，保留分篇与序号，查询目录后批量审核资料'},
  {to:'/admin/metadata',title:'元数据刮削',detail:'离线刮削、整库排队补全、AI 辅助（OpenAI / Claude）与手动编辑'},
  {to:'/admin/sources',title:'外部书源',detail:'配置 NAS 上的 SoNovel 与 reader 连接、测试连通性'},
  {to:'/admin/speech',title:'朗读设置',detail:'服务器音色、模型与听书服务'},
  {to:'/settings',title:'我的书房',detail:'自己的账户安全、电子书设备与离线数据'},
];
</script>
<template><main class="page"><div class="page-title"><div><h1>管理</h1><p v-if="state.user">{{state.user.username}} · {{state.user.role==='admin'?'管理员':'家庭成员'}}</p></div><button @click="router.push('/')">返回书库</button></div>
<p v-if="state.user?.role!=='admin'" class="error" role="alert">只有管理员可以进入这些页面。</p>
<div v-else class="hub"><RouterLink v-for="item in entries" :key="item.to" class="hub-card" :to="item.to"><h2>{{item.title}}</h2><p>{{item.detail}}</p></RouterLink></div>
</main></template>
<style scoped>
.hub{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.hub-card{display:block;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-card,10px);padding:20px;box-shadow:0 1px 2px #101a1410;transition:box-shadow 120ms ease-out,border-color 120ms ease-out,transform 120ms ease-out}
.hub-card h2{font-size:17px;margin:0 0 8px}
.hub-card p{margin:0;font-size:13px;line-height:1.6;color:var(--muted)}
@media(prefers-hover:hover){.hub-card:hover{border-color:#c9d4cd;box-shadow:0 8px 20px -12px #0d1a1440;transform:translateY(-2px)}}
@media(max-width:420px){.hub{grid-template-columns:1fr}.hub-card{padding:16px}}
</style>
