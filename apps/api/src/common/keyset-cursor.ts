import { BadRequestException } from '@nestjs/common';

export function encodeKeysetCursor(payload: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ version: 1, ...payload }), 'utf8').toString(
    'base64url',
  );
}

export function decodeKeysetCursor(value: string) {
  if (!value || value.length > 512) throw invalidCursor();
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      throw invalidCursor();
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw invalidCursor();
  }
}

export function decodeTimeIdCursor(value: string) {
  const parsed = decodeKeysetCursor(value);
  if (
    typeof parsed.timestamp !== 'string' ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    parsed.id.length > 191
  ) {
    throw invalidCursor();
  }
  const timestamp = new Date(parsed.timestamp);
  if (Number.isNaN(timestamp.getTime())) throw invalidCursor();
  return { timestamp, id: parsed.id };
}

export function encodeTimeIdCursor(timestamp: Date, id: string) {
  return encodeKeysetCursor({ timestamp: timestamp.toISOString(), id });
}

function invalidCursor() {
  return new BadRequestException('游标无效或已损坏');
}
