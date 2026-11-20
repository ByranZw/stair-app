<script setup lang="ts">
defineProps<{ name: string; tone?: 'muted' | 'white' }>()
</script>
<template>
  <image
    class="icon"
    :src="`/static/icons/${name}${tone ? '-' + tone : ''}.svg`"
    mode="aspectFit"
  />
</template>
