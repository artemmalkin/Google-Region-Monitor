importScripts('github-config.js');
const STANDARD_SYNC_ALARM = 'google-region-monitor-standard-profiles-daily';
const DAY_MS = 24 * 60 * 60 * 1000;
const GOOGLE_SEARCH_INTERVAL_SETTING = 'googleSearchMinIntervalSeconds';
const GOOGLE_SEARCH_LAST_REQUEST_SETTING = 'googleSearchLastRequestAt';
let googleSearchRateLimitQueue = Promise.resolve();
let googleSearchLastRequestAtInMemory = 0;
const googleSearchSlotStates = new Map();

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

  if (message?.type === 'WAIT_FOR_GOOGLE_SEARCH_SLOT') {
    const requestId = String(message.requestId || '');
    if (!requestId) {
      sendResponse({ ok: false, error: 'Не указан ID запроса Google.' });
      return false;
    }
    const tabId = Number(message.tabId);
    const url = String(message.url || '');
    if (!Number.isInteger(tabId) || tabId <= 0 || !url) {
      sendResponse({ ok: false, error: 'Не указана вкладка или URL поискового запроса Google.' });
      return false;
    }
    const state = { cancelled: false, done: false };
    googleSearchSlotStates.set(requestId, state);
    const run = () => reserveGoogleSearchSlot(state, tabId, url);
    const result = googleSearchRateLimitQueue.then(run, run);
    googleSearchRateLimitQueue = result.catch(() => {});
    result.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }))
      .finally(() => {
        state.done = true;
        googleSearchSlotStates.delete(requestId);
      });
    return true;
  }

  if (message?.type === 'CANCEL_GOOGLE_SEARCH_SLOT') {
    const state = googleSearchSlotStates.get(String(message.requestId || ''));
    if (state && !state.done) state.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function reserveGoogleSearchSlot(state, tabId, url) {
  if (state.cancelled) return { ok: false, cancelled: true };

  const searchUrl = new URL(url);
  if (searchUrl.protocol !== 'https:'
    || !(searchUrl.hostname === 'google.com' || searchUrl.hostname.endsWith('.google.com'))
    || searchUrl.pathname !== '/search') {
    throw new Error('Ограничитель принимает только HTTPS-адреса Google Search.');
  }

  const stored = await chrome.storage.local.get({
    [GOOGLE_SEARCH_INTERVAL_SETTING]: 2,
    [GOOGLE_SEARCH_LAST_REQUEST_SETTING]: 0
  });
  const configured = Number(stored[GOOGLE_SEARCH_INTERVAL_SETTING]);
  const intervalSeconds = Number.isFinite(configured)
    ? Math.max(0, Math.min(600, Math.floor(configured)))
    : 2;
  const persistedLastRequestAt = Math.max(0, Number(stored[GOOGLE_SEARCH_LAST_REQUEST_SETTING]) || 0);
  const lastRequestAt = Math.max(persistedLastRequestAt, googleSearchLastRequestAtInMemory);
  const nextAllowedAt = lastRequestAt + intervalSeconds * 1000;
  let remainingMs = Math.max(0, nextAllowedAt - Date.now());
  let waitedMs = 0;

  // Short slices keep the Stop button responsive even for a long configured interval.
  while (remainingMs > 0) {
    if (state.cancelled) return { ok: false, cancelled: true };
    const slice = Math.min(remainingMs, 250);
    await sleep(slice);
    waitedMs += slice;
    remainingMs = Math.max(0, nextAllowedAt - Date.now());
  }
  if (state.cancelled) return { ok: false, cancelled: true };

  // Start the actual tab navigation inside the serialized worker queue. This
  // prevents delays between granting a slot and the side panel issuing the request.
  await chrome.tabs.update(tabId, { url: searchUrl.toString(), active: true });
  const grantedAt = Date.now();
  googleSearchLastRequestAtInMemory = grantedAt;
  await chrome.storage.local.set({ [GOOGLE_SEARCH_LAST_REQUEST_SETTING]: grantedAt });
  return { ok: true, intervalSeconds, waitedMs, grantedAt };
}

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
// Механизм DOM-взаимодействия и протокол сообщений перенесены из рабочего
// расширения-примера без изменения chatgpt_content.js и startNewChatGPTChat().
// Для каждого пакета всегда создаётся отдельный новый чат.
const CHATGPT_URL_PATTERNS = [
  "https://chat.openai.com/*",
  "https://chatgpt.com/*",
  "https://*.chatgpt.com/*"
];
let chatGPTTabId = null;
const pendingRegionChatGPTRequests = new Map();
let regionChatGPTBusy = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'REGION_MONITOR_CHATGPT_KEEPALIVE') {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'REGION_MONITOR_CHATGPT_CLASSIFY') {
    classifyLinksWithWebChatGPT(message.prompt, message.requestId, message.enableReasoning === true, message.reasoningEffort || 'medium')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  // Те же типы сообщений, которыми пользуется chatgpt_content.js из примера.
  if (message?.type === 'chatgpt_response_ready' || message?.type === 'chatgpt_error_ready') {
    const requestId = String(message.id || message.expectedId || '');
    const pending = pendingRegionChatGPTRequests.get(requestId);
    if (pending) {
      pendingRegionChatGPTRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (message.type === 'chatgpt_error_ready') pending.reject(new Error(String(message.value || 'Ошибка ChatGPT.')));
      else pending.resolve(String(message.value || ''));
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// chatgpt_content.js из примера также пишет готовый ответ в storage.local.
// Удаляем временные ключи после записи, чтобы накопившиеся ответы не занимали хранилище.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  for (const key of Object.keys(changes)) {
    if (key.startsWith('chatgpt_response_') || key.startsWith('chatgpt_error_')) {
      chrome.storage.local.remove(key).catch(() => {});
    }
  }
});

