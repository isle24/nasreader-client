<script setup lang="ts">
import {onMounted,ref} from 'vue';import {useRoute} from 'vue-router';import {api,state} from '../state';import {isOffline} from '../api/errors';import {cachedBooks} from '../api/cache';import type {Book} from '../api/client';import Reader from './Reader.vue';import ComicReader from '../components/ComicReader.vue';
const id=Number(useRoute().params.id),book=ref<Book>(),error=ref(''),readerGeneration=ref(0),resumePosition=ref<{locator:string;chapter_idx:number}>();
function reloadContent(position:{locator:string;chapter_idx:number}){resumePosition.value=position;readerGeneration.value++}
async function load(){error.value='';try{book.value=await api.get<Book>('/books/'+id)}catch(e:any){try{if(!isOffline(e))throw e;const snapshot=(await cachedBooks(state.server,state.user!.id)).find(item=>item.book.id===id);if(snapshot)book.value=snapshot.book;else error.value=e.message}catch{error.value=e.message}}}
onMounted(load);
</script>
<template><ComicReader v-if="book?.content_kind==='comic'||book?.format==='cbz'" :book="book!"/><Reader v-else-if="book" :key="readerGeneration" :resume-position="resumePosition" @reload-content="reloadContent"/><main v-else class="page"><p v-if="error" role="alert">{{error}} <button @click="load">重试</button></p><p v-else role="status">正在打开…</p></main></template>
