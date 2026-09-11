import type { Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';

export async function waitForExportDrain(response: Writable, failure: Promise<never>) {
  // ZIP entry events can resolve before Node pumps their output into the HTTP
  // stream. Yield once, then honor downstream backpressure before reading more.
  await setImmediate();
  if (response.destroyed) throw new Error('Export connection closed');
  if (!response.writableNeedDrain) return;
  let onDrain!: () => void;
  const drained = new Promise<void>((resolve) => {
    onDrain = resolve;
    response.once('drain', onDrain);
  });
  try { await Promise.race([drained, failure]); }
  finally { response.off('drain', onDrain); }
}
