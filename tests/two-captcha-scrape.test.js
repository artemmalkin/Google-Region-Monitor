const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');

function extractFunction(startMarker, endMarker, returnName, injected = {}) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing function marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  const body = source.slice(start, end);
  return new Function(...Object.keys(injected), `${body}\nreturn ${returnName};`)(...Object.values(injected));
}

const immediateTimeout = (callback) => { callback(); return 0; };

function htmlPage(items, text = '') { return JSON.stringify({ items, text }); }
function organicItems(page, count) {
  return Array.from({ length: count }, (_, index) => ({
    title: `Page ${page} result ${index + 1}`,
    url: `https://example.com/page-${page}-${index + 1}`,
    snippet: `Snippet ${index + 1}`,
    displayUrl: 'example.com'
  }));
}

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
      const anchor = { href: item.url, getAttribute: (name) => name === 'href' ? item.url : null, closest: () => block };
      return {
        textContent: item.title, innerText: item.title,
        closest: (selector) => selector === 'a[href]' ? anchor : block,
        querySelector: () => anchor,
        parentElement: block
      };
    });
    const root = { querySelectorAll: () => headings };
    return {
      body: { innerText: data.text || '', textContent: data.text || '' },
      querySelector: (selector) => selector === '#rso' ? root : null
    };
  }
}

function apiResponse(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : '',
    url: 'https://scraper.2captcha.com/tasks/sync',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(payload)
  };
}

function getScrapeFunction(overrides = {}) {
  return extractFunction(
    'async function searchGoogleVia2CaptchaScrape(url, apiKey, maxPages, apiLog = []) {',
    "$('stop-monitor').addEventListener('click'",
    'searchGoogleVia2CaptchaScrape',
    { fetch: async () => { throw new Error('fetch not mocked'); }, setTimeout: immediateTimeout, stopRequested: false, DOMParser: FakeDOMParser, ...overrides }
  );
}

test('Scrape performs one sequential raw-HTML task per requested Google page and preserves filters', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    const page = Number(new URL(body.url).searchParams.get('start') || 0) / 10 + 1;
    return apiResponse({ status: 'success', http_code: 200, headers: { 'content-type': 'text/html' }, body: htmlPage(organicItems(page, 3)) }, 200, {
      'content-type': 'application/json',
      'x-debug': JSON.stringify({ response_id: `scrape-${page}` })
    });
  };
  const result = await getScrapeFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=example&hl=id&gl=ID&lr=lang_id&tbs=qdr%3Aw&filter=0&num=10',
    'test-key', 3
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.body.task_type), ['scrape', 'scrape', 'scrape']);
  assert.deepEqual(calls.map((call) => call.body.data_format), ['raw', 'raw', 'raw']);
  assert.deepEqual(calls.map((call) => call.body.format), ['json', 'json', 'json']);
  const urls = calls.map((call) => new URL(call.body.url));
  assert.deepEqual(urls.map((url) => url.searchParams.get('start') || '0'), ['0', '10', '20']);
  for (const url of urls) {
    assert.equal(url.searchParams.get('hl'), 'id');
    assert.equal(url.searchParams.get('gl'), 'ID');
    assert.equal(url.searchParams.get('lr'), 'lang_id');
    assert.equal(url.searchParams.get('tbs'), 'qdr:w');
    assert.equal(url.searchParams.get('filter'), '0');
    assert.equal(url.searchParams.has('num'), false);
  }
  assert.deepEqual(result.pages.map((page) => page.results.length), [3, 3, 3]);
  assert.deepEqual(result.missingPages, []);
  assert.equal(result.pagesReceived, 3);
  assert.equal(result.resultsReceived, 9);
  assert.equal(result.tasks[2].responseId, 'scrape-3');
});

test('Scrape API exchange log captures response HTML and redacts the API key', async () => {
  const apiLog = [];
  const mockFetch = async (url, options) => apiResponse({ status: 'success', http_code: 200, body: htmlPage(organicItems(1, 1)) }, 200, {
    'x-debug': JSON.stringify({ response_id: 'diagnostic-scrape' })
  });
  await getScrapeFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=diagnostic', 'secret-scrape-key', 1, apiLog
  );
  const request = apiLog.find((item) => item.type === 'request');
  const response = apiLog.find((item) => item.type === 'response');
  assert.equal(request.body.task_type, 'scrape');
  assert.equal(request.headers.Authorization, 'Bearer [REDACTED]');
  assert.equal(response.httpStatus, 200);
  assert.ok(response.body.includes('example.com/page-1-1'));
  assert.equal(JSON.stringify(apiLog).includes('secret-scrape-key'), false);
});

