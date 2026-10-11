import assert from 'node:assert/strict';
import test from 'node:test';
import { createSerialSettingsWrites } from '../src/services/serialSettingsWrites.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('settings patches are written in edit order and shutdown waits for the complete queue', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const writer = createSerialSettingsWrites(async (value: string) => {
    calls.push(value);
    if (value === 'first') await gate.promise;
    return value;
  });
  const first = writer.update('first'), second = writer.update('latest');
  let closed = false;
  const closing = writer.flush().then(() => { closed = true; });
  await Promise.resolve();
  assert.deepEqual(calls, ['first']); assert.equal(closed, false);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'latest']);
  await closing;
  assert.deepEqual(calls, ['first', 'latest']); assert.equal(closed, true);
});

test('a rejected save cannot permanently block a later edit or replay canceled changes', async () => {
  const calls: string[] = [];
  const writer = createSerialSettingsWrites(async (value: string) => {
    calls.push(value);
    if (value === 'failed') throw new Error('Fixture save failure');
    return value;
  });
  await assert.rejects(writer.update('failed'), /Fixture save failure/);
  assert.equal(await writer.update('retry'), 'retry');
  await writer.flush();
  assert.deepEqual(calls, ['failed', 'retry']);
});

test('a failure during shutdown is surfaced and is not treated as a completed save', async () => {
  const gate = deferred();
  const writer = createSerialSettingsWrites(async () => { await gate.promise; throw new Error('Disk full'); });
  const updating = writer.update({ value: 'unsaved' });
  const closing = writer.flush();
  gate.resolve();
  await assert.rejects(updating, /Disk full/);
  await assert.rejects(closing, /Disk full/);
});
