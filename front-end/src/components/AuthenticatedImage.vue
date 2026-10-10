<script setup lang="ts">
// Lazy authenticated image (book covers). The endpoint requires a Bearer token, so
// the bytes are fetched through ApiClient and exposed as an object URL. Every URL is
// revoked when the path changes or the component unmounts; nothing is cached in the
// DOM and no service worker is involved.
//
// The book list may omit `has_cover`, in which case every cover of a cover-less
// library answers 404. Those misses are remembered for a few minutes so a 40-book
// shelf does not issue 40 useless requests, while a cover added later still appears
// within the same session.
import {ref,watch,onMounted,onBeforeUnmount} from 'vue';import {api} from '../state';import {errorMessage} from '../api/errors';
const MISS_TTL_MS=5*60*1000;
const missing=new Map<string,number>();
const props=withDefaults(defineProps<{path:string;alt?:string;eager?:boolean}>(),{alt:'',eager:false});
const emit=defineEmits<{loaded:[number];error:[string]}>();
const root=ref<HTMLElement|null>(null),src=ref(''),phase=ref<'idle'|'loading'|'ready'|'error'>('idle'),message=ref('');
let observer:IntersectionObserver|undefined,closed=false,generation=0;
function release(){if(src.value){URL.revokeObjectURL(src.value);src.value=''}}
async function load(){
  if(closed||phase.value==='loading'||phase.value==='ready')return;
  const until=missing.get(props.path);
  if(until&&until>Date.now()){phase.value='error';message.value='这本图书没有封面';emit('error',message.value);return}
  const g=++generation;phase.value='loading';message.value='';
  try{
    const blob=await api.blob(props.path);
    if(closed||g!==generation)return;
    release();src.value=URL.createObjectURL(blob);phase.value='ready';emit('loaded',blob.size);
  }catch(e:any){
    if(closed||g!==generation)return;
    if(e?.status===404)missing.set(props.path,Date.now()+MISS_TTL_MS);
    phase.value='error';message.value=errorMessage(e,'图片暂不可用');emit('error',message.value);
  }
}
function observe(){if(props.eager||typeof IntersectionObserver==='undefined'){void load();return}observer=new IntersectionObserver(entries=>{if(!entries.some(x=>x.isIntersecting))return;observer?.disconnect();observer=undefined;void load()});if(root.value)observer.observe(root.value)}
function retry(){release();missing.delete(props.path);phase.value='idle';void load()}
watch(()=>props.path,()=>{generation++;release();phase.value='idle';message.value='';void load()});
onMounted(observe);
onBeforeUnmount(()=>{closed=true;generation++;observer?.disconnect();release()});
defineExpose({retry,load});
</script>
<template><div ref="root" class="auth-image" :data-phase="phase"><img v-if="src" :src="src" :alt="alt" :loading="eager?'eager':'lazy'" decoding="async"><slot v-else-if="phase==='error'" name="fallback" :message="message" :retry="retry"><slot name="placeholder"></slot></slot><slot v-else name="placeholder"></slot></div></template>