test('Scrape does not misclassify ordinary Google SERP scripts as a CAPTCHA', async () => {
  const realGoogleScriptHtml = `<!doctype html><html><head><title>Google Search</title></head><body>
    <script>var hasCaptchaSupport=true; if (location.pathname.indexOf("/sorry/index") > -1) return false;</script>
    <div id="search"><div id="rso"><div class="MjjYud"><a href="/goto?url=encoded-result&amp;gsessionid=session"><h3>Example result title</h3></a></div></div></div>
  </body></html>`;
  class ModernGoogleDomParser {
    parseFromString() {
      const block = {
        querySelector(selector) {
          if (selector.includes('.VwiC3b')) return { textContent: 'A real search result snippet', innerText: 'A real search result snippet' };
          if (selector === 'cite') return { textContent: 'https://example.org › news', innerText: 'https://example.org › news' };
          return null;
        }
      };
      const anchor = {
        href: '/goto?url=encoded-result&gsessionid=session',
        getAttribute: (name) => name === 'href' ? '/goto?url=encoded-result&gsessionid=session' : null,
        closest: () => block
      };
      const heading = {
        textContent: 'Example result title', innerText: 'Example result title',
        closest: (selector) => selector === 'a[href]' ? anchor : block,
        querySelector: () => anchor,
        parentElement: block
      };
      const root = { querySelectorAll: () => [heading] };
      const body = {
        innerText: '',
        textContent: '',
        cloneNode: () => ({
          innerText: '',
          textContent: 'Example result title A real search result snippet',
          querySelectorAll: () => []
        })
      };
      return {
        body,
        querySelector: (selector) => selector === '#rso' ? root : null
      };
    }
  }
  const mockFetch = async () => apiResponse({ status: 'success', http_code: 200, body: realGoogleScriptHtml });
  const result = await getScrapeFunction({ fetch: mockFetch, DOMParser: ModernGoogleDomParser })(
    'https://www.google.com/search?q=example&tbs=qdr%3Aw', 'test-key', 1
  );
  assert.equal(result.googleBlocked, false);
  assert.equal(result.pagesReceived, 1);
  assert.equal(result.resultsReceived, 1);
  assert.equal(result.pages[0].results[0].title, 'Example result title');
  assert.match(result.pages[0].results[0].displayUrl, /example\.org/);
});

test('Scrape stops pagination when Google returns an automated-traffic page', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return apiResponse({ status: 'success', http_code: 200, body: htmlPage([], 'Our systems have detected unusual traffic from your computer network.') });
  };
  const result = await getScrapeFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=blocked&tbs=qdr%3Aw', 'test-key', 4
  );
  assert.equal(calls, 1);
  assert.equal(result.googleBlocked, true);
  assert.deepEqual(result.missingPages, [1, 2, 3, 4]);
  assert.match(result.errors[0].message, /CAPTCHA|ограничение/i);
});

test('Scrape polls a pending sync task using response_id without duplicating the task', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'POST') {
      return apiResponse({ status: 'pending' }, 408, { 'x-debug': JSON.stringify({ response_id: 'pending-scrape' }) });
    }
    return apiResponse({ status: 'success', http_code: 200, body: htmlPage(organicItems(1, 2)) });
  };
  const result = await getScrapeFunction({ fetch: mockFetch })(
    'https://www.google.com/search?q=pending', 'test-key', 1
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'GET');
  assert.match(calls[1].url, /pending-scrape$/);
  assert.equal(result.pages[0].results.length, 2);
});

test('Scrape backend remains available in the normal monitoring UI', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.match(html, /<option value="2captcha-scrape">2Captcha Scrape/);
  assert.equal(manifest.version, '1.9.3');
  assert.match(source, /task_type: 'scrape'/);
  assert.match(source, /searchGoogleVia2CaptchaScrape/);
});
