import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

async function withLibraryService(invoke, check) {
  const previousWindow = globalThis.window;
  const server = await createServer({ configFile: false, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
  globalThis.window = { paperquay: { invoke } };
  try { await check(await server.ssrLoadModule('/src/services/library.ts')); }
  finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
}

test('PDF import waits for the selected file-handling mode to save', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await withLibraryService(async (command, args) => {
    calls.push({ command, args });
    if (command === 'library_update_settings') { await gate; return { importMode: 'keep' }; }
    assert.equal(command, 'library_import_pdfs'); return [];
  }, async service => {
    const updating = service.updateLibrarySettings({ importMode: 'keep' });
    const importing = service.importPdfsToLibrary({ paths: ['fixture.pdf'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.map(call => call.command), ['library_update_settings']);
    assert.deepEqual(calls[0].args.settings, { importMode: 'keep' });
    release(); await updating; await importing;
    assert.deepEqual(calls.map(call => call.command), ['library_update_settings', 'library_import_pdfs']);
  });
});

test('an in-flight settings failure stops import before any file operation', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await withLibraryService(async command => {
    calls.push(command); await gate; throw new Error('Native settings failed');
  }, async service => {
    const updating = assert.rejects(service.updateLibrarySettings({ importMode: 'copy' }), /Native settings failed/);
    const importing = assert.rejects(service.importPdfsToLibrary({ paths: ['fixture.pdf'] }), /Native settings failed/);
    release(); await updating; await importing;
    assert.deepEqual(calls, ['library_update_settings']);
  });
});
