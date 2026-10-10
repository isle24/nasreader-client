<script setup lang="ts">
defineProps<{direction:'previous'|'next'}>();
</script>
<template><svg class="reader-page-arrow-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path :d="direction==='previous'?'M15 5 L9 12 L15 19':'M9 5 L15 12 L9 19'" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></template>
<style scoped>.reader-page-arrow-icon{display:block;width:22px;height:22px;flex:none;overflow:visible;pointer-events:none}</style>
