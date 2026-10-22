import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const LOCALES = ['en', 'zh_CN', 'zh_TW'];
const rootUrl = new URL('../', import.meta.url);

function catalogUrl(locale) {
  return new URL(`_locales/${locale}/messages.json`, rootUrl);
}

function loadCatalogs() {
  return Object.fromEntries(
    LOCALES.map((locale) => [locale, JSON.parse(readFileSync(catalogUrl(locale), 'utf8'))]));
}

// Placeholder names mapped to their substitution refs (e.g. { count: '$1' }).
function placeholders(message) {
  return Object.fromEntries(Object.entries(message.placeholders ?? {})
    .map(([name, placeholder]) => [name, placeholder.content]));
}

// All message keys referenced by manifest.json (__MSG_key__) or runtime code
// (chrome.i18n.getMessage('key', ...)).
function referencedKeys() {
  const referenced = new Set();
  const manifest = readFileSync(new URL('manifest.json', rootUrl), 'utf8');
  for (const match of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) referenced.add(match[1]);

  const sources = [readFileSync(new URL('background.js', rootUrl), 'utf8')];
  const contentDir = new URL('content/', rootUrl);
  for (const file of readdirSync(contentDir)) {
    if (file.endsWith('.js')) sources.push(readFileSync(new URL(file, contentDir), 'utf8'));
  }
  for (const source of sources) {
    for (const match of source.matchAll(/getMessage\('([^']+)'/g)) referenced.add(match[1]);
  }
  return referenced;
}

test('locale catalogs parse and have identical key sets', () => {
  const catalogs = loadCatalogs();
  const expected = Object.keys(catalogs.en).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), expected, `${locale}: key set`);
  }
});

test('zh_TW is an exact copy of zh_CN', () => {
  const zhCN = readFileSync(catalogUrl('zh_CN'));
  const zhTW = readFileSync(catalogUrl('zh_TW'));
  assert.deepEqual(zhTW, zhCN, 'zh_TW bytes match zh_CN bytes');
  assert.deepEqual(JSON.parse(zhTW), JSON.parse(zhCN), 'zh_TW parsed content matches zh_CN');
});

test('placeholder names and content refs match across locales', () => {
  const catalogs = loadCatalogs();
  for (const key of Object.keys(catalogs.en)) {
    const expected = placeholders(catalogs.en[key]);
    for (const locale of LOCALES) {
      assert.deepEqual(placeholders(catalogs[locale][key]), expected, `${locale}/${key}: placeholders`);
    }
  }
});

test('messages are non-empty and en has no CJK characters', () => {
  const catalogs = loadCatalogs();
  for (const locale of LOCALES) {
    for (const [key, entry] of Object.entries(catalogs[locale])) {
      assert.equal(typeof entry.message, 'string', `${locale}/${key}: message is a string`);
      assert.ok(entry.message.length > 0, `${locale}/${key}: message is non-empty`);
    }
  }
  for (const [key, entry] of Object.entries(catalogs.en)) {
    assert.doesNotMatch(entry.message, /[一-鿿]/, `en/${key}: no CJK characters`);
  }
});

test('every referenced key exists and no catalog key is dead', () => {
  const catalogs = loadCatalogs();
  const keys = new Set(Object.keys(catalogs.en));
  const referenced = referencedKeys();

  for (const key of referenced) {
    assert.ok(keys.has(key), `referenced key "${key}" exists in the catalogs`);
  }
  for (const key of keys) {
    assert.ok(referenced.has(key), `catalog key "${key}" is referenced at least once`);
  }
});
