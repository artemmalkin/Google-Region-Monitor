const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');

const googleUrlHelpers = (() => {
  const start = source.indexOf('function isGoogleGotoUrl(value) {');
  const end = source.indexOf('async function resolveGoogleGotoLinksInReport(report) {', start);
  if (start < 0 || end < 0) throw new Error('Google result URL helpers not found');
  return new Function('URL', `${source.slice(start, end)}\nreturn {
    isGoogleGotoUrl, normalizeDirectGoogleResultUrl, getDirectGoogleResultUrlFromItem,
    getDirectGoogleResultUrlFromAnchor, getGoogleDisplayUrlMetadata
  };`)(URL);
})();

function extractFunction(startMarker, endMarker, returnName, injected = {}) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing function marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  const body = source.slice(start, end);
  const parameterNames = Object.keys(injected);
  const parameterValues = Object.values(injected);
  return new Function(...parameterNames, `${body}\nreturn ${returnName};`)(...parameterValues);
}

function response(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : '',
    url: 'https://scraper.2captcha.com/tasks/sync',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(payload)
  };
}

const immediateTimeout = (callback) => { callback(); return 0; };

function organicItems(page, count, startPosition = (page - 1) * 10) {
  return Array.from({ length: count }, (_, index) => ({
    title: `Page ${page} result ${index + 1}`,
    url: `https://example.com/page-${page}-${index + 1}`,
    description: `Snippet ${index + 1}`,
    position: startPosition + index + 1,
    page_position: { page, position: index + 1 }
  }));
}

function htmlPage(items) { return JSON.stringify({ items }); }

class FakeDOMParser {
  parseFromString(raw) {
    const data = JSON.parse(raw);
    const headings = (data.items || []).map((item) => {
      const block = {
        querySelector(selector) {
          if (selector.includes('.VwiC3b')) return { textContent: item.snippet || '', innerText: item.snippet || '' };
          if (selector === 'cite') return { textContent: item.displayUrl || 'example.com', innerText: item.displayUrl || 'example.com' };
          return null;
        }
      };
      const anchor = {
        href: item.url,
        getAttribute: (name) => name === 'href' ? item.url : name === 'data-url' ? (item.dataUrl || null) : name === 'ping' ? (item.ping || null) : null,
        closest: () => block
      };
      return {
        textContent: item.title, innerText: item.title,
        closest: (selector) => selector === 'a[href]' ? anchor : block,
        querySelector: () => anchor,
        parentElement: block
      };
    });
    const root = { querySelectorAll: () => headings };
    return { querySelector: (selector) => selector === '#rso' ? root : null };
  }
}

function getSearchFunction(overrides = {}) {
  return extractFunction(
    'async function searchGoogleVia2Captcha(url, apiKey, maxPages, apiLog = []) {',
    "$('stop-monitor').addEventListener('click'",
    'searchGoogleVia2Captcha',
    { ...googleUrlHelpers, fetch: async () => { throw new Error('fetch not mocked'); }, setTimeout: immediateTimeout, stopRequested: false, DOMParser: FakeDOMParser, ...overrides }
  );
}

function payloadForRange(pageStart, pageEnd, { structured = true, html = true } = {}) {
  const items = [];
  const htmlEntries = [];
  for (let page = pageStart; page <= pageEnd; page++) {
    const pageItems = organicItems(page, page === 1 ? 7 : 5, (page - 1) * 10);
    if (structured) items.push(...pageItems);
    if (html) htmlEntries.push(htmlPage(pageItems));
  }
  return {
    status: items.length || htmlEntries.length ? 'success' : 'no_results',
    results: 124,
    task_param: { pages: pageEnd - pageStart + 1 },
    groups: { organic: { items } },
    ...(html ? { html: htmlEntries } : {})
  };
}