function pingSW() {
  try {
    chrome.runtime.getPlatformInfo(() => {});
  } catch (e) {}
}

async function getOrCreateChatGPTTab() {
  if (chatGPTTabId) {
    try {
      const tab = await chrome.tabs.get(chatGPTTabId);
      if (tab) return tab;
    } catch { chatGPTTabId = null; }
  }
  const tabs = await chrome.tabs.query({
    url: ["https://chat.openai.com/*", "https://chatgpt.com/*", "https://*.chatgpt.com/*"]
  });
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://chat.openai.com", active: true });
  }
  chatGPTTabId = tab.id;
  return tab;
}

async function startNewChatGPTChat() {
  let tab = null;
  try {
    tab = await getOrCreateChatGPTTab();
    await waitForTabComplete(tab.id, 120000).catch(() => {});
    // ChatGPT may finish document loading before its React controls are hydrated.
    await sleep(1800);

    let clicked = false;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const isVisible = (el) => {
            if (!el) return false;
            if (el.offsetParent === null) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };

          const texts = ['Новый чат', 'New chat', 'New Chat'];

          const spans = document.querySelectorAll('span');
          for (const sp of spans) {
            const t = (sp.textContent || '').trim();
            if (texts.includes(t)) {
              const btn = sp.closest('button') || sp.closest('[role="button"]') || sp.closest('a');
              if (btn && isVisible(btn)) {
                btn.click();
                return { ok: true, method: 'text-span' };
              }
            }
          }

          const selectors = [
            'a[href="/"]',
            'button[aria-label*="new chat" i]',
            'button[aria-label*="новый чат" i]',
            '[data-testid*="new-chat" i]',
            '[data-sidebar-destination="new-chat"]',
            '[data-sidebar-destination="builtin:new-chat"]'
          ];
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              if (!isVisible(el)) continue;
              el.click();
              return { ok: true, method: sel };
            }
          }
          return { ok: false };
        }
      });
      if (res && res[0] && res[0].result && res[0].result.ok) {
        clicked = true;
        console.log(`🆕 ChatGPT: клик по «New chat» (${res[0].result.method})`);
      }
    } catch (e) {
      console.warn('⚠️ ChatGPT new chat: не удалось кликнуть:', e.message);
    }

    if (!clicked) {
      console.log('🆕 ChatGPT: кнопка не найдена, перехожу на главную страницу');
      try {
        await chrome.tabs.update(tab.id, { url: 'https://chatgpt.com/' });
      } catch (e) {
        console.warn('⚠️ ChatGPT: не удалось обновить URL:', e.message);
      }
    } else {
      await sleep(1500);
    }

    console.log('🆕 ChatGPT: перезагружаю страницу после создания нового чата');
    try {
      await chrome.tabs.reload(tab.id, { bypassCache: true });
    } catch (e) {
      console.warn('⚠️ ChatGPT: не удалось перезагрузить вкладку:', e.message);
    }

    await waitForTabComplete(tab.id, 120000).catch(() => {});
    await sleep(1500);

    const hasInput = await waitForSelectorInTab(
      tab.id,
      'textarea#prompt-textarea, textarea[placeholder*="Message"], ' +
      'div[contenteditable="true"][role="textbox"], div.ProseMirror, div[contenteditable="true"]',
      120000,
      750
    );
    if (!hasInput) {
      console.warn('⚠️ ChatGPT: поле ввода не появилось после нового чата');
      return false;
    }

    await sleep(500);
    return true;
  } catch (e) {
    console.warn('⚠️ startNewChatGPTChat error:', e.message);
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId, timeout = 120000) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (tab.status === 'complete') return resolve();
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Таймаут загрузки страницы'));
      }, timeout);
    });
  });
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  let iteration = 0;
  while (Date.now() - start < timeoutMs) {
    iteration++;
    if (iteration % 6 === 0) pingSW();
    try {
      const tab = await new Promise((resolve) => {
        chrome.tabs.get(tabId, (t) => {
          if (chrome.runtime.lastError || !t) resolve(null);
          else resolve(t);
        });
      });
      if (!tab) return false;
      if (tab.status === 'complete') return true;
    } catch (e) {
      return false;
    }
    await sleep(500);
  }
  return false;
}

