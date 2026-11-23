const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const sidepanelSource = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8');

function createContext() {
  const event = { addListener() {} };
  const chrome = {
    runtime: { onInstalled: event, onStartup: event, onMessage: event },
    alarms: { onAlarm: event, get: async () => null, create() {} },
    storage: { onChanged: event, local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: { onUpdated: event }
  };
  const context = vm.createContext({ chrome, importScripts() {}, atob, TextDecoder, Uint8Array });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  // Load only the pure profile-normalization/merge helpers from sidepanel.js;
  // the rest of the side panel depends on the Chrome DOM and is not needed here.
  const start = sidepanelSource.indexOf('function normalizeProfileQueryGroups');
  const end = sidepanelSource.indexOf('function getProfileByKey', start);
  assert.ok(start >= 0 && end > start, 'profile helper section should exist');
  vm.runInContext(sidepanelSource.slice(start, end), context, { filename: 'sidepanel-profile-helpers.js' });
  const writerStart = sidepanelSource.indexOf('function slugify');
  const writerEnd = sidepanelSource.indexOf('function downloadJsonFile', writerStart);
  assert.ok(writerStart >= 0 && writerEnd > writerStart, 'profile serialization helpers should exist');
  vm.runInContext(sidepanelSource.slice(writerStart, writerEnd), context, { filename: 'sidepanel-profile-writer.js' });
  return context;
}

const context = createContext();

 test('remote profile normalization keeps queryGroupsRevision', () => {
  const normalized = vm.runInContext(`normalizeRemoteProfile({
    id: 'argentina', name: 'Аргентина', queryGroupsRevision: 2,
    queryGroups: [{ id: 'main', name: 'Основные запросы', queries: ['новый запрос'] }]
  }, 0)`, context);

  assert.equal(normalized.queryGroupsRevision, 2);
});

test('revisioned GitHub query groups remain authoritative over bundled defaults', () => {
  const result = vm.runInContext(`(() => {
    const remote = normalizeRemoteProfile({
      id: 'argentina', name: 'Аргентина', queryGroupsRevision: 2,
      queryGroups: [{ id: 'main', name: 'Основные запросы', queries: ['запрос из GitHub'] }]
    }, 0);
    const bundled = {
      id: 'argentina', name: 'Аргентина', queryGroupsRevision: 2,
      queryGroups: [
        { id: 'main', name: 'Основные запросы', queries: ['старый встроенный запрос'] },
        { id: 'extra', name: 'Старая группа', queries: ['старый дополнительный запрос'] }
      ]
    };
    return mergeStandardProfiles([remote], [bundled]);
  })()`, context);

  assert.equal(result[0].queryGroups.length, 1);
  assert.deepEqual(Array.from(result[0].queryGroups[0].queries), ['запрос из GitHub']);
  assert.deepEqual(Array.from(result[0].queries), ['запрос из GitHub']);
});

test('legacy profiles without a revision migrate defaults and retain GitHub-only extras', () => {
  const result = vm.runInContext(`(() => {
    const remote = normalizeRemoteProfile({
      id: 'argentina', name: 'Аргентина',
      queryGroups: [{ id: 'main', name: 'Основные запросы', queries: ['старый запрос'] }]
    }, 0);
    const bundled = {
      id: 'argentina', name: 'Аргентина', queryGroupsRevision: 2,
      queryGroups: [{ id: 'main', name: 'Основные запросы', queries: ['новый встроенный запрос'] }]
    };
    return mergeStandardProfiles([remote], [bundled]);
  })()`, context);

  assert.deepEqual(Array.from(result[0].queries), ['новый встроенный запрос', 'старый запрос']);
  assert.equal(result[0].queryGroups.length, 2);
});

test('invalid queryGroupsRevision is rejected instead of silently downgrading', () => {
  assert.throws(() => vm.runInContext(`normalizeRemoteProfile({
    id: 'argentina', name: 'Аргентина', queryGroupsRevision: 101
  }, 0)`, context), /queryGroupsRevision/);
});

test('forced GitHub sync persists the revision marker in the local profile cache', async () => {
  const stored = {};
  const remoteConfig = {
    schemaVersion: 1,
    profiles: [{
      id: 'argentina', name: 'Аргентина', queryGroupsRevision: 2,
      queryGroups: [{ id: 'main', name: 'Основные запросы', queries: ['сохранённый запрос'] }]
    }]
  };
  context.GITHUB_CONFIG = {
    owner: 'test-owner', repository: 'test-repo', branch: 'main',
    standardProfilesPath: 'config/standard-profiles.json'
  };
  context.fetch = async () => ({ ok: true, text: async () => JSON.stringify(remoteConfig) });
  context.chrome.storage.local.get = async (defaults) => ({ ...defaults, ...stored });
  context.chrome.storage.local.set = async (values) => Object.assign(stored, values);

  const result = await vm.runInContext('syncStandardProfiles(true)', context);

  assert.equal(result.ok, true);
  assert.equal(stored.standardProfiles[0].queryGroupsRevision, 2);
  assert.deepEqual(Array.from(stored.standardProfiles[0].queryGroups[0].queries), ['сохранённый запрос']);
});


test('GitHub profile serialization writes the current query-group revision', () => {
  const entry = vm.runInContext(`profileToConfigEntry({
    id: 'argentina', name: 'Аргентина', interfaceLang: 'es', resultLangs: 'es', region: 'AR',
    queryGroups: [{ id: 'main', name: 'Основные запросы', queries: ['проверочный запрос'] }]
  }, 'argentina')`, context);

  assert.equal(entry.queryGroupsRevision, 2);
  assert.deepEqual(Array.from(entry.queries), ['проверочный запрос']);
});

test('forced sync reads through GitHub Contents API when a token exists (avoids stale raw CDN)', async () => {
  const stored = { githubToken: 'test-token' };
  const freshConfig = {
    schemaVersion: 1,
    profiles: [{
      id: 'argentina', name: 'Аргентина', queryGroupsRevision: 2,
      queryGroups: [{ id: 'main', name: 'Основные запросы', queries: ['самый новый запрос после commit'] }]
    }]
  };
  const bytes = new TextEncoder().encode(JSON.stringify(freshConfig));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  context.GITHUB_CONFIG = {
    owner: 'test-owner', repository: 'test-repo', branch: 'main',
    standardProfilesPath: 'config/standard-profiles.json'
  };
  context.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/test-owner\/test-repo\/contents\//);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return { ok: true, json: async () => ({ encoding: 'base64', content: base64 }) };
  };
  context.chrome.storage.local.get = async (defaults) => ({ ...defaults, ...stored });
  context.chrome.storage.local.set = async (values) => Object.assign(stored, values);

  const result = await vm.runInContext('syncStandardProfiles(true)', context);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(stored.standardProfiles[0].queryGroups[0].queries), ['самый новый запрос после commit']);
});

test('manual Check Updates forces standard profile sync', () => {
  assert.match(sidepanelSource, /const syncResult = await requestStandardSync\(!silent, true\)/);
});
