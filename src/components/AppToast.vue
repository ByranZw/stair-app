<script setup lang="ts">
import { toastMessage } from '../state/feedback'
</script>
<template>
  <view v-if="toastMessage" class="toast" role="status" aria-live="polite">{{ toastMessage }}</view>
</template>
