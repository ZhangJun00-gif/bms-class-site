import { serializeManualReview } from './credit-hour-manual-review';
import { CreditHoursService } from './credit-hours.service';

function fixture() {
  return {
    id: 'submission-fixture', userId: 'user-fixture', status: 'PENDING_MANUAL_REVIEW' as const,
    currentReviewCycle: 2, revision: 3,
    reviewJobs: [{
      id: 'job-fixture', reviewCycle: 2, status: 'SUCCEEDED' as const,
      reviewAttempts: [{
        decision: 'MANUAL_REVIEW', userReason: 'untrusted model content',
        riskCodes: ['OFFICIAL_SEAL_MISSING', 'untrusted-code', 'OFFICIAL_SEAL_MISSING'],
        completedAt: new Date('2026-09-05T00:00:00Z'), errorCategory: null,
      }],
    }],
  };
}

describe('credit-hour manual review presentation', () => {
  it('uses the current successful attempt timestamp and only controlled risk codes and text', () => {
    const result = serializeManualReview(fixture());
    expect(result).toEqual({
      transferredAt: '2026-09-05T00:00:00.000Z',
      reason: '凭证未显示可确认的官方印章，已转人工审核，请等待管理员审核。',
      riskCodes: ['OFFICIAL_SEAL_MISSING'],
    });
    expect(JSON.stringify(result)).not.toContain('untrusted');
  });

  it('prioritizes image risk and never calls an unresolved risk proven falsification', () => {
    const item = fixture();
    item.reviewJobs[0]!.reviewAttempts[0]!.riskCodes = ['OFFICIAL_SEAL_MISSING', 'SUSPECTED_AI_GENERATION'];
    expect(serializeManualReview(item)?.reason).toContain('当前未认定凭证不实');
  });

  it('does not invent a referral from historical, incomplete, or technical-error attempts', () => {
    expect(serializeManualReview({ ...fixture(), status: 'APPROVED' })).toBeNull();
    expect(serializeManualReview({ ...fixture(), currentReviewCycle: 3 })).toBeNull();
    const item = fixture();
    item.reviewJobs[0]!.reviewAttempts[0]!.decision = 'APPROVE';
    expect(serializeManualReview(item)).toBeNull();
    expect(serializeManualReview({ ...fixture(), reviewJobs: [{ ...fixture().reviewJobs[0]!, status: 'FAILED' }] })).toBeNull();
  });
});

describe('credit-hour manual review lifecycle', () => {
  it('allows the owner to withdraw manual review using the same revision CAS', async () => {
    const item = fixture();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      creditHourSubmission: {
        findFirst: jest.fn().mockResolvedValue(item), updateMany,
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...item, status: 'WITHDRAWN', user: { id: item.userId }, revisions: [{ evidence: [], halfHours: 2 }], reviewJobs: [] }),
      },
      creditHourReviewJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      creditHourDecisionEvent: { create: jest.fn() },
    };
    const service = new CreditHoursService({ $transaction: (run: (client: typeof tx) => unknown) => run(tx) } as never, {} as never, { record: jest.fn() } as never, {} as never, {} as never);
    await expect(service.withdraw({ id: item.userId } as never, item.id, 3)).resolves.toMatchObject({ status: 'WITHDRAWN', manualReview: null });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      userId: item.userId, revision: 3, status: { in: ['PENDING_REVIEW', 'PENDING_MANUAL_REVIEW'] },
    }) }));
  });

  it('rejects a lost withdrawal CAS and never reopens or retries manual review', async () => {
    const item = fixture();
    const tx = {
      creditHourSubmission: {
        findFirst: jest.fn().mockResolvedValue(item),
        findUnique: jest.fn().mockResolvedValue({ revision: 4 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      creditHourReviewJob: { create: jest.fn(), updateMany: jest.fn() },
    };
    const service = new CreditHoursService({ $transaction: (run: (client: typeof tx) => unknown) => run(tx) } as never, {} as never, {} as never, {} as never, {} as never);
    const actor = { id: item.userId } as never;
    await expect(service.withdraw(actor, item.id, 3)).rejects.toThrow('记录已发生变化');
    await expect(service.reopen(actor, item.id, { expectedRevision: 3, reason: 'fixture' })).rejects.toThrow('当前记录已经处于待审核状态');
    await expect(service.retry(actor, item.id, { expectedRevision: 3, reason: 'fixture' })).rejects.toThrow('只有待审核记录可以重试');
    expect(tx.creditHourReviewJob.create).not.toHaveBeenCalled();
    expect(tx.creditHourReviewJob.updateMany).not.toHaveBeenCalled();
  });
});
