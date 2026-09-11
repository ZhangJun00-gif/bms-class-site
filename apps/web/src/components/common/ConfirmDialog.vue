<script setup lang="ts">
import BaseDialog from './BaseDialog.vue';
import { useConfirm } from '../../composables/useConfirm';

const { state, settle } = useConfirm();
</script>

<template>
  <BaseDialog :open="state.open" :title="state.title" :width="440" :priority="10" @close="settle(false)">
    <p v-if="state.body" class="confirm-body">{{ state.body }}</p>
    <template #footer>
      <button type="button" class="button ghost" @click="settle(false)">{{ state.cancelText }}</button>
      <button type="button" class="button" :class="{ danger: state.danger }" @click="settle(true)">
        {{ state.confirmText }}
      </button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.confirm-body {
  margin: 0;
  color: var(--ink-soft);
  line-height: 1.7;
  white-space: pre-wrap;
}
</style>
