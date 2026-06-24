<template>
  <PixivConfigNav v-if="isOwn" />
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import type { ComputedRef } from 'vue'
import PixivConfigNav from './components/PixivConfigNav.vue'

const pluginName = inject<ComputedRef<string>>('plugin:name')
const isOwn = computed(() => pluginName?.value === 'koishi-plugin-pixiv-parse')
</script>
