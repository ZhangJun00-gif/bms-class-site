<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Check, ChevronDown } from 'lucide-vue-next';
import type { ChapterMatch } from '../../types';

interface ChapterOption {
  id: string;
  label: string;
  count?: number;
}

const props = withDefaults(
  defineProps<{
    id: string;
    modelValue: string[];
    match?: ChapterMatch;
    options: ChapterOption[];
    disabled?: boolean;
    placeholder?: string;
    showMatch?: boolean;
  }>(),
  {
    match: 'ANY',
    disabled: false,
    placeholder: '全部章节',
    showMatch: true,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string[]];
  'update:match': [value: ChapterMatch];
  change: [];
}>();

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const selectedOptions = computed(() =>
  props.modelValue
    .map((id) => props.options.find((option) => option.id === id))
    .filter((option): option is ChapterOption => Boolean(option)),
);
const summary = computed(() => {
  if (!selectedOptions.value.length) return props.placeholder;
  if (selectedOptions.value.length === 1)
    return selectedOptions.value[0]!.label;
  if (!props.showMatch) return `已选 ${selectedOptions.value.length} 个章节`;
  const mode = props.match === 'ALL' ? '全部命中' : '任一命中';
  return `已选 ${selectedOptions.value.length} 个章节 · ${mode}`;
});

function toggleOpen() {
  if (!props.disabled) open.value = !open.value;
}

function commit(value: string[]) {
  emit('update:modelValue', value);
  if (value.length < 2 && props.match !== 'ANY') emit('update:match', 'ANY');
  emit('change');
}

function toggle(id: string) {
  if (props.modelValue.includes(id)) {
    commit(props.modelValue.filter((value) => value !== id));
  } else {
    commit([...props.modelValue, id]);
  }
}

function clear() {
  if (props.modelValue.length) commit([]);
}

function setMatch(value: ChapterMatch) {
  if (value === props.match) return;
  emit('update:match', value);
  emit('change');
}

function closeOnOutsideClick(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node))
    open.value = false;
}

onMounted(() => document.addEventListener('click', closeOnOutsideClick));
onBeforeUnmount(() =>
  document.removeEventListener('click', closeOnOutsideClick),
);
</script>

<template>
  <div ref="root" class="chapter-select" @keydown.esc="open = false">
    <button
      :id="id"
      type="button"
      class="chapter-select-trigger"
      :disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <span>{{ summary }}</span>
      <ChevronDown :size="16" aria-hidden="true" />
    </button>
    <div v-if="open" class="chapter-select-menu">
      <div
        class="chapter-select-options"
        role="listbox"
        aria-multiselectable="true"
      >
        <button
          type="button"
          class="chapter-select-option"
          :class="{ active: !modelValue.length }"
          role="option"
          :aria-selected="!modelValue.length"
          @click="clear"
        >
          <Check v-if="!modelValue.length" :size="16" aria-hidden="true" />
          <span v-else class="option-marker" aria-hidden="true" />
          <span>{{ placeholder }}</span>
        </button>
        <button
          v-for="option in options"
          :key="option.id"
          type="button"
          class="chapter-select-option"
          :class="{ active: modelValue.includes(option.id) }"
          role="option"
          :aria-selected="modelValue.includes(option.id)"
          @click="toggle(option.id)"
        >
          <Check
            v-if="modelValue.includes(option.id)"
            :size="16"
            aria-hidden="true"
          />
          <span v-else class="option-marker" aria-hidden="true" />
          <span class="option-label">{{ option.label }}</span>
          <span v-if="option.count !== undefined" class="option-count">
            {{ option.count }}
          </span>
        </button>
      </div>
      <div v-if="showMatch && modelValue.length > 1" class="chapter-match">
        <span>章节匹配</span>
        <div class="match-options" role="group" aria-label="章节匹配方式">
          <button
            type="button"
            :class="{ active: match === 'ANY' }"
            :aria-pressed="match === 'ANY'"
            @click="setMatch('ANY')"
          >
            任一命中
          </button>
          <button
            type="button"
            :class="{ active: match === 'ALL' }"
            :aria-pressed="match === 'ALL'"
            @click="setMatch('ALL')"
          >
            全部命中
          </button>
        </div>
      </div>
      <button type="button" class="chapter-select-done" @click="open = false">
        完成
      </button>
    </div>
  </div>
</template>

<style scoped>
.chapter-select {
  position: relative;
  min-width: 0;
}

.chapter-select-trigger {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  text-align: left;
}

.chapter-select-trigger span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chapter-select-trigger svg {
  flex: none;
  color: var(--muted);
}

.chapter-select-trigger:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.chapter-select-trigger:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--focus-ring);
}

.chapter-select-trigger:disabled {
  background: var(--surface-muted);
  color: var(--muted);
  cursor: not-allowed;
}

.chapter-select-menu {
  position: absolute;
  z-index: 30;
  top: calc(100% + var(--space-1));
  left: 0;
  width: max(100%, 300px);
  max-width: min(360px, calc(100vw - 32px));
  padding: var(--space-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-m);
}

.chapter-select-options {
  display: grid;
  max-height: 260px;
  overflow-y: auto;
}

.chapter-select-option {
  width: 100%;
  min-height: 38px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  padding: 7px 9px;
  border: 0;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--ink-soft);
  cursor: pointer;
  text-align: left;
}

.chapter-select-option:hover,
.chapter-select-option.active {
  background: var(--surface-tint);
  color: var(--primary);
}

.chapter-select-option svg,
.option-marker {
  width: 16px;
  height: 16px;
  color: var(--accent-dark);
}

.option-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.option-count {
  color: var(--muted);
  font-size: 12px;
}

.chapter-match {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-3) var(--space-2) var(--space-2);
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}

.match-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-1);
  padding: 3px;
  border-radius: var(--radius-s);
  background: var(--surface-muted);
}

.match-options button,
.chapter-select-done {
  min-height: 34px;
  border: 0;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--ink-soft);
  cursor: pointer;
}

.match-options button.active {
  background: var(--surface);
  color: var(--accent-dark);
  box-shadow: var(--shadow-s);
}

.chapter-select-done {
  width: 100%;
  margin-top: var(--space-2);
  border-top: 1px solid var(--border);
  color: var(--accent-dark);
  font-weight: 600;
}
</style>
