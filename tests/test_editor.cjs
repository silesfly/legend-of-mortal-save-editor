'use strict';
/**
 * tests/test_editor.cjs
 *
 * Node test suite (node:test + node:assert/strict) for the codec / catalog /
 * editor-core modules of the Legend of Mortal save editor.
 *
 * Run with:   node --test tests/test_editor.cjs
 * Or:         node tests/test_editor.cjs   (standalone; exits 0 on pass)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let nrbf, catalogMod, editor;
try {
  nrbf       = require('../src/nrbf-codec.js');
  catalogMod = require('../src/catalog-data.js');
  editor     = require('../src/editor-core.js');
} catch (err) {
  console.error('FATAL: could not load editor modules:', err && err.message ? err.message : err);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const HANZI_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const KANA_RE  = /[\u3040-\u30FF]/g;

function getCatalog() {
  if (catalogMod.Catalog) return catalogMod.Catalog;
  if (catalogMod.catalog) return catalogMod.catalog;
  return catalogMod;
}

/* Call editor-core's validate() flexibly — it may be an exported function
 * or a per-state method.  Always returns a result object with `.ok`. */
function doValidate(state) {
  if (typeof editor.validate === 'function') {
    const r = editor.validate(state);
    if (r && typeof r === 'object' && 'ok' in r) return r;
  }
  if (typeof state.validate === 'function') {
    const r = state.validate();
    if (r && typeof r === 'object' && 'ok' in r) return r;
  }
  throw new Error('No validate() available on editor or state');
}

function doDiff(state) {
  if (typeof editor.computeDiff === 'function') return editor.computeDiff(state);
  if (typeof state.computeDiff === 'function') return state.computeDiff();
  throw new Error('No computeDiff() available');
}

function doApplyPreset(state, name) {
  if (typeof editor.applyPreset === 'function') return editor.applyPreset(state, name);
  if (typeof state.applyPreset === 'function') return state.applyPreset(name);
  throw new Error('No applyPreset() available');
}

function doExport(state) {
  if (typeof editor.exportSave === 'function') return editor.exportSave(state);
  if (typeof state.exportSave === 'function') return state.exportSave();
  throw new Error('No exportSave() available');
}

/* Count how many entries are considered "unlocked" in a library payload. */
function countUnlocked(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) {
    let count = 0;
    for (const item of v) {
      if (item === true) { count++; continue; }
      if (item && typeof item === 'object') {
        if (Number(item.count) > 0) { count++; continue; }
        if (item.unlocked === true) { count++; continue; }
        if (item.owned === true)    { count++; continue; }
      }
    }
    return count;
  }
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    if (typeof v.unlocked === 'number') return v.unlocked;
    if (Array.isArray(v.unlocked)) return v.unlocked.filter(x => x === true).length;
    if (typeof v.count === 'number') return v.count;
    const ids = Object.keys(v);
    let count = 0;
    for (const k of ids) {
      if (v[k] === true) count++;
    }
    return count;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* 1) Catalog integrity                                                */
/* ------------------------------------------------------------------ */

test('Catalog: sizes and language cleanliness', () => {
  const C = getCatalog();
  assert.ok(Array.isArray(C.stats),                    'Catalog.stats must be an array');
  assert.ok(Array.isArray(C.relationships),            'Catalog.relationships must be an array');
  assert.ok(Array.isArray(C.books),                    'Catalog.books must be an array');
  assert.ok(Array.isArray(C.library),                  'Catalog.library must be an array');

  assert.ok(C.stats.length         >= 55, 'stats.length ('        + C.stats.length         + ') >= 55');
  assert.ok(C.relationships.length >= 40, 'relationships.length ('+ C.relationships.length + ') >= 40');
  assert.ok(C.books.length         >= 100,'books.length ('        + C.books.length         + ') >= 100');
  assert.ok(C.library.length       >= 210,'library.length ('      + C.library.length       + ') >= 210');

  const blob = JSON.stringify(C);
  const hazhiMatches = blob.match(HANZI_RE) || [];
  const kanaMatches  = blob.match(KANA_RE)  || [];
  assert.equal(hazhiMatches.length, 0,
    'Catalog contains Hanzi characters (expected 0): ' + hazhiMatches.slice(0, 8).join(', '));
  assert.equal(kanaMatches.length, 0,
    'Catalog contains Kana characters (expected 0): '  + kanaMatches.slice(0, 8).join(', '));
});

