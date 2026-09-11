<script setup lang="ts">
import { Search } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    id: string;
    modelValue: string;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function updateValue(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="field quiz-keyword-search">
    <label :for="id">关键词</label>
    <div class="quiz-keyword-row">
      <input
        :id="id"
        :value="modelValue"
        type="search"
        maxlength="200"
        placeholder="搜索题干关键词"
        :disabled="disabled"
        @input="updateValue"
      />
      <button
        type="submit"
        class="button secondary quiz-keyword-button"
        :disabled="disabled"
      >
        <Search :size="15" aria-hidden="true" />
        搜索
      </button>
    </div>
  </div>
</template>

<style scoped>
.quiz-keyword-search {
  width: 100%;
  flex: 1 0 100% !important;
}

.quiz-keyword-row {
  display: flex;
  gap: var(--space-2);
}

.quiz-keyword-row input {
  min-width: 0;
  flex: 1;
}

.quiz-keyword-button {
  min-height: 44px;
  flex: none;
}
</style>
