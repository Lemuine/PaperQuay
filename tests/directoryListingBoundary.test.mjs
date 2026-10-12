import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const sourceUrl = new URL('../electron/backend/fileCommands.cjs', import.meta.url);
const require = createRequire(sourceUrl);
const { createAppPaths } = require('./libraryStore.cjs');
const { isWithin, resolveAuthorizedPath } = require('./pathAccess.cjs');
const nativeFs = require('./nativeFs.cjs');

function fixture(t) {
  // macOS's per-user temporary path can exceed the Unix socket name limit.
  // A short, unique fixture keeps the real special-file coverage enabled.
  const temporaryBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryBase, 'pq-directory-listing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, 'shared'), outside = path.join(root, 'outside');
  fs.mkdirSync(shared); fs.mkdirSync(outside);
  const appPaths = createAppPaths({ getPath: () => path.join(root, 'profile') }, shared);
  let approvals = 0;
  const context = { appPaths, approvedWritePaths: new Set(), store: { load: () => ({ settings: {} }) },
    authorizeLocalRead: (target) => {
      approvals++;
      return resolveAuthorizedPath(target, (candidate) => isWithin(shared, candidate));
    } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourceUrl, 'utf8'), {
    require: (name) => name === 'electron'
      ? { dialog: { showMessageBox: async () => ({ response: 1 }) } } : require(name),
    module, process, Buffer,
  });
  const commands = module.exports.createFileCommands(context);
  const link = (target, alias) => fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, shared, outside, appPaths, context, commands, link, approvals: () => approvals };
}

function trapPathnameProbes(t) {
  let probes = 0;
  for (const name of ['readdir', 'stat', 'readFile']) {
    const original = fsp[name];
    fsp[name] = () => { probes++; throw new Error('Unexpected pathname probe'); };
    t.after(() => { fsp[name] = original; });
  }
  const originalOpen = nativeFs.openRead;
  nativeFs.openRead = () => { probes++; throw new Error('Metadata listing must not open file contents'); };
  t.after(() => { nativeFs.openRead = originalOpen; });
  return () => probes;
}

test('ordinary metadata listing retains filtering, sorting, sizes, hidden files and missing-root behavior', async (t) => {
  const f = fixture(t), directory = path.join(f.appPaths.mineruCacheDir, 'document-safe');
  fs.mkdirSync(directory, { recursive: true });
  const times = { 'new.PDF': 1700000010, 'a.pdf': 1700000000, 'b.pdf': 1700000000,
    '.hidden.pdf': 1699999990, 'skip.txt': 1699999980 };
  for (const [name, seconds] of Object.entries(times)) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, name);
    fs.utimesSync(file, seconds, seconds);
  }
  fs.mkdirSync(path.join(directory, 'nested.pdf'));
  f.link(f.outside, path.join(directory, 'linked.pdf'));
  const probes = trapPathnameProbes(t);
  const entries = await f.commands.list_directory_files({ directory, extensionFilter: ' .PDF ' });
  assert.deepEqual(Array.from(entries, (entry) => entry.name), ['new.PDF', 'a.pdf', 'b.pdf', '.hidden.pdf']);
  for (const entry of entries) {
    assert.equal(entry.path, path.join(directory, entry.name));
    assert.equal(entry.size, Buffer.byteLength(entry.name));
    assert.ok(Math.abs(entry.modifiedAtMs - times[entry.name] * 1000) < 1);
  }
  assert.equal((await f.commands.list_directory_files({ directory })).length, 5);
  assert.equal((await f.commands.list_directory_files({ directory: path.join(directory, 'absent') })).length, 0);
  await assert.rejects(f.commands.list_directory_files({ directory: path.join(directory, 'new.PDF') }));
  assert.equal(probes(), 0);
});

test('a supplier cache directory link cannot enumerate an outside target', async (t) => {
  const f = fixture(t), alias = path.join(f.appPaths.mineruCacheDir, 'document-linked');
  fs.mkdirSync(f.appPaths.mineruCacheDir, { recursive: true });
  fs.writeFileSync(path.join(f.outside, 'private.pdf'), 'outside fixture');
  f.link(f.outside, alias);
  const probes = trapPathnameProbes(t);
  await assert.rejects(f.commands.list_directory_files({ directory: alias }), /not approved|not allowed|linked/);
  assert.equal(f.approvals(), 1);
  assert.equal(probes(), 0);
});

