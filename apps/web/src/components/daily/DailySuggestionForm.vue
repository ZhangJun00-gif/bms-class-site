<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Send } from 'lucide-vue-next';
import { useConfirm } from '../../composables/useConfirm';
import { useQuizFilters } from '../../composables/useQuizFilters';
import { useToast } from '../../composables/useToast';
import { submitDailySuggestion } from '../../lib/dailyPractice';
import { ApiClientError, formatError } from '../../lib/api';
import {
  dailyPracticeIntensityLabels,
  dailyPracticeSuggestionStatusLabels,
} from '../../lib/labels';
import type {
  DailyPracticeIntensity,
  DailyPracticeSuggestionRecord,
} from '../../types';
import StatusBadge from '../common/StatusBadge.vue';

const props = defineProps<{
  targetPracticeDate: string;
  available: boolean;
  current: DailyPracticeSuggestionRecord | null;
  servicePaused?: boolean;
}>();
const emit = defineEmits<{
  saved: [record: DailyPracticeSuggestionRecord];
  conflict: [];
}>();

const { confirm } = useConfirm();
const toast = useToast();
const { groups, error: filtersError, ensure: ensureFilters } = useQuizFilters();
const intensity = ref<DailyPracticeIntensity>('STANDARD');
const desiredQuestionCount = ref(7);
const focusSubjectIds = ref<string[]>([]);
const focusChapterIds = ref<string[]>([]);
const note = ref('');
const busy = ref(false);
const localRecord = ref<DailyPracticeSuggestionRecord | null>(null);
const hint = ref('');

const record = computed(() => localRecord.value ?? props.current);
const canSubmit = computed(
  () => props.available && !props.servicePaused && !record.value && !busy.value,
);
const chapterOptions = computed(() =>
  groups.value
    .filter((group) => focusSubjectIds.value.includes(group.subjectId))
    .flatMap((group) =>
      group.chapters.map((chapter) => ({
        id: chapter.chapterId,
        label: `${group.subject} · ${chapter.chapter}`,
      })),
    ),
);

watch(chapterOptions, (options) => {
  const allowed = new Set(options.map((item) => item.id));
  focusChapterIds.value = focusChapterIds.value.filter((id) => allowed.has(id));
});

watch(
  () => props.targetPracticeDate,
  () => {
    localRecord.value = null;
  },
);

onMounted(() => void ensureFilters());

function toggleSubject(id: string) {
  hint.value = '';
  if (focusSubjectIds.value.includes(id)) {
    focusSubjectIds.value = focusSubjectIds.value.filter((value) => value !== id);
    return;
  }
  if (focusSubjectIds.value.length >= 2) {
    hint.value = '最多选择 2 个重点学科';
    return;
  }
  focusSubjectIds.value = [...focusSubjectIds.value, id];
}

function toggleChapter(id: string) {
  hint.value = '';
  if (focusChapterIds.value.includes(id)) {
    focusChapterIds.value = focusChapterIds.value.filter((value) => value !== id);
    return;
  }
  if (focusChapterIds.value.length >= 5) {
    hint.value = '最多选择 5 个重点章节';
    return;
  }
  focusChapterIds.value = [...focusChapterIds.value, id];
}

