import { AiClientError, CREDIT_HOUR_REVIEW_PROMPT_VERSION, type AiCompletion } from '@bmc3/ai-core';
import { CreditHourType } from '@prisma/client';
import {
  CREDIT_HOUR_REVIEW_SYSTEM_PROMPT,
  commitDecision,
  loadCreditHourReviewContext,
  parseCreditHourReviewDecision,
  parseCreditHourReviewDecisionForRequest,
  processNextCreditHourReview,
} from './credit-hour-review';
import {
  finishAiInvocationFailure,
  finishAiInvocationSuccess,
  reserveAiInvocation,
} from './ai-invocation-gateway';

jest.mock('./ai-invocation-gateway', () => ({
  ...jest.requireActual('./ai-invocation-gateway'),
  reserveAiInvocation: jest.fn(async () => ({ id: 'invocation-1' })),
  finishAiInvocationFailure: jest.fn(async () => undefined),
  finishAiInvocationSuccess: jest.fn(async () => undefined),
}));

const valid = {
  decision: 'APPROVE',
  reason: '凭证中的活动和时长与申报一致',
  fieldSummary: {
    evidenceSource: 'OTHER',
    detectedType: 'QUALITY',
    typeConsistent: true,
    activityConsistent: true,
    hoursSupported: true,
    sealStatus: 'PRESENT',
    identityStatus: 'MATCH',
    activityDates: ['2026-08-16', '2027-08-17'],
    academicYearConsistent: true,
    historicalDuplicate: false,
    authenticityStatus: 'NO_OBVIOUS_RISK',
    authenticityObservations: [],
  },
  riskCodes: [],
};