test('raw unapproved network and malformed paths fail before native enumeration or pathname probing', async (t) => {
  const f = fixture(t), originalList = nativeFs.listFiles;
  let enumerations = 0;
  nativeFs.listFiles = (...args) => { enumerations++; return originalList(...args); };
  t.after(() => { nativeFs.listFiles = originalList; });
  f.context.authorizeLocalRead = () => { throw new Error('Raw directory is not approved'); };
  const probes = trapPathnameProbes(t);
  const network = process.platform === 'win32' ? '\\\\paperquay-never-contact.invalid\\share' : '/unapproved/share';
  for (const directory of [network, '', 'relative/directory', '/invalid\0path',
    ...(process.platform === 'win32' ? ['\\\\?\\C:\\private', '\\\\.\\pipe\\private', 'C:relative'] : [])]) {
    await assert.rejects(f.commands.list_directory_files({ directory }), /not approved|Invalid import source/);
  }
  assert.equal(enumerations, 0);
  assert.equal(probes(), 0);
});

test('a canonical cache directory replaced after authorization is rejected without following its network link', async (t) => {
  const f = fixture(t), directory = path.join(f.appPaths.mineruCacheDir, 'document-race');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'safe.pdf'), 'safe');
  const originalList = nativeFs.listFiles;
  let attempted = false;
  nativeFs.listFiles = (actual) => {
    assert.equal(actual, directory);
    attempted = true;
    fs.renameSync(directory, directory + '-old');
    const target = process.platform === 'win32' ? '\\\\paperquay-never-contact.invalid\\share' : f.outside;
    fs.symlinkSync(target, directory, 'dir');
    assert.equal(nativeFs.inspectSync(directory).linkPath, directory);
    return originalList(actual);
  };
  t.after(() => { nativeFs.listFiles = originalList; });
  const probes = trapPathnameProbes(t);
  await assert.rejects(f.commands.list_directory_files({ directory }), /path changed|linked/);
  assert.equal(attempted, true);
  assert.equal(probes(), 0);
});

test('a prepared custom cache alias keeps its approved actual directory after retargeting', async (t) => {
  const f = fixture(t), custom = path.join(f.root, 'custom'), alias = path.join(f.root, 'custom-alias');
  fs.mkdirSync(path.join(custom, 'document-safe'), { recursive: true });
  fs.writeFileSync(path.join(custom, 'document-safe', 'annotation.pdf'), 'approved annotation');
  fs.mkdirSync(path.join(f.outside, 'document-safe'));
  fs.writeFileSync(path.join(f.outside, 'document-safe', 'private.pdf'), 'outside fixture');
  f.link(custom, alias);
  const prepared = await f.commands.prepare_mineru_cache_dir({ directory: alias });
  assert.equal(prepared.directory, fs.realpathSync.native(custom));
  fs.unlinkSync(alias); f.link(f.outside, alias);
  const probes = trapPathnameProbes(t);
  const entries = await f.commands.list_directory_files({ directory: path.join(alias, 'document-safe'), extensionFilter: 'pdf' });
  assert.deepEqual(Array.from(entries, (entry) => entry.name), ['annotation.pdf']);
  assert.equal(entries[0].path, path.join(custom, 'document-safe', 'annotation.pdf'));
  assert.equal(f.approvals(), 0);
  assert.equal(probes(), 0);
});

test('native metadata enumeration skips leaf symlinks and POSIX special files without opening them', async (t) => {
  const f = fixture(t), directory = path.join(f.shared, 'ordinary');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'regular.pdf'), 'regular');
  const link = path.join(directory, 'leaf-link.pdf');
  fs.symlinkSync(path.join(directory, 'regular.pdf'), link, 'file');
  let server;
  if (process.platform !== 'win32') {
    server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(directory, 'socket.pdf'), resolve);
    });
    fs.chmodSync(path.join(directory, 'regular.pdf'), 0);
  }
  try {
    const probes = trapPathnameProbes(t);
    const entries = await f.commands.list_directory_files({ directory });
    assert.deepEqual(Array.from(entries, (entry) => entry.name), ['regular.pdf']);
    assert.equal(probes(), 0);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (process.platform !== 'win32') fs.chmodSync(path.join(directory, 'regular.pdf'), 0o600);
  }
  if (process.platform !== 'win32') {
    const ancestor = path.join(f.shared, 'traverse-only'), target = path.join(ancestor, 'listable');
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'permission-control.pdf'); fs.writeFileSync(file, 'metadata only');
    fs.chmodSync(file, 0); fs.chmodSync(ancestor, 0o111); fs.chmodSync(target, 0o555);
    try {
      assert.deepEqual(fs.readdirSync(target), ['permission-control.pdf']);
      assert.equal(fs.statSync(file).size, 13);
      assert.equal(nativeFs.inspectSync(file).size, 13);
      const entries = await f.commands.list_directory_files({ directory: target });
      assert.deepEqual(Array.from(entries, (entry) => entry.name), ['permission-control.pdf']);
    } finally {
      fs.chmodSync(ancestor, 0o755); fs.chmodSync(target, 0o755); fs.chmodSync(file, 0o600);
    }
  }
});