async function submit() {
  if (!canSubmit.value) return;
  const submittedTargetDate = props.targetPracticeDate;
  const ok = await confirm({
    title: '提交明日练习建议',
    body: `建议将用于 ${submittedTargetDate} 的个性化生成，提交后今日不能再次修改。内容会发送给第三方模型，请勿填写姓名、学号、联系方式或健康信息。`,
    confirmText: '确认提交',
  });
  if (!ok) return;
  if (submittedTargetDate !== props.targetPracticeDate) {
    emit('conflict');
    return;
  }

  busy.value = true;
  try {
    const saved = await submitDailySuggestion({
      intensity: intensity.value,
      desiredQuestionCount: desiredQuestionCount.value,
      focusSubjectIds: [...focusSubjectIds.value],
      focusChapterIds: [...focusChapterIds.value],
      ...(note.value.trim() ? { note: note.value.trim() } : {}),
    });
    if (
      submittedTargetDate !== props.targetPracticeDate ||
      saved.targetPracticeDate !== submittedTargetDate
    ) {
      emit('conflict');
      return;
    }
    localRecord.value = saved;
    emit('saved', saved);
    toast.success('明日练习建议已提交');
  } catch (caught) {
    if (caught instanceof ApiClientError && caught.status === 409) emit('conflict');
    toast.error(formatError(caught, '建议提交失败'));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="suggestion-section" aria-labelledby="suggestion-title">
    <header class="suggestion-heading">
      <div>
        <p class="section-kicker">下一练习日</p>
        <h2 id="suggestion-title">明日练习建议</h2>
      </div>
      <span class="target-date">{{ targetPracticeDate }}</span>
    </header>

    <div v-if="record" class="submitted-suggestion">
      <div class="submitted-heading">
        <strong>今日建议已使用</strong>
        <StatusBadge :text="dailyPracticeSuggestionStatusLabels[record.status]" tone="accent" />
      </div>
      <dl>
        <div><dt>强度</dt><dd>{{ dailyPracticeIntensityLabels[record.payload.intensity] }}</dd></div>
        <div><dt>个性化题量</dt><dd>{{ record.payload.desiredQuestionCount }} 题</dd></div>
        <div v-if="record.payload.note"><dt>补充建议</dt><dd>{{ record.payload.note }}</dd></div>
      </dl>
    </div>

    <p v-else-if="servicePaused" class="alert warning">
      每日一练当前暂停，恢复服务后才能提交新的明日建议。
    </p>
    <p v-else-if="!available" class="alert info">当前练习日暂无可用建议配额。</p>

    <form v-else class="suggestion-form" @submit.prevent="submit">
      <fieldset class="intensity-fieldset">
        <legend>练习强度</legend>
        <label
          v-for="value in (['LIGHT', 'STANDARD', 'CHALLENGING'] as const)"
          :key="value"
          :class="{ active: intensity === value }"
        >
          <input v-model="intensity" type="radio" name="daily-intensity" :value="value" />
          {{ dailyPracticeIntensityLabels[value] }}
        </label>
      </fieldset>

      <div class="field question-count-field">
        <label for="daily-question-count">个性化题量</label>
        <select id="daily-question-count" v-model.number="desiredQuestionCount">
          <option v-for="count in 6" :key="count + 4" :value="count + 4">
            {{ count + 4 }} 题
          </option>
        </select>
        <p class="field-hint">管理员固定题为额外部分，不计入这里。</p>
      </div>

      <fieldset class="focus-fieldset">
        <legend>重点学科（最多 2 个）</legend>
        <div class="check-grid">
          <label v-for="group in groups" :key="group.subjectId">
            <input
              type="checkbox"
              :checked="focusSubjectIds.includes(group.subjectId)"
              @change="toggleSubject(group.subjectId)"
            />
            {{ group.subject }}
          </label>
        </div>
        <p v-if="filtersError" class="field-hint">{{ filtersError }}</p>
      </fieldset>

      <fieldset v-if="chapterOptions.length" class="focus-fieldset">
        <legend>重点章节（最多 5 个）</legend>
        <div class="check-grid chapter-grid">
          <label v-for="chapter in chapterOptions" :key="chapter.id">
            <input
              type="checkbox"
              :checked="focusChapterIds.includes(chapter.id)"
              @change="toggleChapter(chapter.id)"
            />
            {{ chapter.label }}
          </label>
        </div>
      </fieldset>

      <div class="field note-field">
        <label for="daily-suggestion-note">补充建议</label>
        <textarea
          id="daily-suggestion-note"
          v-model="note"
          maxlength="300"
          rows="4"
          placeholder="例如：希望加强本周课堂中容易混淆的概念"
        />
        <p class="field-hint">剩余 {{ 300 - note.length }} 字。请勿填写个人敏感信息。</p>
      </div>

      <p v-if="hint" class="alert warning" role="alert">{{ hint }}</p>
      <button type="submit" class="button submit-button" :disabled="!canSubmit">
        <Send :size="16" aria-hidden="true" />
        {{ busy ? '正在提交…' : '提交明日建议' }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.suggestion-section {
  display: grid;
  gap: var(--space-5);
  padding-block: var(--space-6);
  border-block: 1px solid var(--border);
}

.suggestion-heading,
.submitted-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.suggestion-heading h2,
.section-kicker,
.submitted-suggestion dl,
.submitted-suggestion dd {
  margin: 0;
}

.suggestion-heading h2 {
  margin-top: 3px;
  font-size: 22px;
}

.section-kicker,
.target-date {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.suggestion-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.35fr);
  gap: var(--space-5);
}

.intensity-fieldset,
.focus-fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.intensity-fieldset legend,
.focus-fieldset legend {
  margin-bottom: var(--space-2);
  color: var(--ink-soft);
  font-size: 13px;
  font-weight: 600;
}

.intensity-fieldset {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-content: start;
  gap: var(--space-1);
}

.intensity-fieldset legend {
  grid-column: 1 / -1;
}

.intensity-fieldset label {
  min-height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  color: var(--ink-soft);
  background: var(--surface-muted);
  cursor: pointer;
}

.intensity-fieldset label.active {
  border-color: var(--accent);
  color: var(--accent-dark);
  background: var(--accent-soft);
  font-weight: 600;
}

.intensity-fieldset input {
  position: absolute;
  opacity: 0;
}

.intensity-fieldset label:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.focus-fieldset,
.note-field,
.suggestion-form > .alert,
.submit-button {
  grid-column: 1 / -1;
}

.check-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2) var(--space-4);
}

.check-grid label {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  color: var(--ink-soft);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.check-grid input {
  width: 17px;
  height: 17px;
  flex: none;
  margin-top: 2px;
  accent-color: var(--accent);
}

.chapter-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.submit-button {
  justify-self: start;
}

.submitted-suggestion {
  display: grid;
  gap: var(--space-3);
}

.submitted-suggestion dl {
  display: grid;
  gap: var(--space-2);
}

.submitted-suggestion dl div {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.submitted-suggestion dt {
  color: var(--muted);
  font-size: 13px;
}

.submitted-suggestion dd {
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}

@media (max-width: 700px) {
  .suggestion-form,
  .check-grid,
  .chapter-grid {
    grid-template-columns: 1fr;
  }

  .question-count-field {
    grid-column: 1;
  }
}

@media (max-width: 560px) {
  .suggestion-heading {
    flex-direction: column;
  }

  .intensity-fieldset {
    grid-template-columns: 1fr;
  }

  .submitted-suggestion dl div {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .submit-button {
    width: 100%;
  }
}
</style>
