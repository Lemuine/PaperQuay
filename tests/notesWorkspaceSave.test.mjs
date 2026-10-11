import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

async function withNotesStore(invoke, check) {
  const server = await createServer({ configFile: false, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
  const previousWindow = globalThis.window;
  globalThis.window = { paperquay: { invoke }, dispatchEvent() {} };
  try {
    const { useNotesStore } = await server.ssrLoadModule('/src/stores/useNotesStore.ts');
    useNotesStore.setState({ notes: [{ id: 'alpha', title: 'Alpha', updatedAt: 1 }, { id: 'beta', title: 'Beta', updatedAt: 2 }], activeNoteId: 'alpha' });
    await check(useNotesStore);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
}

test('a delayed workspace save does not select its note over the user selection', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await withNotesStore(async (command, args) => {
    if (command === 'notes_tags') return [];
    assert.equal(command, 'notes_update'); assert.equal(args.id, 'alpha');
    await gate;
    return { id: 'alpha', title: 'Saved Alpha', updatedAt: 3 };
  }, async store => {
    const save = store.getState().updateWorkspaceNote('alpha', { title: 'Saved Alpha' });
    assert.equal(store.getState().saving, true);
    store.getState().setActiveNoteId('beta');
    release(); await save;
    assert.equal(store.getState().activeNoteId, 'beta');
    assert.equal(store.getState().notes.find(note => note.id === 'alpha').title, 'Saved Alpha');
    assert.equal(store.getState().notes.find(note => note.id === 'beta').title, 'Beta');
    assert.equal(store.getState().saving, false);
  });
});

test('a failed workspace save leaves the record and selection unchanged and allows retry', async () => {
  let fail = true;
  await withNotesStore(async command => {
    if (command === 'notes_tags') return [];
    assert.equal(command, 'notes_update');
    if (fail) throw new Error('Fixture save failure');
    return { id: 'alpha', title: 'Retried Alpha', updatedAt: 3 };
  }, async store => {
    const before = store.getState().notes;
    await assert.rejects(store.getState().updateWorkspaceNote('alpha', { title: 'Retried Alpha' }), /Fixture save failure/);
    assert.equal(store.getState().notes, before);
    assert.equal(store.getState().activeNoteId, 'alpha');
    assert.equal(store.getState().saving, false);
    assert.equal(store.getState().error, 'Fixture save failure');
    fail = false;
    await store.getState().updateWorkspaceNote('alpha', { title: 'Retried Alpha' });
    assert.equal(store.getState().error, '');
    assert.equal(store.getState().notes.find(note => note.id === 'alpha').title, 'Retried Alpha');
  });
});
