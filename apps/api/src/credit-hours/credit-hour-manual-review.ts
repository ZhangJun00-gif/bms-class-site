import { CreditHourSubmissionStatus, CreditHourReviewJobStatus, type Prisma } from '@prisma/client';

const RISK_CODES = [
  'OFFICIAL_SEAL_MISSING',
  'OFFICIAL_SEAL_UNCLEAR',
  'SUSPECTED_AI_GENERATION',
  'SUSPECTED_IMAGE_MANIPULATION',
  'EVIDENCE_AUTHENTICITY_UNCERTAIN',
] as const;

interface ManualReviewSource {
  status: CreditHourSubmissionStatus;
  currentReviewCycle: number;
  reviewJobs: Array<{
    reviewCycle: number;
    status: CreditHourReviewJobStatus;
    reviewAttempts: Array<{
      decision: string | null;
      userReason: string | null;
      riskCodes: Prisma.JsonValue;
      completedAt: Date | null;
      errorCategory: string | null;
    }>;
  }>;
}

export function serializeManualReview(item: ManualReviewSource) {
  if (item.status !== CreditHourSubmissionStatus.PENDING_MANUAL_REVIEW) return null;
  const job = item.reviewJobs.find((entry) => entry.reviewCycle === item.currentReviewCycle && entry.status === CreditHourReviewJobStatus.SUCCEEDED);
  const attempt = job?.reviewAttempts[0];
  if (!attempt || attempt.decision !== 'MANUAL_REVIEW' || attempt.errorCategory || !attempt.completedAt) return null;
  const riskCodes = [...new Set(Array.isArray(attempt.riskCodes) ? attempt.riskCodes.filter((code): code is typeof RISK_CODES[number] => typeof code === 'string' && RISK_CODES.includes(code as typeof RISK_CODES[number])) : [])];
  const imageRisk = riskCodes.some((code) => code === 'SUSPECTED_AI_GENERATION' || code === 'SUSPECTED_IMAGE_MANIPULATION' || code === 'EVIDENCE_AUTHENTICITY_UNCERTAIN');
  const reason = imageRisk
    ? '凭证存在需要进一步核验的图像风险，已转人工审核，请等待管理员审核。当前未认定凭证不实。'
    : riskCodes.some((code) => code === 'OFFICIAL_SEAL_MISSING' || code === 'OFFICIAL_SEAL_UNCLEAR')
      ? '凭证未显示可确认的官方印章，已转人工审核，请等待管理员审核。'
      : '凭证需要进一步核验，已转人工审核，请等待管理员审核。';
  return { transferredAt: attempt.completedAt.toISOString(), reason, riskCodes };
}
