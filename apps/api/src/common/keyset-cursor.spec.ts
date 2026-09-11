import { BadRequestException } from '@nestjs/common';
import {
  decodeKeysetCursor,
  decodeTimeIdCursor,
  encodeKeysetCursor,
  encodeTimeIdCursor,
} from './keyset-cursor';

describe('keyset cursor', () => {
  it('round-trips stable time and id values', () => {
    const timestamp = new Date('2026-08-11T08:00:00.000Z');

    expect(decodeTimeIdCursor(encodeTimeIdCursor(timestamp, 'row-1'))).toEqual({
      timestamp,
      id: 'row-1',
    });
  });

  it.each([
    '',
    'not-json',
    encodeKeysetCursor({ version: 2, timestamp: new Date().toISOString(), id: 'row-1' }),
    encodeKeysetCursor({ timestamp: 'not-a-date', id: 'row-1' }),
    encodeKeysetCursor({ timestamp: new Date().toISOString(), id: '' }),
  ])('rejects a malformed or tampered cursor', (cursor) => {
    expect(() => decodeTimeIdCursor(cursor)).toThrow(BadRequestException);
  });

  it('rejects oversized cursor input before decoding', () => {
    expect(() => decodeKeysetCursor('a'.repeat(513))).toThrow(
      BadRequestException,
    );
  });
});
