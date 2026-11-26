const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'sidepanel.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function extractFunction(startMarker, endMarker, returnName) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing function marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return new Function(`${source.slice(start, end)}\nreturn ${returnName};`)();
}

test('release version and manifest are prepared for v1.9.3', () => {
  assert.equal(manifest.version, '1.9.3');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions.includes('clipboardWrite'), false);
  assert.equal(manifest.permissions.includes('webRequest'), true);
  assert.match(manifest.description, /Google Search API/);
});

test('developer console UI, scripts, styles and tests are removed', () => {
  assert.doesNotMatch(html, /two-captcha-developer-mode|two-captcha-dev-/);
  assert.doesNotMatch(source, /TwoCaptchaDeveloper|twoCaptchaDeveloper|two-captcha-dev-/i);
  assert.doesNotMatch(css, /api-developer|api-dev-/);
  assert.equal(fs.existsSync(path.join(root, 'tests', 'two-captcha-developer.test.js')), false);
});

test('ordinary API settings, statistics refresh and API log export remain available', () => {
  assert.match(html, /id="two-captcha-api-key"/);
  assert.match(html, /id="refresh-two-captcha-stats"/);
  assert.match(html, /id="download-api-log"/);
  assert.match(source, /function downloadLastTwoCaptchaApiLog/);
});

test('task history costs are used for average and confirmed last-report cost', () => {
  const summarize = extractFunction(
    'function summarizeTwoCaptchaTaskHistory(history, reportResponseIds = []) {',
    '\nasync function refreshTwoCaptchaStats',
    'summarizeTwoCaptchaTaskHistory'
  );
  const result = summarize([
    { response_id: 'a', status: 'done', price: 0.002 },
    { response_id: 'b', status: 'done', price: 0.004 },
    { response_id: 'c', status: 'error', price: 0 },
    { response_id: 'd', status: 'done', price: null }
  ], ['a', 'b']);
  assert.equal(result.averageTaskCost, 0.003);
  assert.equal(result.successfulTaskCount, 2);
  assert.equal(result.lastReportCost, 0.006);
  assert.equal(result.lastReportRequests, 2);
  assert.equal(result.lastReportHistoryComplete, true);
});

test('last-report cost is not guessed when task history has not confirmed every response ID', () => {
  const summarize = extractFunction(
    'function summarizeTwoCaptchaTaskHistory(history, reportResponseIds = []) {',
    '\nasync function refreshTwoCaptchaStats',
    'summarizeTwoCaptchaTaskHistory'
  );
  const result = summarize([{ response_id: 'a', status: 'done', price: 0.002 }], ['a', 'missing']);
  assert.equal(result.lastReportCost, null);
  assert.equal(result.lastReportRequests, null);
  assert.equal(result.lastReportHistoryComplete, false);
});

test('refresh includes Bearer auth and requests history for both Scraper API task types', () => {
  assert.match(source, /https:\/\/scraper\.2captcha\.com\/task_history\?/);
  assert.match(source, /'Authorization': `Bearer \$\{apiKey\}`/);
  assert.match(source, /task_type: taskType/);
  assert.match(source, /status === 'done'/);
  assert.doesNotMatch(source, /x-debug\.price/);
});
