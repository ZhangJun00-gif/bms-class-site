<script setup lang="ts">
import { computed } from 'vue';
import type { CreditHourSubmission } from '@bmc3/contracts';

const props = defineProps<{ review: CreditHourSubmission['manualReview'] }>();
const codes = computed(() => props.review?.riskCodes ?? []);
const seal = computed(() => codes.value.some((code) => ['OFFICIAL_SEAL_MISSING', 'OFFICIAL_SEAL_UNCLEAR'].includes(code)));
const imageRisk = computed(() => codes.value.some((code) => ['SUSPECTED_AI_GENERATION', 'SUSPECTED_IMAGE_MANIPULATION', 'EVIDENCE_AUTHENTICITY_UNCERTAIN'].includes(code)));
</script>

<template>
  <div class="manual-review-notice" role="status">
    <p v-if="seal">凭证未显示可确认的官方印章，已转人工审核，请等待管理员审核。</p>
    <p v-if="imageRisk">凭证存在需要进一步核验的图像风险，已转人工审核，请等待管理员审核。当前未认定凭证不实。</p>
    <p v-if="!seal && !imageRisk">凭证已转人工审核，请等待管理员审核。</p>
    <p v-if="review?.reason">{{ review.reason }}</p>
    <time v-if="review?.transferredAt">转交时间：{{ new Date(review.transferredAt).toLocaleString('zh-CN') }}</time>
  </div>
</template>

<style scoped>
.manual-review-notice { padding: 10px 12px; border-left: 3px solid var(--warning, #b7791f); background: #fff8df; color: #684a0d; overflow-wrap: anywhere; }
p { margin: 0 0 6px; white-space: pre-wrap; }
p:last-child { margin-bottom: 0; }
time { font-size: 12px; }
</style>
