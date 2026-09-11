import { describe, expect, it } from 'vitest';
import { sanitizeRedirect } from './redirect';

describe('sanitizeRedirect', () => {
  it('allows only internal absolute paths', () => {
    expect(sanitizeRedirect('/admin?tab=audit#latest')).toBe(
      '/admin?tab=audit#latest',
    );
    expect(sanitizeRedirect('https://example.com')).toBe('/');
    expect(sanitizeRedirect('//example.com')).toBe('/');
    expect(sanitizeRedirect('/\\example.com')).toBe('/');
    expect(sanitizeRedirect('/%2F%2Fexample.com')).toBe('/');
  });
});