async function waitForSelectorInTab(tabId, selector, timeoutMs = 30000, pollMs = 500) {
  const start = Date.now();
  let iteration = 0;
  while (Date.now() - start < timeoutMs) {
    iteration++;
    if (iteration % 6 === 0) pingSW();
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => !!document.querySelector(sel),
        args: [selector]
      });
      if (res && res[0] && res[0].result) return true;
    } catch (e) {}
    await sleep(pollMs);
  }
  return false;
}

async function injectContentScriptIfNeeded(tabId, scriptFile) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return true;
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [scriptFile]
      });
      await sleep(1500);
      await chrome.tabs.sendMessage(tabId, { type: "ping" });
      return true;
    } catch (e) {
      console.error('Не удалось внедрить контент-скрипт:', e);
      return false;
    }
  }
}

function restorePreviousTab(tabId, windowId) {
  if (tabId) {
    try {
      chrome.tabs.update(tabId, { active: true });
      if (windowId) {
        chrome.windows.update(windowId, { focused: true });
      }
    } catch (e) {}
  }
}

async function sendPromptToChatGPT(prompt, expectedId, enableReasoning = false, reasoningEffort = 'medium') {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const previousTabId = activeTab ? activeTab.id : null;
  const previousWindowId = activeTab ? activeTab.windowId : null;

  const id = expectedId || Date.now().toString();
  const responseKey = `chatgpt_response_${id}`;
  const errorKey = `chatgpt_error_${id}`;
  try { await chrome.storage.local.remove([responseKey, errorKey]); } catch (_) {}

  try {
    const tab = await getOrCreateChatGPTTab();
    await waitForTabLoad(tab.id);

    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(resolve => setTimeout(resolve, 300));

    // Всегда новый чат — точная функция из расширения-примера.
    const newChatReady = await startNewChatGPTChat();
    if (!newChatReady) {
      throw new Error('Не удалось открыть новый чат ChatGPT. Проверьте вход в chatgpt.com.');
    }

    await waitForTabLoad(tab.id);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(resolve => setTimeout(resolve, 300));

    if (enableReasoning) {
      const reasoning = await ensureChatGPTReasoningMode(tab.id, reasoningEffort);
      if (!reasoning.ok) throw new Error(`Не удалось установить режим размышления ChatGPT (${reasoningEffort}): ${reasoning.reason || 'режим не найден'}`);
      if (reasoning.mode === 'legacy-toggle' && reasoningEffort !== 'medium') {
        console.warn(`ChatGPT: в этом интерфейсе доступен только переключатель «Размышление»; уровень ${reasoningEffort} выбрать нельзя.`);
      }
    }

    const ready = await injectContentScriptIfNeeded(tab.id, "chatgpt_content.js");
    if (!ready) {
      throw new Error('Не удалось активировать контент-скрипт на странице ChatGPT');
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRegionChatGPTRequests.delete(id);
        reject(new Error('Таймаут ожидания ответа от ChatGPT (15 минут)'));
      }, 910000);
      pendingRegionChatGPTRequests.set(id, { resolve, reject, timer });

      // Протокол отправки один-в-один как в примере: chatgpt_request.
      chrome.tabs.sendMessage(tab.id, {
        type: "chatgpt_request",
        prompt,
        expectedId: id
      }, (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message;
          const pending = pendingRegionChatGPTRequests.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRegionChatGPTRequests.delete(id);
            reject(new Error(msg));
          }
        } else if (response && response.error) {
          const pending = pendingRegionChatGPTRequests.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRegionChatGPTRequests.delete(id);
            reject(new Error(response.error));
          }
        }
      });
    });
  } finally {
    restorePreviousTab(previousTabId, previousWindowId);
  }
}

