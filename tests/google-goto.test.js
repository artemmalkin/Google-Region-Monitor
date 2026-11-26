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


test('direct-address discovery ignores opaque CAES tokens but unwraps legacy Google /url links', () => {
  const helpers = extract(
    sidepanelSource,
    'function isGoogleGotoUrl(value) {',
    'async function resolveGoogleGotoLinksInReport(report) {',
    '({ normalizeDirectGoogleResultUrl, getDirectGoogleResultUrlFromAnchor, getGoogleDisplayUrlMetadata })',
    { URL }
  );
  assert.equal(helpers.normalizeDirectGoogleResultUrl('CAESopaque-token', 'https://www.google.com/'), '');
  assert.equal(helpers.normalizeDirectGoogleResultUrl('/goto?url=CAESopaque-token', 'https://www.google.com/'), '');
  assert.equal(
    helpers.normalizeDirectGoogleResultUrl('https://www.google.com/url?q=https%3A%2F%2Fpublisher.example%2Fstory', 'https://www.google.com/'),
    'https://publisher.example/story'
  );
  const anchor = { href: 'https://www.google.com/goto?url=CAESopaque-token', getAttribute: (name) => name === 'href' ? '/goto?url=CAESopaque-token' : name === 'ping' ? '/url?url=CAESopaque-token' : null };
  assert.equal(helpers.getDirectGoogleResultUrlFromAnchor(anchor, 'https://www.google.com/search?q=test'), '');
  assert.equal(helpers.getGoogleDisplayUrlMetadata('https://ugm.ac.id › berita › title...').siteUrlHint, 'https://ugm.ac.id/');
});

test('direct JSON/HTML addresses skip Google redirect requests for that token', async () => {
  const pendingGoogleGotoResolutions = [];
  const chrome = { runtime: { sendMessage: async (message) => { pendingGoogleGotoResolutions.push(message.url); return { ok: false, url: '' }; } } };
  const resolveLinks = extract(
    sidepanelSource,
    'function isGoogleGotoUrl(value) {',
    'function createReportHtml(report) {',
    'resolveGoogleGotoLinksInReport',
    { chrome, URL }
  );
  const report = { queries: [{ pages: [{ results: [
    { title: 'From JSON', url: 'https://publisher.example/json', urlSource: '2captcha-json', googleGotoSourceUrl: gotoA },
    { title: 'Duplicate token', url: gotoA, googleGotoSourceUrl: gotoA, siteUrlHint: 'https://publisher.example/' }
  ] }] }] };
  const stats = await resolveLinks(report);
  assert.deepEqual(pendingGoogleGotoResolutions, [], 'no Google request is needed when JSON/HTML already supplied the destination');
  assert.equal(report.queries[0].pages[0].results[1].url, 'https://publisher.example/json');
  assert.equal(stats.total, 1);
  assert.equal(stats.resolved, 1);
  assert.equal(stats.fromJson, 1);
  assert.equal(stats.fromRedirect, 0);
});

test('Google /goto redirect capture is scoped to the Google endpoint', () => {
  assert.match(backgroundSource, /onBeforeRedirect\.addListener[\s\S]*?https:\/\/www\.google\.com\/goto\*/);
  assert.match(backgroundSource, /redirect:\s*'manual'/);
  assert.ok(backgroundSource.includes('chrome.webRequest.onHeadersReceived.addListener'));
  assert.ok(backgroundSource.includes("{ urls: ['https://www.google.com/goto*'] }, ['responseHeaders']"));
});
