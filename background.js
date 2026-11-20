importScripts('github-config.js');
const STANDARD_SYNC_ALARM = 'google-region-monitor-standard-profiles-daily';
const DAY_MS = 24 * 60 * 60 * 1000;

chrome.runtime.onInstalled.addListener(async () => {
  await configureSidePanel();
  await ensureDailySyncAlarm();
  await syncStandardProfiles(false).catch(() => {});
});
chrome.runtime.onStartup.addListener(async () => {
  await configureSidePanel();
  await ensureDailySyncAlarm();
  await syncStandardProfiles(false).catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STANDARD_SYNC_ALARM) syncStandardProfiles(false).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'SYNC_STANDARD_PROFILES') {
    syncStandardProfiles(!!message.force).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  return false;
});

async function configureSidePanel() {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (_) {}
}
async function ensureDailySyncAlarm() {
  try {
    const alarm = await chrome.alarms.get(STANDARD_SYNC_ALARM);
    if (!alarm) chrome.alarms.create(STANDARD_SYNC_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  } catch (_) {
    chrome.alarms.create(STANDARD_SYNC_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  }
}
function validateSyncSettings(settings) {
  const cfg = globalThis.GITHUB_CONFIG || {};
  const repo = `${String(cfg.owner || '').trim()}/${String(cfg.repository || '').trim()}`;
  const branch = String(cfg.branch || 'main').trim();
  const path = String(cfg.standardProfilesPath || 'config/standard-profiles.json').trim();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) throw new Error('В настройках не задан GitHub-репозиторий owner/repository.');
  if (!branch || branch.includes('..')) throw new Error('Некорректная ветка GitHub.');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Некорректный путь к JSON-конфигурации.');
  return { repo, branch, path };
}
function normalizeRemoteProfile(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`Профиль #${index + 1} имеет неверный формат.`);
  const name = String(raw.name || '').trim();
  if (!name) throw new Error(`У профиля #${index + 1} отсутствует name.`);
  const queries = Array.isArray(raw.queries) ? raw.queries.map((item) => String(item).trim()).filter(Boolean) : [];
  const resultLangs = Array.isArray(raw.resultLangs) ? raw.resultLangs.join(', ') : String(raw.resultLangs || '');
  const id = String(raw.id || `profile-${index + 1}`).trim();
  if (!/^[a-z0-9_.-]{1,80}$/i.test(id)) throw new Error(`У профиля «${name}» некорректный id.`);
  return {
    id, name,
    interfaceLang: String(raw.interfaceLang || '').trim(),
    resultLangs: resultLangs.trim(),
    region: String(raw.region || '').trim().toUpperCase(),
    queries
  };
}
async function syncStandardProfiles(force = false) {
  const stored = await chrome.storage.local.get({
    lastStandardSyncAt: 0, lastStandardSyncSource: '', standardProfiles: []
  });
  let settings;
  try { settings = validateSyncSettings(stored); }
  catch (error) { return { ok: false, error: error.message }; }

  const lastSync = Number(stored.lastStandardSyncAt || 0);
  const expectedSource = `https://raw.githubusercontent.com/${settings.repo}/${settings.branch}/${settings.path}`;
  if (!force && stored.lastStandardSyncSource === expectedSource && lastSync && Date.now() - lastSync < DAY_MS) {
    return { ok: true, skipped: true, count: Array.isArray(stored.standardProfiles) ? stored.standardProfiles.length : 0, syncedAt: lastSync };
  }

  const rawPath = settings.path.split('/').map(encodeURIComponent).join('/');
  const url = `https://raw.githubusercontent.com/${settings.repo}/${encodeURIComponent(settings.branch)}/${rawPath}?_=${Date.now()}`;
  const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const message = response.status === 404
      ? `Файл стандартных профилей не найден: ${settings.path} (ветка ${settings.branch}).`
      : `GitHub вернул HTTP ${response.status} при загрузке стандартных профилей.`;
    throw new Error(message);
  }
  const text = (await response.text()).replace(/^\uFEFF/, '');
  let config;
  try { config = JSON.parse(text); } catch (_) { throw new Error('Файл стандартных профилей в GitHub не является корректным JSON.'); }
  const source = Array.isArray(config) ? config : config?.profiles;
  if (!Array.isArray(source)) throw new Error('В JSON ожидается массив profiles.');
  if (source.length > 500) throw new Error('В конфигурации больше 500 профилей. Синхронизация отменена.');
  const normalized = source.map(normalizeRemoteProfile);
  const ids = new Set();
  for (const profile of normalized) {
    if (ids.has(profile.id)) throw new Error(`Повторяется ID стандартного профиля: ${profile.id}.`);
    ids.add(profile.id);
  }
  const syncedAt = Date.now();
  await chrome.storage.local.set({
    standardProfiles: normalized,
    lastStandardSyncAt: syncedAt,
    lastStandardSyncSource: expectedSource,
    lastStandardSyncError: ''
  });
  return { ok: true, skipped: false, count: normalized.length, syncedAt };
}
// ===== Проверка региональной принадлежности ссылок через веб-версию ChatGPT =====
// Один запрос — один новый чат. Ответ доставляется отдельным runtime-сообщением,
// чтобы не держать tabs.sendMessage открытым на протяжении всей генерации.
const CHATGPT_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://*.chatgpt.com/*',
  'https://chat.openai.com/*'
];
const pendingRegionChatGPTRequests = new Map();
let regionChatGPTBusy = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'REGION_MONITOR_CHATGPT_KEEPALIVE') {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'REGION_MONITOR_CHATGPT_CLASSIFY') {
    classifyLinksWithWebChatGPT(message.prompt, message.requestId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'REGION_MONITOR_CHATGPT_RESPONSE') {
    const pending = pendingRegionChatGPTRequests.get(message.requestId);
    if (pending) {
      pendingRegionChatGPTRequests.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(String(message.error)));
      else pending.resolve({ answer: String(message.answer || ''), thinkingMode: String(message.thinkingMode || '') });
    }
    return false;
  }

  return false;
});

function regionMonitorSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChatGPTTabComplete(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (_) { return false; }
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await regionMonitorSleep(350);
  }
  return false;
}

async function waitForChatGPTComposer(tabId, timeoutMs = 30000) {
  const started = Date.now();
  const selector = 'textarea#prompt-textarea, textarea[placeholder*="Message"], textarea[placeholder*="Сообщение"], div[contenteditable="true"][role="textbox"], div.ProseMirror, div[contenteditable="true"]';
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: (css) => {
          return [...document.querySelectorAll(css)].some((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          });
        },
        args: [selector]
      });
      if (result?.[0]?.result) return true;
    } catch (_) {}
    await regionMonitorSleep(400);
  }
  return false;
}

async function getOrCreateRegionChatGPTTab() {
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  let tab = tabs.find((item) => item.id != null) || null;
  if (!tab) tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
  return tab;
}

async function startNewRegionChatGPTChat(tabId) {
  await waitForChatGPTTabComplete(tabId, 30000).catch(() => false);
  await regionMonitorSleep(700);

  let clicked = false;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const isVisible = (el) => {
          if (!el || el.offsetParent === null) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const labels = ['New chat', 'New Chat', 'Новый чат', 'Начать новый чат'];
        for (const node of document.querySelectorAll('span, div, button')) {
          if (!labels.includes((node.textContent || '').trim())) continue;
          const control = node.closest('button, [role="button"], a');
          if (control && isVisible(control)) {
            control.click();
            return { ok: true, method: 'visible-label' };
          }
        }
        const selectors = [
          'button[aria-label*="new chat" i]',
          'button[aria-label*="новый чат" i]',
          '[data-testid*="new-chat" i]',
          '[data-sidebar-destination="new-chat"]',
          '[data-sidebar-destination="builtin:new-chat"]',
          'a[href="/"]'
        ];
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            if (!isVisible(element)) continue;
            element.click();
            return { ok: true, method: selector };
          }
        }
        return { ok: false };
      }
    });
    clicked = !!result?.[0]?.result?.ok;
  } catch (_) {}

  if (clicked) {
    await regionMonitorSleep(900);
    // Если SPA не покинула старый адрес диалога, сбрасываем её на новый пустой чат.
    const currentTab = await chrome.tabs.get(tabId);
    const pathname = (() => { try { return new URL(currentTab.url).pathname; } catch (_) { return ''; } })();
    if (/\/(?:c|share)\//i.test(pathname)) clicked = false;
  }
  if (!clicked) {
    // Переход на корневой адрес — надёжный fallback, а не продолжение старого диалога.
    await chrome.tabs.update(tabId, { url: 'https://chatgpt.com/' });
    await waitForChatGPTTabComplete(tabId, 30000).catch(() => false);
    await regionMonitorSleep(1000);
  }

  const ready = await waitForChatGPTComposer(tabId, 25000);
  if (!ready) throw new Error('Не удалось открыть новый чат ChatGPT: поле ввода не появилось. Проверьте вход в chatgpt.com.');
  return true;
}

async function ensureRegionChatGPTContentScript(tabId) {
  try {
    await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: 'REGION_MONITOR_CHATGPT_PING' }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
    return true;
  } catch (_) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['chatgpt_content.js'] });
    await regionMonitorSleep(150);
    return true;
  }
}

async function classifyLinksWithWebChatGPT(prompt, suppliedRequestId) {
  if (regionChatGPTBusy) throw new Error('Вкладка ChatGPT уже занята другим запросом расширения.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Пустой запрос для ChatGPT.');
  if (prompt.length > 450000) throw new Error('Запрос слишком большой для одного сообщения ChatGPT. Разбейте список результатов на меньшие части.');

  regionChatGPTBusy = true;
  const requestId = String(suppliedRequestId || `region_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  let previousTabId = null;
  let previousWindowId = null;
  let chatTab = null;

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    previousTabId = activeTab?.id ?? null;
    previousWindowId = activeTab?.windowId ?? null;
    chatTab = await getOrCreateRegionChatGPTTab();
    await chrome.tabs.update(chatTab.id, { active: true });
    if (chatTab.windowId != null) await chrome.windows.update(chatTab.windowId, { focused: true });
    await startNewRegionChatGPTChat(chatTab.id);
    await ensureRegionChatGPTContentScript(chatTab.id);

    const responsePromise = new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        pendingRegionChatGPTRequests.delete(requestId);
        reject(new Error('Таймаут ожидания ответа ChatGPT (5 минут).'));
      }, 330000);
      pendingRegionChatGPTRequests.set(requestId, pending);
    });

    const acknowledgement = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(chatTab.id, {
        type: 'REGION_MONITOR_CHATGPT_PROMPT',
        prompt,
        requestId
      }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.accepted) reject(new Error(response?.error || 'Контент-скрипт ChatGPT не принял запрос.'));
        else resolve(response);
      });
    });
    if (!acknowledgement?.accepted) throw new Error('ChatGPT не принял запрос.');

    return await responsePromise;
  } finally {
    const pending = pendingRegionChatGPTRequests.get(requestId);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingRegionChatGPTRequests.delete(requestId);
    if (previousTabId != null) {
      try { await chrome.tabs.update(previousTabId, { active: true }); } catch (_) {}
      if (previousWindowId != null) {
        try { await chrome.windows.update(previousWindowId, { focused: true }); } catch (_) {}
      }
    }
    regionChatGPTBusy = false;
  }
}
