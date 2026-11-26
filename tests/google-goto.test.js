const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sidepanelSource = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

function extract(source, startMarker, endMarker, returnName, injected = {}) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return new Function(...Object.keys(injected), `${source.slice(start, end)}\nreturn ${returnName};`)(...Object.values(injected));
}

const gotoA = 'https://www.google.com/goto?url=CAESopaque-token-A&gsessionid=abc';
const gotoB = 'https://www.google.com/goto?url=CAESopaque-token-B&gsessionid=abc';

test('Google /goto links are resolved once per unique token across report results', async () => {
  const calls = [];
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        calls.push(message.url);
        if (message.url === gotoA) return { ok: true, url: 'https://publisher.example/story?id=1' };
        return { ok: false, url: '' };
      }
    }
  };
  const resolveLinks = extract(
    sidepanelSource,
    'function isGoogleGotoUrl(value) {',
    'function createReportHtml(report) {',
    'resolveGoogleGotoLinksInReport',
    { chrome, URL }
  );
  const report = {
    queries: [{ pages: [{ results: [
      { title: 'First', url: gotoA },
      { title: 'Duplicate', url: gotoA },
      { title: 'Unresolved', url: gotoB },
      { title: 'Already direct', url: 'https://publisher.example/direct' }
    ] }] }]
  };

  const stats = await resolveLinks(report);
  assert.deepEqual(calls.sort(), [gotoA, gotoB].sort());
  assert.equal(stats.total, 2);
  assert.equal(stats.resolved, 1);
  assert.equal(stats.unresolved, 1);
  assert.equal(report.queries[0].pages[0].results[0].url, 'https://publisher.example/story?id=1');
  assert.equal(report.queries[0].pages[0].results[1].url, 'https://publisher.example/story?id=1');
  assert.equal(report.queries[0].pages[0].results[2].url, gotoB, 'an unresolved token must not be guessed');
  assert.equal(report.queries[0].pages[0].results[3].url, 'https://publisher.example/direct');
});

test('background resolver validates Google /goto URLs and normalizes HTTP Location targets', async () => {
  const pendingGoogleGotoResolutions = new Map();
  let requestOptions;
  const fakeFetch = async (url, options) => {
    requestOptions = options;
    pendingGoogleGotoResolutions.get(url).finish('https://publisher.example/article');
    return { headers: { get: (name) => name === 'location' ? 'https://publisher.example/article' : null } };
  };
  const functions = extract(
    backgroundSource,
    'function normalizeGoogleGotoDestination(destination, sourceUrl) {',
    'async function reserveGoogleSearchSlot(state, tabId, url) {',
    '({ normalizeGoogleGotoDestination, resolveGoogleGotoUrl })',
    { pendingGoogleGotoResolutions, fetch: fakeFetch, URL, setTimeout, clearTimeout }
  );

  const resolved = await functions.resolveGoogleGotoUrl(gotoA);
  assert.equal(resolved, 'https://publisher.example/article');
  assert.equal(requestOptions.method, 'GET');
  assert.equal(requestOptions.redirect, 'manual');
  assert.equal(requestOptions.credentials, 'include');
  assert.equal(functions.normalizeGoogleGotoDestination('javascript:alert(1)', gotoA), '');
  assert.equal(functions.normalizeGoogleGotoDestination('https://www.google.com/goto?url=next', gotoA), '');
  await assert.rejects(() => functions.resolveGoogleGotoUrl('https://example.com/not-google'), /Разрешены только ссылки Google/);
});

test('Google /goto resolver reads Location from response headers, including non-3xx responses', () => {
  const getLocation = extract(
    backgroundSource,
    'function getGoogleGotoLocationHeader(responseHeaders) {',
    '// Google /goto normally responds',
    'getGoogleGotoLocationHeader'
  );
  assert.equal(getLocation([
    { name: 'content-type', value: 'text/html' },
    { name: 'Location', value: 'https://publisher.example/article' }
  ]), 'https://publisher.example/article');
  assert.equal(getLocation([{ name: 'location', value: '' }]), '');
  assert.equal(getLocation([{ name: 'content-type', value: 'text/html' }]), '');
  assert.ok(backgroundSource.includes('chrome.webRequest.onHeadersReceived.addListener'));
  assert.ok(backgroundSource.includes("{ urls: ['https://www.google.com/goto*'] }, ['responseHeaders']"));
});

test('Google /goto redirect capture is scoped to the Google endpoint', () => {
  assert.match(backgroundSource, /onBeforeRedirect\.addListener[\s\S]*?https:\/\/www\.google\.com\/goto\*/);
  assert.match(backgroundSource, /redirect:\s*'manual'/);
  assert.ok(backgroundSource.includes('chrome.webRequest.onHeadersReceived.addListener'));
  assert.ok(backgroundSource.includes("{ urls: ['https://www.google.com/goto*'] }, ['responseHeaders']"));
});