test('multi-page google_search uses one API task with page_num equal to the selected page count', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return response(payloadForRange(1, 5));
  };
  const result = await getSearchFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=example&hl=en&gl=nl&num=10&filter=0&start=0', 'test-key', 5
  );

  assert.equal(calls.length, 1, 'all requested pages are collected in one billable task');
  assert.equal(calls[0].body.task_type, 'google_search');
  assert.equal(calls[0].body.page_num, 5);
  assert.equal(calls[0].body.with_html, true);
  const requestUrl = new URL(calls[0].body.url);
  assert.equal(requestUrl.searchParams.has('start'), false);
  assert.equal(requestUrl.searchParams.has('num'), false);
  assert.equal(requestUrl.searchParams.has('filter'), false);
  assert.equal(requestUrl.searchParams.get('hl'), 'en');
  assert.equal(requestUrl.searchParams.get('gl'), 'nl');
  assert.deepEqual(result.pages.map((page) => page.results.length), [7, 5, 5, 5, 5]);
  assert.deepEqual(result.pages.map((page) => Number(new URL(page.url).searchParams.get('start'))), [0, 10, 20, 30, 40]);
  assert.deepEqual(result.missingPages, []);
  assert.equal(result.pagesReceived, 5);
  assert.equal(result.resultsReceived, 27);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].pageStart, 1);
  assert.equal(result.tasks[0].pageEnd, 5);
  assert.equal(result.tasks[0].apiPageEnd, 5);
  assert.equal(result.tasks[0].pagesRequested, 5);
});

test('missing pages in the combined response are reported without extra API tasks', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return response({
      status: 'success', results: 124, task_param: { pages: 3 },
      groups: { organic: { items: [...organicItems(1, 7), ...organicItems(3, 5, 20)] } },
      html: [{ page: 1, html: htmlPage(organicItems(1, 7)) }, { page: 3, html: htmlPage(organicItems(3, 5, 20)) }]
    });
  };
  const result = await getSearchFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=example', 'test-key', 3
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].page_num, 3);
  assert.deepEqual(result.missingPages, [2]);
  assert.equal(result.pagesReceived, 2);
  assert.equal(result.pagesWithResults, 2);
  assert.equal(result.resultsReceived, 12);
});

test('HTML-only pages from a combined response fill pages missing from structured results', async () => {
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.page_num, 2);
    assert.equal(body.with_html, true);
    return response({
      status: 'success', task_param: { pages: 2 },
      groups: { organic: { items: organicItems(1, 2) } },
      html: [htmlPage(organicItems(1, 2)), htmlPage(organicItems(2, 4, 10))]
    });
  };
  const result = await getSearchFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=example', 'test-key', 2
  );
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[1].results.length, 4);
  assert.equal(result.pages[1].results[0].url, 'https://example.com/page-2-1');
  assert.deepEqual(result.missingPages, []);
});

test('a direct URL in a structured 2Captcha field wins over the primary Google /goto URL', async () => {
  const gotoUrl = 'https://www.google.com/goto?url=opaque-structured&gsessionid=session';
  const directUrl = 'https://publisher.example/from-json';
  const mockFetch = async () => response({
    status: 'success',
    task_param: { pages: 1 },
    groups: { organic: { items: [{
      title: 'Result with direct JSON target', url: gotoUrl, link: directUrl,
      description: 'JSON result', position: 1, page_position: { page: 1, position: 1 }
    }] } }
  });
  const result = await getSearchFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=example', 'test-key', 1
  );
  assert.equal(result.pages[0].results[0].url, directUrl);
  assert.equal(result.pages[0].results[0].urlSource, '2captcha-json');
  assert.equal(result.pages[0].results[0].googleGotoSourceUrl, gotoUrl);
});