/* ------------------------------------------------------------------ */
/* 2) Synthetic GameSave round-trip + presets + validation             */
/* ------------------------------------------------------------------ */

test('GameSave: demo bytes, presets, export, reload, validation', () => {
  const raw = editor.createDemoSaveBytes('GameSave');
  assert.ok(raw && (Buffer.isBuffer(raw) || raw instanceof Uint8Array),
    'createDemoSaveBytes("GameSave") must return a Buffer/Uint8Array');

  const state = editor.loadSaveBuffer(raw);
  assert.equal(state.kind, 'GameSave', 'kind must be "GameSave"');
  assert.equal(doValidate(state).ok, true, 'fresh GameSave must validate');

  const presets = [
    'rich_start',
    'hero_all_100',
    'martial_master',
    'tangmen_prosperity',
    'full_favorability',
  ];
  for (const name of presets) {
    doApplyPreset(state, name);
    const diff = doDiff(state);
    assert.ok(Array.isArray(diff) && diff.length > 0,
      'computeDiff after preset "' + name + '" should be non-empty');
    assert.equal(doValidate(state).ok, true,
      'state must still validate after preset "' + name + '"');
  }

  const outBytes = doExport(state);
  assert.ok(outBytes && (Buffer.isBuffer(outBytes) || outBytes instanceof Uint8Array),
    'exportSave() must return a Buffer/Uint8Array');

  const reloaded = editor.loadSaveBuffer(outBytes);
  assert.equal(reloaded.kind, 'GameSave');
  const getStat = (st, key) => (st.stats || []).find(s => s.key === key);
  assert.equal(getStat(reloaded, 'money')?.value, 99999, 'money stat must be 99999 after rich_start preset');
  assert.equal(doValidate(reloaded).ok, true, 'reloaded save must validate');

  /* --- negative stats => invalid --- */
  {
    const bad = editor.loadSaveBuffer(outBytes);
    const m = getStat(bad, 'money');
    assert.ok(m, 'GameSave must have money stat');
    m.value = -1;
    assert.equal(doValidate(bad).ok, false, 'negative value in money stat must fail validate');
  }

  /* --- out-of-range assets --- */
  {
    const bad = editor.loadSaveBuffer(outBytes);
    const a = getStat(bad, 'assets');
    assert.ok(a, 'GameSave must have assets stat');
    a.value = 100000;
    assert.equal(doValidate(bad).ok, false, 'assets = 100000 (out of range) must fail validate');
  }

  /* --- out-of-range contribution --- */
  {
    const bad = editor.loadSaveBuffer(outBytes);
    let c = getStat(bad, 'contribution');
    if (!c) { c = { key: 'contribution', value: -250, name: '공헌도' }; bad.stats.push(c); }
    else c.value = -250;
    assert.equal(doValidate(bad).ok, false, 'contribution = -250 (out of range) must fail validate');
  }
});

/* ------------------------------------------------------------------ */
/* 3) Synthetic UniverseSave library unlock                            */
/* ------------------------------------------------------------------ */

