import { describe, expect, it } from 'vitest';
import { auditActionLabel, summarizeAuditMetadata } from './audit';

describe('audit log presentation', () => {
  it('removes sensitive fields from metadata summaries', () => {
    const summary = summarizeAuditMetadata({
      role: 'EDITOR',
      password: 'never-show',
      nested: { sessionToken: 'never-show', status: 'ACTIVE' },
      studentNumberEncrypted: 'never-show',
    });

    expect(summary).toContain('role: EDITOR');
    expect(summary).toContain('status: ACTIVE');
    expect(summary).not.toContain('never-show');
    expect(summary).not.toMatch(/password|token|student/i);
  });

  it('uses readable labels while retaining unknown action identifiers', () => {
    expect(auditActionLabel('user.update')).toBe('更新成员');
    expect(auditActionLabel('album.photo.remove')).toBe('移除相册图片');
    expect(auditActionLabel('news.archive')).toBe('归档动态');
    expect(auditActionLabel('news.restore')).toBe('恢复动态');
    expect(auditActionLabel('news.delete')).toBe('删除动态');
    expect(auditActionLabel('custom.action')).toBe('custom.action');
  });
});
