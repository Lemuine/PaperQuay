import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');

// Based on the title-matching regression cases in Ferryyer/PaperQuay f176821.
const title = 'ECHO: Prune To Act, Trace To Learn With Selective Turn Memory In Agentic RL';
const unrelated = {
  title: ['ECHO: A Journal of Higher Learning'],
  DOI: '10.2307/40253463',
  issued: { 'date-parts': [[2006]] },
  'container-title': ['Academe'],
};
const matching = {
  title: [title],
  DOI: '10.1234/matching',
  issued: { 'date-parts': [[2026]] },
};

function commands() {
  return createLibraryCommands({
    appPaths: {},
    store: { load: () => ({ settings: { openAlexEnabled: false } }) },
  });
}

function mockSearch(t, items) {
  t.mock.method(globalThis, 'fetch', async (endpoint) => {
    const url = new URL(endpoint);
    assert.equal(url.origin, 'https://api.crossref.org');
    assert.equal(url.pathname, '/works');
    assert.equal(url.searchParams.get('query.title'), title);
    return new Response(JSON.stringify({ message: { items } }));
  });
}

test('Crossref title lookup rejects an unrelated first result and its incorrect year', async (t) => {
  mockSearch(t, [unrelated]);
  assert.equal(await commands().lookup_literature_metadata({ request: { title } }), null);
});

test('Crossref title lookup requests several candidates and finds a later matching title', async (t) => {
  mockSearch(t, [unrelated, matching]);
  const result = await commands().lookup_literature_metadata({ request: { title } });
  assert.equal(result?.title, title);
  assert.equal(result?.year, '2026');
  assert.equal(result?.doi, matching.DOI);
  const endpoint = globalThis.fetch.mock.calls[0].arguments[0];
  assert.equal(new URL(endpoint).searchParams.get('rows'), '5');
});

test('Crossref title lookup chooses the strongest match rather than the first plausible hit', async (t) => {
  const similar = { ...unrelated, title: [title.replace('Agentic RL', 'Agentic Learning')] };
  mockSearch(t, [similar, matching]);
  const result = await commands().lookup_literature_metadata({ request: { title } });
  assert.equal(result?.doi, matching.DOI);
  assert.equal(result?.year, '2026');
});

test('Crossref title lookup leaves missing results empty', async (t) => {
  mockSearch(t, []);
  assert.equal(await commands().lookup_literature_metadata({ request: { title } }), null);
});

test('Crossref DOI lookup remains authoritative without a matching preview title', async (t) => {
  t.mock.method(globalThis, 'fetch', async (endpoint) => {
    assert.equal(endpoint, 'https://api.crossref.org/works/10.1234%2Fmatching');
    return new Response(JSON.stringify({ message: matching }));
  });
  const result = await commands().lookup_literature_metadata({
    request: { doi: matching.DOI, title: 'A low quality local preview title' },
  });
  assert.equal(result?.title, title);
  assert.equal(result?.doi, matching.DOI);
});
