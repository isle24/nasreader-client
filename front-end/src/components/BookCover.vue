<script setup lang="ts">
// 3:4 bookshelf cover: the authenticated /books/:id/cover blob when the server says
// the book has one (`has_cover`), and the typographic fallback otherwise (404 cover).
import {computed} from 'vue';
import AuthenticatedImage from './AuthenticatedImage.vue';
import type {Book} from '../api/client';
const props=withDefaults(defineProps<{book:Book;eager?:boolean}>(),{eager:false});
const hue=computed(()=>String((props.book.id*43)%360));
const coverPath=computed(()=>`/books/${props.book.id}/cover?v=${props.book.updated_at??0}`);
const typographic=computed(()=>props.book.has_cover===false);
</script>
<template><div class="book-cover" :style="{'--cover-hue':hue}">
<AuthenticatedImage v-if="!typographic" :path="coverPath" :eager="eager" :alt="`${book.title} 封面`">
<template #placeholder>
<span class="cover-format">{{book.format.toUpperCase()}}</span>
<strong>{{book.title}}</strong>
<span>{{book.author||'佚名'}}</span>
</template>
</AuthenticatedImage>
<template v-else>
<span class="cover-format">{{book.format.toUpperCase()}}</span>
<strong>{{book.title}}</strong>
<span>{{book.author||'佚名'}}</span>
</template>
</div></template>