async function ensureChatGPTReasoningMode(tabId, effort = 'medium', timeoutMs = 120000) {
  const allowedEfforts = ['low', 'medium', 'high', 'xhigh'];
  if (!allowedEfforts.includes(effort)) effort = 'medium';

  const started = Date.now();
  let pickerOpened = false;
  let optionClickAttempted = false;
  let legacyClickAttempted = false;

  while (Date.now() - started < timeoutMs) {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        func: (requestedEffort, menuWasOpened, optionWasClicked, legacyWasClicked) => {
          const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
          const isVisible = (el) => {
            if (!el || !el.getClientRects().length) return false;
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          };

          const picker = Array.from(document.querySelectorAll(
            'form[data-chatgpt-composer] button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"], button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"], button[aria-label="Выбрать модель ChatGPT"][aria-haspopup="menu"], button[aria-label="Choose ChatGPT model"][aria-haspopup="menu"]'
          )).find(isVisible);

          // Подписочный интерфейс: выпадающий переключатель уровня reasoning.
          if (picker) {
            const selected = normalize(picker.getAttribute('data-selected-reasoning-effort'));
            if (selected === requestedEffort) return { ok: true, mode: 'effort-picker', selected };

            if (!menuWasOpened) {
              picker.click();
              return { menuOpened: true, mode: 'effort-picker' };
            }

            if (optionWasClicked) {
              return { waitingForSelection: true, mode: 'effort-picker' };
            }

            const aliases = {
              low: ['low', 'низкий', 'низкое', 'минимальный', 'минимальное', 'легкий', 'лёгкий', 'меньше'],
              medium: ['medium', 'средний', 'среднее', 'обычный', 'стандартный'],
              high: ['high', 'высокий', 'высокое', 'больше'],
              xhigh: ['xhigh', 'extra high', 'extra-high', 'very high', 'максимальный', 'максимальное', 'максимум', 'максимально высокий', 'очень высокий']
            };
            const selectors = [
              '[role="menuitemradio"]', '[role="menuitemcheckbox"]', '[role="option"]', '[role="menuitem"]', '[role="radio"]',
              '[data-reasoning-effort]', '[data-effort]', '[data-value]', 'button'
            ].join(',');
            const candidates = Array.from(document.querySelectorAll(selectors)).filter((el) => isVisible(el) && el !== picker);

            const identify = (el) => {
              const attrValues = [
                el.getAttribute('data-reasoning-effort'), el.getAttribute('data-effort'),
                el.getAttribute('data-value'), el.getAttribute('value'), el.getAttribute('aria-label')
              ].map(normalize).filter(Boolean);
              const text = normalize(el.innerText || el.textContent);
              for (const [value, names] of Object.entries(aliases)) {
                if (attrValues.some((candidate) => names.includes(candidate))) return value;
                if (names.some((name) => text === name || text.startsWith(`${name} `) || text.endsWith(` ${name}`) || text.includes(` ${name} `))) return value;
              }
              return '';
            };

            // В первую очередь используются пункты меню/контролы с явными ролями и атрибутами; текстовая проверка оставляет совместимость с кнопками меню.
            const option = candidates.find((el) => identify(el) === requestedEffort);
            if (option) {
              option.click();
              return { optionClicked: true, mode: 'effort-picker', requestedEffort };
            }
            return { waitingForOptions: true, mode: 'effort-picker' };
          }

          // Бесплатный/упрощённый интерфейс: одна кнопка «Размышление».
          const composerButtons = document.querySelectorAll(
            'form[data-chatgpt-composer] [data-composer-trailing-controls="true"] button[aria-pressed]'
          );
          let toggle = Array.from(composerButtons).find((candidate) =>
            normalize(candidate.textContent) === 'размышление' && isVisible(candidate)
          );
          if (!toggle) {
            toggle = Array.from(document.querySelectorAll('button[aria-pressed]')).find((candidate) =>
              normalize(candidate.textContent) === 'размышление' && isVisible(candidate)
            );
          }
          if (!toggle) return { waitingForControl: true, reason: 'reasoning-control-not-found' };
          if (toggle.getAttribute('aria-pressed') === 'true') {
            return { ok: true, mode: 'legacy-toggle', selected: 'enabled' };
          }
          if (!legacyWasClicked) {
            toggle.click();
            return { legacyClicked: true, mode: 'legacy-toggle' };
          }
          return { waitingForSelection: true, mode: 'legacy-toggle' };
        },
        args: [effort, pickerOpened, optionClickAttempted, legacyClickAttempted]
      });

      const result = injected?.[0]?.result;
      if (result?.menuOpened) pickerOpened = true;
      if (result?.optionClicked) optionClickAttempted = true;
      if (result?.legacyClicked) legacyClickAttempted = true;
      if (result?.ok) return result;
    } catch (_) {
      // ChatGPT can temporarily reject script execution while its SPA is loading.
    }

    await sleep(1000);
  }

  if (optionClickAttempted) return { ok: false, reason: 'effort-selection-not-confirmed' };
  if (pickerOpened) return { ok: false, reason: 'requested-effort-not-available-in-menu' };
  if (legacyClickAttempted) return { ok: false, reason: 'legacy-toggle-state-timeout' };
  return { ok: false, reason: 'reasoning-control-not-found-or-timeout' };
}
async function classifyLinksWithWebChatGPT(prompt, suppliedRequestId, enableReasoning = false, reasoningEffort = 'medium') {
  if (regionChatGPTBusy) throw new Error('Вкладка ChatGPT уже занята другим запросом расширения.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Пустой запрос для ChatGPT.');
  if (prompt.length > 450000) throw new Error('Запрос слишком большой для одного сообщения ChatGPT. Разбейте список результатов на меньшие части.');

  regionChatGPTBusy = true;
  const requestId = String(suppliedRequestId || `region_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  try {
    const answer = await sendPromptToChatGPT(prompt, requestId, enableReasoning, reasoningEffort);
    return { answer };
  } finally {
    regionChatGPTBusy = false;
  }
}
