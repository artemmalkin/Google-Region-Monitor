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
  const repo = String(settings.githubRepo || '').trim();
  const branch = String(settings.standardConfigBranch || 'main').trim();
  const path = String(settings.standardConfigPath || 'config/standard-profiles.json').trim();
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
    githubRepo: '', standardConfigBranch: 'main', standardConfigPath: 'config/standard-profiles.json',
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