test('a direct data-url in Google HTML wins over /goto and retains a domain hint', async () => {
  const gotoUrl = 'https://www.google.com/goto?url=opaque-html&gsessionid=session';
  const directUrl = 'https://publisher.example/from-html';
  const html = htmlPage([{
    title: 'Result with direct HTML target', url: gotoUrl, dataUrl: directUrl,
    displayUrl: 'https://publisher.example › articles › result-title'
  }]);
  const mockFetch = async () => response({
    status: 'success', task_param: { pages: 2 }, groups: { organic: { items: [] } }, html: [html]
  });
  const result = await getSearchFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=example', 'test-key', 2
  );
  const item = result.pages[0].results[0];
  assert.equal(item.url, directUrl);
  assert.equal(item.urlSource, '2captcha-html');
  assert.equal(item.googleGotoSourceUrl, gotoUrl);
  assert.equal(item.siteUrlHint, 'https://publisher.example/');
});

test('single-page search makes one API task and does not request HTML', async () => {
  let sentBody;
  const mockFetch = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return response(payloadForRange(1, 1, { html: false }));
  };
  const result = await getSearchFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=example', 'test-key', 1
  );
  assert.equal(sentBody.page_num, 1);
  assert.equal('with_html' in sentBody, false);
  assert.equal(result.pages[0].results.length, 7);
  assert.equal(result.tasks.length, 1);
});

test('pending synchronous task is polled by response_id instead of being recreated', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'POST') return response({ status: 'pending', response_id: 'pending-task' }, 408);
    return response(payloadForRange(1, 1, { html: false }), 200);
  };
  const result = await getSearchFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=example', 'test-key', 1
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'GET');
  assert.match(calls[1].url, /pending-task$/);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.pages[0].results.length, 7);
});

test('API diagnostics record one combined page_num task and redact the API key', async () => {
  const apiLog = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.page_num, 2);
    return response(payloadForRange(1, 2, { html: true }), 200, {
      'content-type': 'application/json',
      'x-debug': JSON.stringify({ response_id: 'diagnostic-combined' })
    });
  };
  const result = await getSearchFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=diagnostic', 'secret-test-key', 2, apiLog
  );
  const requests = apiLog.filter((event) => event.type === 'request');
  const responses = apiLog.filter((event) => event.type === 'response');
  assert.equal(requests.length, 1);
  assert.equal(responses.length, 1);
  assert.equal(requests[0].body.page_num, 2);
  assert.equal(new URL(requests[0].body.url).searchParams.has('start'), false);
  assert.equal(requests[0].headers.Authorization, 'Bearer [REDACTED]');
  assert.equal(responses[0].httpStatus, 200);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].responseId, 'diagnostic-combined');
  assert.equal(JSON.stringify(apiLog).includes('secret-test-key'), false);
  assert.equal(JSON.stringify(apiLog).includes('Bearer secret-test-key'), false);
});

test('API diagnostics download button is hidden by default and has a JSON export handler', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.html'), 'utf8');
  assert.match(html, /id="download-api-log"[^>]*hidden/);
  assert.match(source, /format: 'google-region-monitor-2captcha-api-log'/);
  assert.match(source, /download-api-log'\)\.addEventListener\('click', downloadLastTwoCaptchaApiLog\)/);
  assert.match(source, /apiKeyIncluded: false/);
  assert.match(source, /Authorization: 'Bearer \[REDACTED\]'/);
});

test('task history is only fetched from the explicit statistics refresh action', () => {
  assert.match(source, /async function fetchTwoCaptchaTaskHistory/);
  assert.match(source, /async function fetchRecentTwoCaptchaTaskHistory/);
  assert.match(source, /refresh-two-captcha-stats'\)\.addEventListener\('click'/);
  assert.match(source, /refreshTwoCaptchaStats\(\)\.catch/);
  assert.match(source, /fetchRecentTwoCaptchaTaskHistory\(key, 'google_search'/);
  assert.match(source, /fetchRecentTwoCaptchaTaskHistory\(key, 'scrape'/);
  assert.equal(source.includes('Баланс 2Captcha перед запуском'), false);
  assert.equal(source.includes('Баланс после отчёта'), false);
  assert.equal(source.includes('Расход 2Captcha на этот отчёт'), false);
});
