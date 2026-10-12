import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
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

test('Zotero import saves only its directory and preserves a queued preference edit', async () => {
  const source = ts.createSourceFile('LiteratureLibraryView.tsx', readFileSync(
    new URL('../src/features/literature/LiteratureLibraryView.tsx', import.meta.url), 'utf8',
  ), ts.ScriptTarget.Latest, true);
  const find = (node, match) => match(node) ? node : ts.forEachChild(node, child => find(child, match));
  const handler = find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleImportZoteroLibrary');
  assert.ok(handler);
  const save = find(handler, node => ts.isCallExpression(node) && node.expression.getText(source) === 'updateLibrarySettings');
  assert.ok(save);
  // Exercise the actual import handler's save expression, not a copied patch.
  const saveImportDirectory = new Function('updateLibrarySettings', 'activeSettings', 'dataDir', `return ${save.getText(source)};`);
  const staleSettings = { openAlexEnabled: true, autoRenameFiles: false, zoteroLocalDataDir: 'previous' };
  let persisted = { ...staleSettings }, release;
  const gate = new Promise(resolve => { release = resolve; });
  const patches = [];
  await withLibraryService(async (command, args) => {
    assert.equal(command, 'library_update_settings');
    patches.push(args.settings);
    if (patches.length === 1) await gate;
    persisted = { ...persisted, ...args.settings };
    return { ...persisted };
  }, async service => {
    const editing = service.updateLibrarySettings({ openAlexEnabled: false, autoRenameFiles: true });
    const importing = saveImportDirectory(service.updateLibrarySettings, staleSettings, 'selected-Zotero');
    release(); await Promise.all([editing, importing]);
    assert.deepEqual(persisted, { openAlexEnabled: false, autoRenameFiles: true, zoteroLocalDataDir: 'selected-Zotero' });
    assert.deepEqual(patches[1], { zoteroLocalDataDir: 'selected-Zotero' });
  });
});
