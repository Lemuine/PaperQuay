import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNoteStore } = require('../electron/backend/noteStore.cjs');
const { createNoteCommands } = require('../electron/backend/noteCommands.cjs');
const { DatabaseSync, withTransaction } = require('../electron/backend/nodeSqlite.cjs');
const { createKnowledgeGraphSnapshot } = require('../electron/backend/knowledgeGraphCommands.cjs');

function fixture(t, count = 35005) {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-notes-full-'));
  const appPaths = { dataDir: root, notesDatabasePath: path.join(root, 'notes.sqlite') };
  createNoteStore(appPaths).close();
  const db = new DatabaseSync(appPaths.notesDatabasePath);
  const insert = db.prepare(`INSERT INTO notes
    (id, paper_id, type, title, content, color, created_at, updated_at, deleted_at, is_pinned, linked_paper_id)
    VALUES (?, ?, ?, ?, ?, '#ffffff', ?, ?, ?, ?, ?)`);
  withTransaction(db, () => {
    for (let index = 0; index < count; index++) {
      insert.run(`note-${index}`, index % 2 ? 'paper-b' : 'paper-a', index % 2 ? 'area' : 'standalone',
        `Note ${String(index).padStart(5, '0')}`, `Body ${index}`, index + 1, index + 1,
        index === 3 ? 1 : null, index === 0 ? 1 : 0, index === count - 1 ? 'linked-paper' : null);
    }
    db.prepare('INSERT INTO note_tags (note_id, tag) VALUES (?, ?)').run(`note-${count - 1}`, 'Rare');
    db.prepare('INSERT INTO note_paper_links (note_id, paper_id) VALUES (?, ?)').run(`note-${count - 1}`, 'second-paper');
    db.prepare('INSERT INTO note_links (source_note_id, target_note_id, link_text) VALUES (?, ?, ?)')
      .run(`note-${count - 1}`, 'note-0', 'Oldest pinned note');
  });
  const before = db.prepare('SELECT * FROM notes ORDER BY id').all();
  db.close();
  const store = createNoteStore(appPaths);
  t.after(() => {
    store.close();
    const check = new DatabaseSync(appPaths.notesDatabasePath, { readOnly: true });
    try { assert.deepEqual(check.prepare('SELECT * FROM notes ORDER BY id').all(), before); }
    finally { check.close(); rmSync(root, { recursive: true, force: true }); }
  });
  return { store, count, appPaths, commands: createNoteCommands({ noteStore: store }) };
}

test('full-note queries pass 1000, 5000 and SQLite parameter limits without truncating or writing records', t => {
  const { commands, store, count } = fixture(t);
  const all = commands.notes_list_all();
  assert.equal(all.length, count - 1);
  assert.equal(new Set(all.map(note => note.id)).size, count - 1);
  assert.equal(all[0].id, 'note-0');
  assert.equal(all[1].id, `note-${count - 1}`);
  assert.equal(all.at(-1).id, 'note-1');
  assert.deepEqual(all[1].tags, ['Rare']);
  assert.deepEqual(all[1].linkedPaperIds, ['second-paper']);
  assert.deepEqual(all[1].linkedNoteIds, ['note-0']);
  assert.equal(all[0].backlinks[0].sourceNoteId, `note-${count - 1}`);
  assert.equal(commands.notes_list({ request: {} }).length, 500);
  assert.equal(commands.notes_list({ request: { limit: 1000 } }).length, 1000);
  assert.equal(store.listNotes({ limit: count }).length, 5000);
});

test('full-note filters and deleted-note visibility match the existing bounded query', t => {
  const { commands, store, count } = fixture(t, 1105);
  for (const request of [
    { paperId: 'paper-a' }, { type: 'area' }, { tag: '#rare' },
    { search: 'Body 11' }, { linkedPaperId: 'linked-paper' },
    { paperId: 'paper-a', type: 'standalone', search: 'Body 10' },
    { search: 'no such note' }, { includeDeleted: true, search: 'Note 00003' },
  ]) {
    assert.deepEqual(commands.notes_list_all({ request }), store.listNotes({ ...request, limit: 5000 }));
  }
  assert.equal(commands.notes_list_all({ request: { includeDeleted: true } }).length, count);
  assert.equal(commands.notes_list_all({ request: { search: 'Note 00003' } }).length, 0);
});

test('graph search finds a note outside the old 5000-note candidate window', t => {
  const { store, appPaths } = fixture(t, 5005);
  const snapshot = createKnowledgeGraphSnapshot({
    appPaths, store: { load: () => ({ papers: [], categories: [] }), loadAllReferences: () => [] },
    noteStore: store, ragStore: { available: false },
  }, { includeNotes: true, search: 'Note 00001' });
  assert.ok(snapshot.nodes.some(node => node.noteId === 'note-1'));
});