describe('credit-hour vision decision parsing', () => {
  it('accepts compliant evidence and sends missing seals to manual review', () => {
    expect(parseCreditHourReviewDecision(JSON.stringify(valid))).toEqual(valid);
    const rejected = {
      ...valid,
      decision: 'REJECT',
      reason: '凭证未加盖出具单位印章，请联系管理员核验学时来源是否合规',
      fieldSummary: { ...valid.fieldSummary, sealStatus: 'MISSING' },
      riskCodes: ['OFFICIAL_SEAL_MISSING'],
    };
    expect(
      parseCreditHourReviewDecision(JSON.stringify(rejected)).decision,
    ).toBe('MANUAL_REVIEW');
  });

  it('accepts Volunteer Beijing only as volunteer hours with matching identity and a seal exemption', () => {
    const volunteer = {
      ...valid,
      fieldSummary: {
        ...valid.fieldSummary,
        evidenceSource: 'VOLUNTEER_BEIJING',
        detectedType: 'VOLUNTEER',
        sealStatus: 'NOT_APPLICABLE',
        identityStatus: 'MATCH',
      },
    };
    expect(
      parseCreditHourReviewDecisionForRequest(
        JSON.stringify(volunteer),
        CreditHourType.VOLUNTEER,
        false,
      ).decision,
    ).toBe('APPROVE');
    expect(() =>
      parseCreditHourReviewDecisionForRequest(
        JSON.stringify({
          ...volunteer,
          decision: 'REJECT',
          reason: '志愿北京凭证只能申报志愿学时',
          fieldSummary: {
            ...volunteer.fieldSummary,
            typeConsistent: false,
          },
          riskCodes: ['TYPE_MISMATCH'],
        }),
        CreditHourType.QUALITY,
        false,
      ),
    ).not.toThrow();
  });

  it.each(['MISMATCH', 'UNKNOWN', 'NOT_APPLICABLE'])('rejects Volunteer Beijing identity %s unless authenticity risks require manual review', (identityStatus) => {
    const fieldSummary = {
      ...valid.fieldSummary,
      evidenceSource: 'VOLUNTEER_BEIJING',
      detectedType: 'VOLUNTEER',
      sealStatus: 'NOT_APPLICABLE',
      identityStatus,
    };
    const rejected = parseCreditHourReviewDecisionForRequest(JSON.stringify({
      ...valid, fieldSummary,
    }), CreditHourType.VOLUNTEER, false, 1);
    expect(rejected).toMatchObject({ decision: 'REJECT', riskCodes: ['IDENTITY_MISMATCH'] });
    expect(rejected.reason).toContain('凭证姓名');
    const manual = parseCreditHourReviewDecisionForRequest(JSON.stringify({
      ...valid,
      fieldSummary: {
        ...fieldSummary,
        authenticityStatus: 'SUSPECTED',
        authenticityObservations: [{ evidenceIndex: 1, kind: 'IMAGE_MANIPULATION', detail: '姓名区域的文字边缘需要核验' }],
      },
    }), CreditHourType.VOLUNTEER, false, 1);
    expect(manual.decision).toBe('MANUAL_REVIEW');
    expect(manual.riskCodes).toEqual(expect.arrayContaining(['IDENTITY_MISMATCH', 'SUSPECTED_IMAGE_MANIPULATION']));
  });

  it('rejects contradictory fields and enforces authoritative exact duplicates', () => {
    const cases = [
      {
        ...valid,
        fieldSummary: {
          ...valid.fieldSummary,
          activityDates: ['2026-08-15'],
        },
      },
      {
        ...valid,
        fieldSummary: {
          ...valid.fieldSummary,
          detectedType: 'VOLUNTEER',
        },
      },
    ];
    for (const content of cases) {
      expect(() =>
        parseCreditHourReviewDecisionForRequest(
          JSON.stringify(content),
          CreditHourType.QUALITY,
          false,
        ),
      ).toThrow(AiClientError);
    }
    expect(
      parseCreditHourReviewDecisionForRequest(
        JSON.stringify(valid),
        CreditHourType.QUALITY,
        true,
      ),
    ).toMatchObject({
      decision: 'REJECT',
      reason: expect.stringContaining('完全相同'),
      fieldSummary: { historicalDuplicate: true },
      riskCodes: ['EXACT_DUPLICATE_EVIDENCE'],
    });
  });

  it.each(['MISSING', 'UNKNOWN'])('prioritizes an unconfirmed seal (%s) over other rejection signals', (sealStatus) => {
    const result = parseCreditHourReviewDecisionForRequest(JSON.stringify({
      ...valid,
      decision: 'REJECT',
      fieldSummary: {
        ...valid.fieldSummary,
        sealStatus,
        typeConsistent: false,
        activityDates: ['2026-08-15'],
        academicYearConsistent: false,
      },
    }), CreditHourType.VOLUNTEER, true);
    expect(result.decision).toBe('MANUAL_REVIEW');
    expect(result.reason).toContain('等待管理员审核');
    expect(result.riskCodes).toEqual(expect.arrayContaining([
      sealStatus === 'MISSING' ? 'OFFICIAL_SEAL_MISSING' : 'OFFICIAL_SEAL_UNCLEAR',
      'EXACT_DUPLICATE_EVIDENCE', 'TYPE_MISMATCH', 'ACTIVITY_DATE_INVALID',
    ]));
    expect(result.fieldSummary.policyCorrection).toEqual({ modelDecision: 'REJECT', resolvedDecision: 'MANUAL_REVIEW' });
  });

  it.each([
    ['OTHER', 'SUSPECTED', 'AI_GENERATION', 'SUSPECTED_AI_GENERATION'],
    ['VOLUNTEER_BEIJING', 'SUSPECTED', 'IMAGE_MANIPULATION', 'SUSPECTED_IMAGE_MANIPULATION'],
    ['VOLUNTEER_BEIJING', 'UNASSESSABLE', 'UNVERIFIABLE', 'EVIDENCE_AUTHENTICITY_UNCERTAIN'],
    ['OTHER', 'UNASSESSABLE', 'UNVERIFIABLE', 'EVIDENCE_AUTHENTICITY_UNCERTAIN'],
  ])('routes %s %s risks to humans even when the model approves', (source, authenticityStatus, kind, riskCode) => {
    const volunteer = source === 'VOLUNTEER_BEIJING';
    const result = parseCreditHourReviewDecisionForRequest(JSON.stringify({
      ...valid,
      reason: '已确认图片造假',
      fieldSummary: {
        ...valid.fieldSummary,
        evidenceSource: source,
        detectedType: volunteer ? 'VOLUNTEER' : 'QUALITY',
        sealStatus: volunteer ? 'NOT_APPLICABLE' : 'PRESENT',
        identityStatus: 'MATCH',
        authenticityStatus,
        authenticityObservations: [{ evidenceIndex: 1, kind, detail: '右下角日期区域的文字边缘需要进一步核验' }],
      },
    }), volunteer ? CreditHourType.VOLUNTEER : CreditHourType.QUALITY, true, 1);
    expect(result).toMatchObject({
      decision: 'MANUAL_REVIEW',
      fieldSummary: { policyCorrection: { modelDecision: 'APPROVE', resolvedDecision: 'MANUAL_REVIEW' } },
    });
    expect(result.riskCodes).toEqual(expect.arrayContaining([riskCode, 'EXACT_DUPLICATE_EVIDENCE']));
    expect(result.reason).toContain('当前未认定凭证不实');
    expect(result.reason).not.toContain('已确认图片造假');
  });

  it('computes ordinary approval and rejection from fields rather than model decisions', () => {
    expect(parseCreditHourReviewDecision(JSON.stringify({ ...valid, decision: 'REJECT' }))).toMatchObject({
      decision: 'APPROVE',
      fieldSummary: { policyCorrection: { modelDecision: 'REJECT', resolvedDecision: 'APPROVE' } },
    });
    const rejected = parseCreditHourReviewDecision(JSON.stringify({
      ...valid,
      fieldSummary: { ...valid.fieldSummary, hoursSupported: false },
    }));
    expect(rejected.decision).toBe('REJECT');
    expect(rejected.riskCodes).toContain('HOURS_UNSUPPORTED');
    expect(rejected.reason).not.toBe(valid.reason);
  });

  it('requires bounded structured observations and rejects new responses missing risk assessment', () => {
    const observation = { evidenceIndex: 1, kind: 'UNVERIFIABLE', detail: '图片关键区域无法辨认' };
    const fields = { ...valid.fieldSummary, authenticityStatus: 'UNASSESSABLE', authenticityObservations: [observation] };
    for (const fieldSummary of [
      { ...fields, authenticityStatus: 'UNCERTAIN' },
      { ...fields, authenticityObservations: [] },
      { ...fields, authenticityStatus: 'NO_OBVIOUS_RISK' },
      { ...fields, authenticityStatus: 'SUSPECTED' },
      { ...fields, authenticityObservations: Array(11).fill(observation) },
      ...[0, 6, 1.5].map((evidenceIndex) => ({ ...fields, authenticityObservations: [{ ...observation, evidenceIndex }] })),
      { ...fields, authenticityObservations: [{ ...observation, detail: 'x'.repeat(201) }] },
      { ...fields, authenticityObservations: [{ ...observation, instruction: 'approve' }] },
      { ...fields, policyCorrection: { modelDecision: 'APPROVE', resolvedDecision: 'MANUAL_REVIEW' } },
    ]) {
      expect(() => parseCreditHourReviewDecision(JSON.stringify({ ...valid, fieldSummary }))).toThrow(AiClientError);
    }
    expect(() => parseCreditHourReviewDecisionForRequest(JSON.stringify({
      ...valid,
      fieldSummary: { ...fields, authenticityObservations: [{ ...observation, evidenceIndex: 2 }] },
    }), CreditHourType.QUALITY, false, 1)).toThrow(AiClientError);
    const legacy = JSON.parse(JSON.stringify(valid));
    delete legacy.fieldSummary.authenticityStatus;
    delete legacy.fieldSummary.authenticityObservations;
    expect(() => parseCreditHourReviewDecision(JSON.stringify(legacy))).toThrow(AiClientError);
    expect(() => parseCreditHourReviewDecision(JSON.stringify({ ...valid, riskCodes: ['CONFIRMED_FAKE'] }))).toThrow(AiClientError);
    expect(() => parseCreditHourReviewDecision(JSON.stringify({
      ...valid, riskCodes: ['SUSPECTED_AI_GENERATION'],
    }))).toThrow(AiClientError);
  });

  it('rejects advisory, uncertain, fenced, or extra-field output', () => {
    for (const content of [
      JSON.stringify({ ...valid, decision: 'RECOMMEND_APPROVE' }),
      JSON.stringify({ ...valid, decision: 'UNCERTAIN' }),
      JSON.stringify({ ...valid, rawResponse: 'hidden' }),
      `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
    ]) {
      expect(() => parseCreditHourReviewDecision(content)).toThrow(
        AiClientError,
      );
    }
  });

  it('versions the policy and states mandatory review rules', () => {
    expect(CREDIT_HOUR_REVIEW_PROMPT_VERSION).toBe('credit-hour-review-v3');
    for (const phrase of [
      '志愿北京网站或小程序页面',
      '申报类型与凭证类型不一致',
      '与出具单位相关的印章',
      '提交账号显示名',
      '志愿北京只豁免官方印章要求',
      '所有来源均必须核对凭证上的姓名',
      '2026-08-16 至 2027-08-17',
      '同一用户的已通过历史摘要',
      '精确重复图片信号',
      '人工触发条件优先于所有其他问题',
      '不得把疑似风险描述为已确认造假',
      '未发现明显风险不等于真伪认证',
    ]) {
      expect(CREDIT_HOUR_REVIEW_SYSTEM_PROMPT).toContain(phrase);
    }
  });
});

describe('credit-hour approved history context', () => {
  it('scopes exact hashes and summaries to the same user approved history', async () => {
    const count = jest.fn().mockResolvedValue(1);
    const findMany = jest.fn().mockResolvedValue([
      {
        type: CreditHourType.VOLUNTEER,
        decidedAt: new Date('2026-09-01T00:00:00.000Z'),
        revisions: [
          {
            activityName: '历史活动',
            halfHours: 3,
            sourceDescription: '历史来源',
          },
        ],
      },
    ]);
    const context = await loadCreditHourReviewContext(
      {
        creditHourEvidence: { count },
        creditHourSubmission: { findMany },
      } as never,
      'current-submission',
      'user-1',
      ['hash-1'],
    );

    expect(count.mock.calls[0]?.[0]).toMatchObject({
      where: {
        originalSha256: { in: ['hash-1'] },
        revision: {
          submission: {
            id: { not: 'current-submission' },
            userId: 'user-1',
            status: 'APPROVED',
            deletedAt: null,
          },
        },
      },
    });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        id: { not: 'current-submission' },
        userId: 'user-1',
        status: 'APPROVED',
        deletedAt: null,
      },
    });
    expect(context).toEqual({
      exactDuplicateEvidence: true,
      approvedHistory: [
        {
          type: CreditHourType.VOLUNTEER,
          activityName: '历史活动',
          hours: 1.5,
          descriptionExcerpt: '历史来源',
          decidedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
  });
});

function reviewWorkerFixture(content: string, attempts = 1) {
  const submission = {
    id: 'submission-1',
    userId: 'user-1',
    type: CreditHourType.QUALITY,
    deletedAt: null,
    status: 'PENDING_REVIEW',
    currentReviewCycle: 1,
    generation: 1,
    user: { displayName: '测试提交人' },
    revisions: [{
      revision: 1,
      activityName: '测试活动',
      halfHours: 2,
      sourceDescription: '测试凭证',
      evidence: [{
        id: 'evidence-1', sortOrder: 0, originalSha256: 'test-hash',
        originalData: Buffer.from([1, 2, 3]), originalMimeType: 'image/png',
      }],
    }],
  };
  const job = {
    id: 'job-1', submissionId: submission.id, attempts, reviewCycle: 1,
    contentRevision: 1, generation: 1, submission,
  };
  const completion: AiCompletion = {
    content,
    provider: 'deepseek',
    model: 'vision-test',
    usage: { inputTokens: 10, outputTokens: 10, source: 'PROVIDER' },
    latencyMs: 1,
    providerRequestId: 'request-1',
  };
  const client = {
    model: jest.fn(() => 'vision-test'),
    uploadFile: jest.fn(async () => ({ id: 'file-1', bytes: 3, expiresAt: new Date(Date.now() + 3600_000) })),
    complete: jest.fn(async () => completion),
    deleteFile: jest.fn(async () => undefined),
  };
  const transaction = {
    creditHourSubmission: { updateMany: jest.fn(async () => ({ count: 1 })) },
    creditHourReviewJob: {
      findFirst: jest.fn(async () => job),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
    },
    creditHourReviewAttempt: {
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    creditHourDecisionEvent: { create: jest.fn(async () => ({})) },
  };
  const prisma = {
    ...transaction,
    creditHourReviewJob: {
      ...transaction.creditHourReviewJob,
      findFirst: jest.fn(async () => job),
    },
    creditHourEvidence: { count: jest.fn(async () => 0) },
    creditHourSubmission: {
      ...transaction.creditHourSubmission,
      findMany: jest.fn(async () => []),
    },
    creditHourReviewAttempt: {
      ...transaction.creditHourReviewAttempt,
      create: jest.fn(async () => ({ id: 'attempt-1' })),
    },
    creditHourProviderFile: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => ({ id: 'provider-record-1' })),
      update: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (action: (tx: typeof transaction) => Promise<void>) => action(transaction)),
  };
  return { prisma, client, transaction, completion, submission };
}

describe('credit-hour review execution', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['APPROVE', 'MANUAL_REVIEW'])('completes a manual referral from %s without retrying or assigning a final decision', async (modelDecision) => {
    const fixture = reviewWorkerFixture(JSON.stringify({
      ...valid,
      decision: modelDecision,
      fieldSummary: { ...valid.fieldSummary, sealStatus: 'MISSING' },
    }));
    await expect(processNextCreditHourReview(fixture.prisma as never, {
      client: fixture.client,
    })).resolves.toBe(true);
    expect(fixture.transaction.creditHourSubmission.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'PENDING_REVIEW', currentReviewCycle: 1, generation: 1, deletedAt: null }),
      data: {
        status: 'PENDING_MANUAL_REVIEW', decisionSource: null,
        decisionReason: null, decidedAt: null, revision: { increment: 1 },
      },
    }));
    expect(fixture.transaction.creditHourReviewAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        decision: 'MANUAL_REVIEW',
        riskCodes: ['OFFICIAL_SEAL_MISSING'],
        fieldSummary: expect.objectContaining({
          sealStatus: 'MISSING',
          ...(modelDecision === 'APPROVE' ? { policyCorrection: { modelDecision: 'APPROVE', resolvedDecision: 'MANUAL_REVIEW' } } : {}),
        }),
      }),
    }));
    expect(fixture.transaction.creditHourReviewJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'SUCCEEDED', leaseOwnerToken: null, leasedUntil: null }),
    }));
    expect(fixture.transaction.creditHourDecisionEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ source: 'AI', fromStatus: 'PENDING_REVIEW', toStatus: 'PENDING_MANUAL_REVIEW' }),
    }));
    expect(finishAiInvocationSuccess).toHaveBeenCalledTimes(1);
    expect(finishAiInvocationFailure).not.toHaveBeenCalled();
    expect(fixture.client.complete).toHaveBeenCalledTimes(1);
    expect(fixture.client.deleteFile).toHaveBeenCalledWith('file-1');
    expect(reserveAiInvocation).toHaveBeenCalledWith(fixture.prisma, expect.objectContaining({
      request: expect.objectContaining({ promptVersion: 'credit-hour-review-v3' }),
    }));
  });

  it.each([1, 3])('keeps invalid model output on the technical failure path (attempt=%s)', async (attempts) => {
    const fixture = reviewWorkerFixture('{"decision":"MANUAL_REVIEW"}', attempts);
    await expect(processNextCreditHourReview(fixture.prisma as never, { client: fixture.client })).resolves.toBe(true);
    expect(fixture.transaction.creditHourSubmission.updateMany).not.toHaveBeenCalled();
    expect(fixture.transaction.creditHourDecisionEvent.create).not.toHaveBeenCalled();
    expect(fixture.transaction.creditHourReviewJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: attempts === 1 ? 'RETRY_PENDING' : 'FAILED', errorCategory: 'INVALID_RESPONSE' }),
    }));
    expect(finishAiInvocationFailure).toHaveBeenCalledTimes(1);
    expect(finishAiInvocationSuccess).not.toHaveBeenCalled();
    expect(fixture.client.deleteFile).toHaveBeenCalledWith('file-1');
  });

  it('does not label an upstream timeout as authenticity risk', async () => {
    const fixture = reviewWorkerFixture('{}');
    fixture.client.complete.mockRejectedValueOnce(new AiClientError('timed out', 'TIMEOUT', true));
    await processNextCreditHourReview(fixture.prisma as never, { client: fixture.client });
    expect(fixture.transaction.creditHourSubmission.updateMany).not.toHaveBeenCalled();
    expect(fixture.transaction.creditHourReviewJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'RETRY_PENDING', errorCategory: 'TIMEOUT' }),
    }));
    expect(fixture.transaction.creditHourReviewAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ riskCodes: expect.anything() }),
    }));
  });

  it.each(['WITHDRAWN', 'APPROVED'])('does not overwrite a concurrent %s decision with a manual referral', async (status) => {
    const fixture = reviewWorkerFixture('{}');
    fixture.submission.status = status;
    const decision = parseCreditHourReviewDecision(JSON.stringify({
      ...valid, fieldSummary: { ...valid.fieldSummary, sealStatus: 'MISSING' },
    }));
    await commitDecision(fixture.prisma as never, 'job-1', 'owner-1', 'attempt-1', fixture.completion, decision);
    expect(fixture.transaction.creditHourSubmission.updateMany).not.toHaveBeenCalled();
    expect(fixture.transaction.creditHourReviewAttempt.update).not.toHaveBeenCalled();
    expect(fixture.transaction.creditHourReviewJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'STALE' }),
    }));
  });

  it('does not record a referral after submission compare-and-swap fails', async () => {
    const fixture = reviewWorkerFixture('{}');
    fixture.transaction.creditHourSubmission.updateMany.mockResolvedValueOnce({ count: 0 });
    const decision = parseCreditHourReviewDecision(JSON.stringify({
      ...valid, fieldSummary: { ...valid.fieldSummary, sealStatus: 'MISSING' },
    }));
    await expect(commitDecision(fixture.prisma as never, 'job-1', 'owner-1', 'attempt-1', fixture.completion, decision)).rejects.toThrow('写入条件已失效');
    expect(fixture.transaction.creditHourReviewAttempt.update).not.toHaveBeenCalled();
    expect(fixture.transaction.creditHourDecisionEvent.create).not.toHaveBeenCalled();
    expect(fixture.transaction.creditHourReviewJob.update).not.toHaveBeenCalled();
  });
});