test('UniverseSave: unlock_all_library produces >= 210 unlocked items', () => {
  const raw = editor.createDemoSaveBytes('UniverseSave');
  assert.ok(raw && (Buffer.isBuffer(raw) || raw instanceof Uint8Array),
    'createDemoSaveBytes("UniverseSave") must return a Buffer/Uint8Array');

  let state = editor.loadSaveBuffer(raw);
  assert.equal(state.kind, 'UniverseSave', 'kind must be "UniverseSave"');

  doApplyPreset(state, 'unlock_all_library');

  const outBytes = doExport(state);
  state = editor.loadSaveBuffer(outBytes);
  assert.equal(state.kind, 'UniverseSave');

  const libs = ['library1', 'library2', 'library3', 'library4'];
  let total = 0;
  for (const key of libs) {
    total += countUnlocked((state.universe && state.universe[key]) || []);
  }
  assert.ok(total >= 210,
    'Total unlocked items across library1..library4 (' + total + ') must be >= 210');
});

/* ------------------------------------------------------------------ */
/* 4) Real saves regression (if fixture directory exists)              */
/* ------------------------------------------------------------------ */

const REAL_DIR = '/tmp/lom_real_saves_ro';

test('Real saves: parseNrbf -> serializeNrbf byte-identical + round-trip', (t) => {
  if (!fs.existsSync(REAL_DIR)) {
    t.skip('fixture directory ' + REAL_DIR + ' not present');
    return;
  }
  const entries = fs.readdirSync(REAL_DIR).filter(f => f.toLowerCase().endsWith('.dat'));
  if (entries.length === 0) {
    t.skip('no *.dat saves found in ' + REAL_DIR);
    return;
  }

  for (const name of entries) {
    const full = path.join(REAL_DIR, name);
    const original = fs.readFileSync(full);

    /* --- NRBF byte-identical up to streamEndOffset --- */
    const doc = nrbf.parseNrbf(original);
    assert.ok(doc && typeof doc === 'object', name + ': parseNrbf must return a document');
    const end = (typeof doc.streamEndOffset === 'number') ? doc.streamEndOffset : original.length;
    const reencoded = nrbf.serializeNrbf(doc);
    const a = Buffer.from(original.slice(0, end));
    const b = Buffer.from(reencoded.slice(0, end));
    assert.equal(a.length, b.length, name + ': re-encoded length (up to streamEndOffset) mismatch');
    assert.ok(a.equals(b),
      name + ': serializeNrbf(parseNrbf(x)) must be byte-identical up to streamEndOffset');

    /* --- semantic round-trip through editor-core --- */
    const state1 = editor.loadSaveBuffer(original);
    const out    = doExport(state1);
    const state2 = editor.loadSaveBuffer(out);
    assert.equal(state2.kind, state1.kind,
      name + ': kind must survive load->export->load');
    assert.equal(doValidate(state2).ok, true,
      name + ': re-loaded state must validate');
  }

  /* --- edited round-trip across all 4 save formats on real saves --- */
  const formatChecks = [
    ['Save_001.dat', (s) => { doApplyPreset(s, 'rich_start'); }, (s2) => assert.equal(s2.stats.find(x => x.key === 'money')?.value, 99999)],
    ['Save_auto.dat', (s) => { doApplyPreset(s, 'rich_start'); }, (s2) => assert.equal(s2.stats.find(x => x.key === 'money')?.value, 99999)],
    ['Legend_001.dat', (s) => { s.legend.endKey = '999'; }, (s2) => assert.equal(s2.legend.endKey, '999')],
    ['Save_universe.dat', (s) => { doApplyPreset(s, 'unlock_all_library'); }, (s2) => assert.ok(countUnlocked(s2.universe.library2) >= 60)],
  ];
  for (const [fname, mutFn, verifyFn] of formatChecks) {
    const fp = path.join(REAL_DIR, fname);
    if (!fs.existsSync(fp)) continue;
    const s = editor.loadSaveBuffer(fs.readFileSync(fp), fname);
    mutFn(s);
    const s2 = editor.loadSaveBuffer(doExport(s), fname);
    assert.equal(doValidate(s2).ok, true, fname + ': edited state must validate');
    verifyFn(s2);
  }
});
