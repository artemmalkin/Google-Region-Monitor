const DEFAULT_PROFILE = {
  id: 'starter-vietnam',
  name: 'Вьетнам (пример)',
  interfaceLang: 'vi',
  resultLangs: 'vi, en',
  region: 'VN',
  queries: ['rosatom', '"rosatom" AND "rooppur"'],
  profileType: 'user'
};

let standardProfiles = [];
let userProfiles = [];
let profiles = [];
let selectedProfileKey = null;
let monitorProfileKey = null;
let isRunning = false;

const $ = (id) => document.getElementById(id);
function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }
function profileKey(profile) { return profile.profileType === 'standard' ? `std:${profile.id}` : `usr:${profile.id}`; }
function rebuildProfiles() {
  standardProfiles = standardProfiles.map((profile) => ({ ...profile, profileType: 'standard' }));
  userProfiles = userProfiles.map((profile) => ({ ...profile, profileType: 'user' }));
  profiles = [...standardProfiles, ...userProfiles];
}
function getProfileByKey(key) { return profiles.find((profile) => profileKey(profile) === key) || null; }
function selectedProfile() { return getProfileByKey(selectedProfileKey); }
function setStatus(element, text, kind = '') {
  element.textContent = text;
  element.className = element.className.replace(/\b(error|success)\b/g, '').trim();
  if (kind) element.classList.add(kind);
}
function normalizeQueries(value) { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function profileValues(profile) {
  return {
    name: String(profile.name || '').trim() || 'Новый профиль',
    interfaceLang: String(profile.interfaceLang || '').trim(),
    resultLangs: String(Array.isArray(profile.resultLangs) ? profile.resultLangs.join(', ') : profile.resultLangs || '').trim(),
    region: String(profile.region || '').trim().toUpperCase(),
    queries: Array.isArray(profile.queries) ? profile.queries.map((q) => String(q).trim()).filter(Boolean) : []
  };
}
function sameProfileValues(a, b) { return JSON.stringify(profileValues(a)) === JSON.stringify(profileValues(b)); }

async function loadProfiles() {
  const stored = await chrome.storage.local.get({
    standardProfiles: [], userProfiles: null, profiles: null,
    selectedProfileKey: null, selectedProfileId: null, monitorProfileKey: null
  });
  standardProfiles = Array.isArray(stored.standardProfiles) ? stored.standardProfiles : [];
  if (Array.isArray(stored.userProfiles)) {
    userProfiles = stored.userProfiles;
  } else if (Array.isArray(stored.profiles)) {
    // Migration from v1.0/v1.1: legacy profiles become local user profiles.
    userProfiles = stored.profiles.map((profile) => ({ ...profile, profileType: 'user' }));
  } else {
    userProfiles = standardProfiles.length ? [] : [{ ...DEFAULT_PROFILE, id: makeId() }];
  }
  rebuildProfiles();
  selectedProfileKey = profiles.some((p) => profileKey(p) === stored.selectedProfileKey)
    ? stored.selectedProfileKey
    : profiles.find((p) => p.id === stored.selectedProfileId && p.profileType === 'user')
      ? profileKey(profiles.find((p) => p.id === stored.selectedProfileId && p.profileType === 'user'))
      : profiles[0] ? profileKey(profiles[0]) : null;
  monitorProfileKey = profiles.some((p) => profileKey(p) === stored.monitorProfileKey) ? stored.monitorProfileKey : selectedProfileKey;
  await persistProfiles();
  renderProfileSelectors();
  loadProfileIntoForm();
  renderMonitorQueries();
}
async function persistProfiles() {
  rebuildProfiles();
  await chrome.storage.local.set({ userProfiles, selectedProfileKey, monitorProfileKey });
}
function renderProfileSelectors() {
  const selected = $('profile-select');
  const monitor = $('monitor-profile');
  const fill = (select, value) => {
    select.replaceChildren();
    if (standardProfiles.length) {
      const group = document.createElement('optgroup'); group.label = 'Стандартные · GitHub';
      standardProfiles.forEach((profile) => group.append(new Option(profile.name || 'Без названия', profileKey(profile))));
      select.append(group);
    }
    if (userProfiles.length) {
      const group = document.createElement('optgroup'); group.label = 'Мои профили · локально';
      userProfiles.forEach((profile) => {
        const suffix = profile.sourceStandardId ? ' (копия)' : '';
        group.append(new Option(`${profile.name || 'Без названия'}${suffix}`, profileKey(profile)));
      });
      select.append(group);
    }
    if (!profiles.length) select.append(new Option('Нет профилей', ''));
    select.value = value || '';
  };
  fill(selected, selectedProfileKey);
  fill(monitor, monitorProfileKey);
  const profile = selectedProfile();
  $('delete-profile').disabled = !profile || profile.profileType === 'standard';
  $('export-profile').disabled = !profile || profile.profileType === 'standard';
}
function updateProfileKindText(profile = selectedProfile()) {
  const node = $('profile-kind');
  if (!profile) { node.textContent = 'Нет выбранного профиля.'; return; }
  if (profile.profileType === 'standard') {
    node.textContent = 'Стандартный профиль из GitHub. При изменении будет создана отдельная пользовательская копия; оригинал не изменится.';
  } else if (profile.sourceStandardId) {
    node.textContent = 'Пользовательская копия стандартного профиля. Обновление GitHub не перезапишет ваши изменения.';
  } else {
    node.textContent = 'Пользовательский профиль хранится только в этом браузере.';
  }
}
function loadProfileIntoForm() {
  const profile = selectedProfile();
  if (!profile) return;
  const values = profileValues(profile);
  $('profile-name').value = values.name;
  $('interface-lang').value = values.interfaceLang;
  $('results-langs').value = values.resultLangs;
  $('search-region').value = values.region;
  $('queries').value = values.queries.join('\n');
  $('query-count').textContent = String(values.queries.length);
  $('save-status').textContent = '';
  updateProfileKindText(profile);
  renderProfileSelectors();
}
function readProfileFromForm() {
  let profile = selectedProfile();
  if (!profile) throw new Error('Сначала создайте или синхронизируйте профиль.');
  const draft = {
    name: $('profile-name').value.trim() || 'Новый профиль',
    interfaceLang: $('interface-lang').value.trim(),
    resultLangs: $('results-langs').value.trim(),
    region: $('search-region').value.trim().toUpperCase(),
    queries: normalizeQueries($('queries').value)
  };
  if (profile.profileType === 'standard') {
    if (!sameProfileValues(profile, draft)) {
      const copy = {
        ...draft,
        id: makeId(),
        profileType: 'user',
        sourceStandardId: profile.id,
        sourceStandardName: profile.name,
        copiedAt: new Date().toISOString()
      };
      userProfiles.push(copy);
      rebuildProfiles();
      if (monitorProfileKey === profileKey(profile)) monitorProfileKey = profileKey(copy);
      selectedProfileKey = profileKey(copy);
      profile = copy;
      renderProfileSelectors();
      updateProfileKindText(profile);
    }
  } else {
    Object.assign(profile, draft);
  }
  rebuildProfiles();
  return profile;
}
function addLog(message) {
  const line = document.createElement('div');
  line.textContent = message;
  $('run-log').prepend(line);
}
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  $('profiles-panel').classList.toggle('active', name === 'profiles');
  $('monitor-panel').classList.toggle('active', name === 'monitor');
}
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

$('profile-select').addEventListener('change', async (event) => {
  const nextKey = event.target.value;
  try {
    readProfileFromForm();
    await persistProfiles();
    selectedProfileKey = nextKey;
    await persistProfiles();
    renderProfileSelectors();
    loadProfileIntoForm();
    monitorProfileKey = monitorProfileKey || selectedProfileKey;
    renderMonitorQueries();
    const profile = selectedProfile();
    if (profile?.profileType === 'standard' || profile?.profileType === 'user') {
      autoApplyProfile(profile).catch((error) => setStatus($('capture-status'), error.message || String(error), 'error'));
    }
  } catch (error) {
    setStatus($('save-status'), error.message, 'error');
    renderProfileSelectors();
  }
});
$('new-profile').addEventListener('click', async () => {
  try { readProfileFromForm(); await persistProfiles(); } catch (_) {}
  const profile = { id: makeId(), name: 'Новый профиль', interfaceLang: '', resultLangs: '', region: '', queries: [], profileType: 'user' };
  userProfiles.push(profile);
  rebuildProfiles();
  selectedProfileKey = profileKey(profile);
  await persistProfiles();
  renderProfileSelectors();
  loadProfileIntoForm();
  renderMonitorQueries();
  $('profile-name').focus();
});
$('delete-profile').addEventListener('click', async () => {
  const profile = selectedProfile();
  if (!profile) return;
  if (profile.profileType === 'standard') {
    setStatus($('save-status'), 'Стандартный профиль нельзя удалить. Создайте пользовательскую копию.', 'error');
    return;
  }
  userProfiles = userProfiles.filter((item) => item.id !== profile.id);
  rebuildProfiles();
  selectedProfileKey = profiles[0] ? profileKey(profiles[0]) : null;
  await persistProfiles();
  renderProfileSelectors();
  loadProfileIntoForm();
  renderMonitorQueries();
});
$('queries').addEventListener('input', () => { $('query-count').textContent = String(normalizeQueries($('queries').value).length); });
$('save-profile').addEventListener('click', async () => {
  try {
    const profile = readProfileFromForm();
    await persistProfiles();
    renderProfileSelectors();
    loadProfileIntoForm();
    renderMonitorQueries();
    setStatus($('save-status'), `${profile.profileType === 'standard' ? 'Стандартный профиль не изменён' : 'Сохранено локально'}: ${profile.name}`, 'success');
  } catch (error) { setStatus($('save-status'), error.message, 'error'); }
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$('export-profile').addEventListener('click', async () => {
  try {
    const profile = readProfileFromForm();
    await persistProfiles();
    if (profile.profileType === 'standard') throw new Error('Экспорт доступен для пользовательских профилей. Измените стандартный профиль, чтобы создать копию.');
    const exported = { format: 'google-region-monitor-profile', version: 1, exportedAt: new Date().toISOString(), profile: profileValues(profile) };
    downloadBlob(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json;charset=utf-8' }), `${profile.name.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || 'profile'}.json`);
    setStatus($('save-status'), `Экспортирован профиль «${profile.name}».`, 'success');
  } catch (error) { setStatus($('save-status'), error.message || String(error), 'error'); }
});
$('import-profile').addEventListener('click', () => $('profile-import-file').click());
$('profile-import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const raw = parsed.profile || parsed;
    if (!raw || typeof raw !== 'object' || !String(raw.name || '').trim()) throw new Error('Файл не содержит корректный профиль с названием.');
    const profile = { ...profileValues(raw), id: makeId(), profileType: 'user', importedAt: new Date().toISOString() };
    if (!profile.queries.length && Array.isArray(raw.queries)) profile.queries = raw.queries.map(String);
    userProfiles.push(profile);
    rebuildProfiles();
    selectedProfileKey = profileKey(profile);
    await persistProfiles();
    renderProfileSelectors(); loadProfileIntoForm(); renderMonitorQueries();
    setStatus($('save-status'), `Импортирован профиль «${profile.name}».`, 'success');
  } catch (error) { setStatus($('save-status'), error.message || String(error), 'error'); }
  finally { event.target.value = ''; }
});

$('open-preferences').addEventListener('click', async () => {
  const url = 'https://www.google.com/preferences?lang=1';
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) await chrome.tabs.update(activeTab.id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
});
$('capture-settings').addEventListener('click', async () => {
  const status = $('capture-status'); setStatus(status, 'Читаю открытые настройки Google…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(www\.)?google\.com\/preferences(?:[/?#]|$)/i.test(tab.url || '')) throw new Error('Откройте https://www.google.com/preferences?lang=1 в активной вкладке и повторите.');
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureGooglePreferences });
    const result = injection?.result || {};
    if (result.interfaceLang) $('interface-lang').value = result.interfaceLang;
    if (result.resultLangs?.length) $('results-langs').value = result.resultLangs.join(', ');
    if (result.region) $('search-region').value = result.region;
    const found = [result.interfaceLang && 'язык интерфейса', result.resultLangs?.length && 'языки результатов', result.region && 'регион'].filter(Boolean);
    if (found.length) setStatus(status, `Найдено: ${found.join(', ')}. Проверьте поля и сохраните профиль.`, 'success');
    else setStatus(status, `Google не отдал распознаваемые выбранные значения. Найдено контролов: ${result.controlsFound || 0}.`, 'error');
  } catch (error) { setStatus(status, error.message || String(error), 'error'); }
});
$('apply-settings').addEventListener('click', async () => {
  const status = $('capture-status');
  try {
    const profile = readProfileFromForm(); await persistProfiles();
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(www\.)?google\.com\/preferences(?:[/?#]|$)/i.test(tab.url || '')) {
      if (tab?.id && /^https:\/\/(www\.)?google\.com\//i.test(tab.url || '')) {
        tab = await chrome.tabs.update(tab.id, { url: 'https://www.google.com/preferences?lang=1', active: true });
        await waitForTabComplete(tab.id, 25000);
        tab = await chrome.tabs.get(tab.id);
      } else { tab = await chrome.tabs.create({ url: 'https://www.google.com/preferences?lang=1', active: true }); await waitForTabComplete(tab.id, 25000); }
    }
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: applyGooglePreferences, args: [{ interfaceLang: profile.interfaceLang, resultLangs: profile.resultLangs, region: profile.region }] });
    const result = injection?.result || {};
    const summary = result.changed?.length ? `Применены: ${result.changed.join(', ')}.` : 'Настройки не применены.';
    const missing = result.notFound?.length ? ` Не распознаны: ${result.notFound.join(', ')}.` : '';
    setStatus(status, summary + missing + (result.saveClicked ? ' Подтверждения Google нажаты.' : ' Проверьте страницу Google.'), result.changed?.length ? 'success' : 'error');
  } catch (error) { setStatus(status, error.message || String(error), 'error'); }
});

async function captureGooglePreferences() {
  // Google Preferences uses custom dialogs, not native <select> controls.
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalize = (value) => clean(value).toLocaleLowerCase();
  const getControl = (pid) => document.querySelector(`.lnnMGf[data-pid="${pid}"]`);
  const getDialog = (control) => control?.querySelector('[role="dialog"]')
    || control?.querySelector('g-dialog [role="dialog"]')
    || null;
  const getSelectedText = (dialog, selector) => {
    const item = dialog?.querySelector(selector);
    return item ? clean(item.querySelector('[jsname="ibnC6b"]')?.textContent || item.innerText || item.textContent) : '';
  };
  const findCodeByLabel = (control, selector, label) => {
    if (!control || !label) return '';
    const wanted = normalize(label);
    const nodes = [...control.querySelectorAll(selector)];
    const matched = nodes.find((node) => {
      const candidate = normalize(node.textContent);
      return candidate && (wanted === candidate || wanted.startsWith(candidate + ' ') || candidate.startsWith(wanted + ' '));
    });
    return matched?.getAttribute('data-value') || '';
  };

  const hlControl = getControl('hl');
  const lrControl = getControl('lr');
  const glControl = getControl('gl');

  const hlDialog = getDialog(hlControl);
  const hlLabel = getSelectedText(hlDialog, '[role="option"][aria-selected="true"], [role="option"].CB8nDe');
  let interfaceLang = findCodeByLabel(hlControl, '.vFhVge [data-value]', hlLabel);
  if (!interfaceLang) {
    // On some versions the currently selected language is also exposed as the root document language.
    const docLang = clean(document.documentElement.lang);
    if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(docLang)) interfaceLang = docLang;
  }

  const glDialog = getDialog(glControl);
  const glLabel = getSelectedText(glDialog, '[role="option"][aria-selected="true"], [role="option"].CB8nDe');
  const region = findCodeByLabel(glControl, '.vFhVge [data-value]', glLabel);

  const lrDialog = getDialog(lrControl);
  const selectedItems = [...(lrDialog?.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"], [role="menuitemcheckbox"].CB8nDe') || [])];
  const rawMap = lrControl?.querySelector('[data-alllangmap]')?.getAttribute('data-alllangmap') || '';
  const languageMap = rawMap.split(';').map((entry) => {
    const [code, label] = entry.split('|');
    return { code: clean(code).replace(/^lang_/i, ''), label: clean(label) };
  }).filter((entry) => entry.code && entry.label);
  const resultLangs = [];
  for (const item of selectedItems) {
    const itemText = clean(item.querySelector('[jsname="ibnC6b"]')?.textContent || item.innerText || item.textContent);
    const match = languageMap.find((entry) => {
      const label = normalize(entry.label);
      const text = normalize(itemText);
      return text === label || text.startsWith(label + ' ') || text.startsWith(label + '(');
    });
    if (match) resultLangs.push(match.code);
  }

  return {
    interfaceLang: clean(interfaceLang),
    resultLangs: [...new Set(resultLangs)],
    region: clean(region),
    controlsFound: [hlControl, lrControl, glControl].filter(Boolean).length
  };
}

async function applyGooglePreferences(settings) {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const normalize = (value) => clean(value).toLocaleLowerCase();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const getControl = (pid) => document.querySelector(`.lnnMGf[data-pid="${pid}"]`);
  const getDialog = (control) => control?.querySelector('[role="dialog"]')
    || control?.querySelector('g-dialog [role="dialog"]')
    || null;
  const findConfirm = (dialog) => {
    const buttons = [...(dialog?.querySelectorAll('button,[role="button"]') || [])];
    return buttons.find((button) => /^(confirm|ok|apply|save|done|确定|確認|确认|適用|保存|сохранить|применить|подтвердить|готово|aceptar|valider|bevestigen)$/i.test(
      clean(button.innerText || button.textContent || button.getAttribute('aria-label'))
    )) || buttons[buttons.length - 1] || null;
  };
  const textForCode = (control, code) => {
    const wanted = clean(code).replace(/^lang_/i, '').toLowerCase();
    return [...(control?.querySelectorAll('.vFhVge [data-value]') || [])]
      .find((node) => clean(node.getAttribute('data-value')).toLowerCase() === wanted)
      ?.textContent || '';
  };
  const matchMenuItem = (dialog, selector, mappedText) => {
    const wanted = normalize(mappedText);
    if (!wanted) return null;
    return [...(dialog?.querySelectorAll(selector) || [])].find((item) => {
      const label = normalize(item.querySelector('[jsname="ibnC6b"]')?.textContent || item.innerText || item.textContent);
      return label === wanted || label.startsWith(wanted + ' ') || label.startsWith(wanted + '(');
    }) || null;
  };
  const confirmDialog = async (dialog) => {
    const button = findConfirm(dialog);
    if (!button) return false;
    button.click();
    await delay(350);
    return true;
  };

  const changed = [];
  const notFound = [];

  // Interface language (hl): map language code to Google's localized option label.
  if (clean(settings.interfaceLang)) {
    const control = getControl('hl');
    const wantedLabel = textForCode(control, settings.interfaceLang);
    if (control && wantedLabel) {
      control.click();
      await delay(220);
      const dialog = getDialog(control);
      const item = matchMenuItem(dialog, '[role="option"]', wantedLabel);
      if (dialog && item) {
        const alreadySelected = item.getAttribute('aria-selected') === 'true' || item.classList.contains('CB8nDe');
        if (!alreadySelected) item.click();
        if (await confirmDialog(dialog)) changed.push('язык интерфейса');
      } else notFound.push('язык интерфейса');
    } else notFound.push('язык интерфейса');
  }

  // Result language filter (lr): the custom menu exposes checked items and data-alllangmap.
  {
    const control = getControl('lr');
    if (control) {
      const rawMap = control.querySelector('[data-alllangmap]')?.getAttribute('data-alllangmap') || '';
      const languageMap = rawMap.split(';').map((entry) => {
        const [code, label] = entry.split('|');
        return { code: clean(code).replace(/^lang_/i, '').toLowerCase(), label: clean(label) };
      }).filter((entry) => entry.code && entry.label);
      const wantedCodes = clean(settings.resultLangs).split(',').map((value) => value.trim().replace(/^lang_/i, '').toLowerCase()).filter(Boolean);
      if (wantedCodes.length > 8) {
        throw new Error('Google позволяет выбрать не более 8 языков фильтрации.');
      }
      control.click();
      await delay(220);
      const dialog = getDialog(control);
      const items = [...(dialog?.querySelectorAll('[role="menuitemcheckbox"]') || [])];
      if (dialog && items.length) {
        let allFound = true;
        for (const code of wantedCodes) {
          if (!languageMap.some((entry) => entry.code === code)) allFound = false;
        }
        for (const item of items) {
          const itemText = normalize(item.querySelector('[jsname="ibnC6b"]')?.textContent || item.innerText || item.textContent);
          const mapEntry = languageMap.find((entry) => {
            const label = normalize(entry.label);
            return itemText === label || itemText.startsWith(label + ' ') || itemText.startsWith(label + '(');
          });
          if (!mapEntry) continue;
          const shouldBeChecked = wantedCodes.includes(mapEntry.code);
          const isChecked = item.getAttribute('aria-checked') === 'true' || item.classList.contains('CB8nDe');
          if (shouldBeChecked !== isChecked) {
            item.click();
            await delay(35);
          }
        }
        if (allFound && await confirmDialog(dialog)) changed.push('языки результатов');
        else notFound.push('языки результатов');
      } else notFound.push('языки результатов');
    } else notFound.push('языки результатов');
  }

  // Search region (gl): map ISO country code to the localized country option.
  if (clean(settings.region)) {
    const control = getControl('gl');
    const wantedLabel = textForCode(control, settings.region);
    if (control && wantedLabel) {
      control.click();
      await delay(220);
      const dialog = getDialog(control);
      const item = matchMenuItem(dialog, '[role="option"]', wantedLabel);
      if (dialog && item) {
        const alreadySelected = item.getAttribute('aria-selected') === 'true' || item.classList.contains('CB8nDe');
        if (!alreadySelected) item.click();
        if (await confirmDialog(dialog)) changed.push('регион поиска');
      } else notFound.push('регион поиска');
    } else notFound.push('регион поиска');
  }

  return { changed, notFound, saveClicked: changed.length > 0 };
}

async function autoApplyProfile(profile) {
  const status = $('capture-status');
  setStatus(status, `Применяю профиль «${profile.name}» в Google…`);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onPreferences = /^https:\/\/(www\.)?google\.com\/preferences(?:[/?#]|$)/i.test(activeTab?.url || '');
  let targetTab = activeTab;
  let shouldClose = false;
  if (!onPreferences) {
    targetTab = await chrome.tabs.create({ url: 'https://www.google.com/preferences?lang=1', active: false });
    shouldClose = true;
    await waitForTabComplete(targetTab.id, 25000);
    targetTab = await chrome.tabs.get(targetTab.id);
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: applyGooglePreferences,
      args: [{ interfaceLang: profile.interfaceLang, resultLangs: profile.resultLangs, region: profile.region }]
    });
    const result = injection?.result || {};
    if (result.changed?.length) {
      const missing = result.notFound?.length ? ` Не найдены: ${result.notFound.join(', ')}.` : '';
      setStatus(status, `Профиль выбран. Google: ${result.changed.join(', ')}.${missing}`, 'success');
    } else {
      setStatus(status, `Профиль выбран, но Preferences не подтвердил настройки.${result.notFound?.length ? ` Не найдены: ${result.notFound.join(', ')}.` : ''} Мониторинг всё равно передаст hl/lr/gl в URL поиска.`, 'error');
    }
  } finally {
    if (shouldClose) {
      // Небольшая пауза даёт странице обработать событие сохранения Google.
      await sleep(1000);
      try { await chrome.tabs.remove(targetTab.id); } catch (_) {}
    }
  }
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const initial = await chrome.tabs.get(tabId);
  if (initial.status === 'complete') return initial;
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('Истекло время ожидания загрузки Google.')), timeoutMs);
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(null, tab);
    };
    function finish(error, tab) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish(null, tab);
    }).catch((err) => finish(err));
  });
}

$('monitor-profile').addEventListener('change', async (event) => {
  monitorProfileKey = event.target.value;
  await chrome.storage.local.set({ monitorProfileKey });
  renderMonitorQueries();
});
function renderMonitorQueries() {
  const profile = getProfileByKey(monitorProfileKey) || selectedProfile();
  const container = $('monitor-query-list');
  container.replaceChildren();
  const queries = profile?.queries || [];
  if (!queries.length) {
    container.textContent = 'В выбранном профиле пока нет запросов.';
    container.classList.add('empty-state');
    return;
  }
  container.classList.remove('empty-state');
  queries.forEach((query, index) => {
    const label = document.createElement('label'); label.className = 'query-check';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.dataset.queryIndex = String(index);
    const text = document.createElement('span'); text.textContent = query;
    label.append(checkbox, text); container.append(label);
  });
}
$('select-all-queries').addEventListener('click', () => $('monitor-query-list').querySelectorAll('input[type="checkbox"]').forEach((box) => { box.checked = true; }));
$('clear-queries').addEventListener('click', () => $('monitor-query-list').querySelectorAll('input[type="checkbox"]').forEach((box) => { box.checked = false; }));

function createSearchUrl(query, profile, period, start = 0) {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');
  if (start) url.searchParams.set('start', String(start));
  if (profile.interfaceLang) url.searchParams.set('hl', profile.interfaceLang.trim());
  if (profile.region) url.searchParams.set('gl', profile.region.trim().toUpperCase());
  const langs = (profile.resultLangs || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (langs.length) {
    const codes = langs.map((value) => value.startsWith('lang_') ? value : `lang_${value}`);
    url.searchParams.set('lr', codes.join('|'));
  }
  if (period !== 'all') url.searchParams.set('tbs', `qdr:${period}`);
  return url.toString();
}

function extractGoogleResults() {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const pageText = clean(document.body?.innerText || '');
  const blocked = /unusual traffic|automated queries|captcha|sorry\/index|our systems have detected/i.test(pageText)
    || !!document.querySelector('form#captcha-form, iframe[src*="recaptcha"], #recaptcha');
  if (blocked) return { blocked: true, title: document.title, url: location.href, results: [], nextUrl: null, reason: 'Google показал CAPTCHA или ограничение автоматических запросов.' };
  if (/before you continue to google|before you proceed|прежде чем продолжить/i.test(pageText) && !document.querySelector('#search')) {
    return { blocked: true, title: document.title, url: location.href, results: [], nextUrl: null, reason: 'Google показал страницу согласия с условиями/cookie.' };
  }

  const searchRoot = document.querySelector('#search');
  const organicRoot = document.querySelector('#rso') || searchRoot;
  const seen = new Set();
  const results = [];
  const containers = organicRoot ? [...organicRoot.querySelectorAll('.MjjYud, .g, [data-sokoban-container]')] : [];
  const candidates = containers.length ? containers : [...(organicRoot || document).querySelectorAll('h3')].map((heading) => heading.closest('div') || heading.parentElement);

  for (const container of candidates) {
    const headings = [...(container.querySelectorAll?.('h3') || [])];
    for (const heading of headings) {
      const anchor = heading.closest('a[href]');
      if (!anchor) continue;
      let target;
      try { target = new URL(anchor.getAttribute('href'), location.origin); } catch (_) { continue; }
      const href = target.href;
      if (!/^https?:$/.test(target.protocol)) continue;
      if (/(^|\.)google\.[a-z.]+$/i.test(target.hostname) && /\/(search|preferences|aclk|url|sorry)(\/|\?|$)/i.test(target.pathname)) continue;
      if (target.hostname === 'translate.google.com' || target.hostname.endsWith('.googleusercontent.com')) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const block = heading.closest('.MjjYud, .g, [data-sokoban-container]') || container;
      const snippetNode = block.querySelector?.('.VwiC3b, .yXK7lf, .GI74Re, .ITZIwc, .IsZvec, [data-sncf], .aCOpRe');
      let snippet = clean(snippetNode?.innerText || snippetNode?.textContent || '');
      if (!snippet) {
        const text = clean(block.innerText || block.textContent || '');
        const title = clean(heading.innerText || heading.textContent);
        snippet = text.startsWith(title) ? text.slice(title.length).trim() : text;
      }
      const displayUrl = clean(block.querySelector?.('cite')?.innerText || '');
      results.push({
        title: clean(heading.innerText || heading.textContent),
        url: href,
        snippet: snippet.slice(0, 1800),
        displayUrl
      });
    }
  }

  // In the supplied Google HTML (Indonesian UI), pagination is a#pnnext and organic
  // result cards are #rso .MjjYud. Keep aria-label fallbacks for alternate locales.
  const next = document.querySelector('#botstuff a#pnnext[href], a#pnnext[href], a[aria-label*="Next" i][href], a[aria-label*="Berikutnya" i][href], a[aria-label*="Следующая" i][href]');
  const pageUrl = new URL(location.href);
  return {
    blocked: false,
    title: document.title,
    url: location.href,
    pageLanguage: document.documentElement.lang || pageUrl.searchParams.get('hl') || '',
    searchParams: {
      hl: pageUrl.searchParams.get('hl') || '',
      gl: pageUrl.searchParams.get('gl') || '',
      lr: pageUrl.searchParams.get('lr') || '',
      tbs: pageUrl.searchParams.get('tbs') || ''
    },
    results,
    nextUrl: next?.href || null,
    totalText: clean(document.querySelector('#result-stats')?.innerText || document.querySelector('#result-stats')?.textContent || '')
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function createReportHtml(report) {
  const rows = report.queries.map((queryReport) => {
    const pages = queryReport.pages.map((page, pageIndex) => {
      const resultCards = page.results.map((result, index) => `
        <article class="result">
          <div class="result-number">${index + 1}. Страница ${pageIndex + 1}</div>
          <h3><a href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.title)}</a></h3>
          <div class="url"><a href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.url)}</a></div>
          <p>${escapeHtml(result.snippet)}</p>
        </article>`).join('');
      return `<section class="page"><h3>Страница ${pageIndex + 1}</h3><p class="meta">${escapeHtml(page.totalText || page.url)}</p>${resultCards || '<p>Результаты не найдены или не распознаны.</p>'}</section>`;
    }).join('');
    return `<section class="query"><h2>Запрос: ${escapeHtml(queryReport.query)}</h2>${queryReport.error ? `<p class="warning">${escapeHtml(queryReport.error)}</p>` : ''}${pages}</section>`;
  }).join('');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Search Report — ${escapeHtml(report.profile.name)}</title>
<style>
:root{font-family:Arial,Helvetica,sans-serif;color:#202124;background:#f7f8fa}body{margin:0;padding:28px;max-width:1100px;margin-inline:auto}header{padding:22px;background:#fff;border:1px solid #e3e6eb;border-radius:14px;margin-bottom:22px}h1{font-size:24px;margin:0 0 10px}h2{font-size:19px;margin:0 0 14px}h3{font-size:15px;margin:6px 0}p{line-height:1.5}.meta,.url{font-size:12px;color:#687078;overflow-wrap:anywhere}.query{padding:18px;background:#fff;border:1px solid #e3e6eb;border-radius:14px;margin:16px 0}.page{border-top:1px solid #e9ecef;padding-top:12px;margin-top:14px}.result{padding:12px 0;border-top:1px dashed #e5e8ec}.result:first-of-type{border-top:0}.result-number{font-size:11px;color:#687078}.result a{color:#1558b0;text-decoration:none}.result a:hover{text-decoration:underline}.result p{margin:7px 0}.warning{color:#a50e0e;background:#fce8e6;padding:10px;border-radius:8px}footer{color:#687078;font-size:11px;margin-top:20px}@media print{body{padding:0;background:#fff}.query,header{break-inside:avoid}}
</style></head><body>
<header><h1>Отчёт мониторинга Google</h1><p><b>Профиль:</b> ${escapeHtml(report.profile.name)}<br><b>Язык интерфейса:</b> ${escapeHtml(report.profile.interfaceLang || 'не задан')}<br><b>Языки результатов:</b> ${escapeHtml(report.profile.resultLangs || 'без фильтра')}<br><b>Регион:</b> ${escapeHtml(report.profile.region || 'по умолчанию')}<br><b>Период:</b> ${escapeHtml(report.periodLabel)}<br><b>Создан:</b> ${escapeHtml(report.createdAt)}<br><b>Запросов:</b> ${report.queries.length}</p></header>
${rows}
<footer>Отчёт создан расширением Google Region Monitor. Ссылки на результаты открываются в новых вкладках.</footer></body></html>`;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function navigateTabAndExtract(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: false });
  await waitForTabComplete(tabId, 35000);
  await sleep(900);
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: extractGoogleResults });
  return injection?.result || { blocked: true, reason: 'Не удалось прочитать страницу Google.', results: [] };
}

$('run-report').addEventListener('click', async () => {
  if (isRunning) return;
  // Сначала сохранить правки в редакторе профилей.
  try { readProfileFromForm(); await persistProfiles(); } catch (_) {}
  renderProfileSelectors();
  renderMonitorQueries();
  const profile = getProfileByKey(monitorProfileKey || $('monitor-profile').value);
  if (!profile) {
    setStatus($('run-status'), 'Выберите профиль.', 'error');
    return;
  }
  const selectedBoxes = [...$('monitor-query-list').querySelectorAll('input[type="checkbox"]:checked')];
  const queryList = selectedBoxes.map((box) => profile.queries[Number(box.dataset.queryIndex)]).filter(Boolean);
  if (!queryList.length) {
    setStatus($('run-status'), 'Выберите хотя бы один поисковый запрос.', 'error');
    return;
  }
  const maxPages = Math.max(1, Math.min(10, Number($('max-pages').value) || 3));
  const period = $('period').value;
  const periodLabel = $('period').selectedOptions[0].textContent;
  const totalSteps = queryList.length * maxPages;
  let completedSteps = 0;
  isRunning = true;
  $('run-report').disabled = true;
  $('run-log').replaceChildren();
  $('progress-bar').style.width = '0%';
  setStatus($('run-status'), `Запуск: ${queryList.length} запрос(ов), до ${maxPages} страниц на запрос…`);
  let tabId = null;
  const report = {
    profile: { ...profile },
    periodLabel,
    createdAt: new Date().toLocaleString('ru-RU'),
    queries: []
  };
  try {
    const firstUrl = createSearchUrl(queryList[0], profile, period, 0);
    const tab = await chrome.tabs.create({ url: firstUrl, active: false });
    tabId = tab.id;
    for (let queryIndex = 0; queryIndex < queryList.length; queryIndex++) {
      const query = queryList[queryIndex];
      const queryReport = { query, pages: [], error: '' };
      report.queries.push(queryReport);
      addLog(`Запрос ${queryIndex + 1}/${queryList.length}: ${query}`);
      let nextUrl = createSearchUrl(query, profile, period, 0);
      const visited = new Set();
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        if (visited.has(nextUrl)) break;
        visited.add(nextUrl);
        try {
          const data = await navigateTabAndExtract(tabId, nextUrl);
          completedSteps++;
          $('progress-bar').style.width = `${Math.min(100, completedSteps / totalSteps * 100)}%`;
          if (data.blocked) {
            queryReport.error = data.reason || 'Google ограничил автоматический просмотр страницы.';
            addLog(`Остановка: ${queryReport.error}`);
            break;
          }
          queryReport.pages.push(data);
          addLog(`  Страница ${pageIndex + 1}: найдено результатов — ${data.results.length}`);
          if (!data.results.length) break;
          if (pageIndex + 1 >= maxPages) break;
          if (data.nextUrl) nextUrl = data.nextUrl;
          else if (data.results.length >= 10) {
            // Запасной путь, если Google изменил разметку ссылки пагинации.
            const parsed = new URL(nextUrl);
            const currentStart = Number(parsed.searchParams.get('start') || 0);
            parsed.searchParams.set('start', String(currentStart + 10));
            nextUrl = parsed.toString();
          } else {
            break;
          }
          await sleep(1400);
        } catch (error) {
          queryReport.error = error.message || String(error);
          addLog(`Ошибка: ${queryReport.error}`);
          break;
        }
      }
    }
    const html = createReportHtml(report);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const filename = `google-report-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    $('progress-bar').style.width = '100%';
    setStatus($('run-status'), `Готово. HTML-отчёт сформирован: ${report.queries.reduce((sum, q) => sum + q.pages.reduce((s, p) => s + p.results.length, 0), 0)} результатов.`, 'success');
  } catch (error) {
    setStatus($('run-status'), error.message || String(error), 'error');
  } finally {
    if (tabId !== null) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
    isRunning = false;
    $('run-report').disabled = false;
  }
});

// GitHub Release checker and standard-profile publisher/synchronizer.
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
let latestUpdateUrl = '';
let latestUpdateVersion = '';

function parseVersion(value) {
  const parts = String(value || '').replace(/^v/i, '').match(/\d+/g);
  return parts ? parts.slice(0, 3).map(Number) : [0, 0, 0];
}
function isVersionNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}
function getGitHubSettingsFromConfig(token = '') {
  const cfg = globalThis.GITHUB_CONFIG || {};
  const repo = `${String(cfg.owner || '').trim()}/${String(cfg.repository || '').trim()}`;
  const branch = String(cfg.branch || 'main').trim();
  const path = String(cfg.standardProfilesPath || 'config/standard-profiles.json').trim();
  return { repo, branch, path, token: String(token || '').trim() };
}
async function getGitHubSettings() {
  const stored = await chrome.storage.local.get({ githubToken: '' });
  return getGitHubSettingsFromConfig(stored.githubToken);
}
async function saveGitHubToken() {
  const token = $('github-token').value.trim();
  await chrome.storage.local.set({ githubToken: token });
  $('publish-profile').hidden = !token;
  return token;
}

function validGitHubSettings({ repo, branch, path }) {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)
    && !!branch && !branch.includes('..')
    && !!path && !path.startsWith('/') && !path.split('/').includes('..');
}

async function refreshProfilesFromStorage() {
  const stored = await chrome.storage.local.get({ standardProfiles: [] });
  standardProfiles = Array.isArray(stored.standardProfiles) ? stored.standardProfiles.map((p) => ({ ...p, profileType: 'standard' })) : [];
  rebuildProfiles();
  if (!getProfileByKey(selectedProfileKey)) selectedProfileKey = profiles[0] ? profileKey(profiles[0]) : null;
  if (!getProfileByKey(monitorProfileKey)) monitorProfileKey = selectedProfileKey;
  renderProfileSelectors();
  if (selectedProfile()) loadProfileIntoForm();
  renderMonitorQueries();
}
async function requestStandardSync(force = true, silent = false) {
  const settings = await getGitHubSettings();
  const status = $('standard-sync-status');
  if (!validGitHubSettings(settings)) {
    if (!silent) setStatus(status, 'Укажите репозиторий, ветку и путь к JSON-файлу стандартных профилей.', 'error');
    return null;
  }
  if (!silent) setStatus(status, 'Загружаю стандартные профили из GitHub…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SYNC_STANDARD_PROFILES', force });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось синхронизировать стандартные профили.');
    await refreshProfilesFromStorage();
    const last = result.syncedAt ? new Date(result.syncedAt).toLocaleString('ru-RU') : '';
    const suffix = result.skipped ? 'Актуальная копия уже есть на устройстве.' : `Загружено профилей: ${result.count}.`;
    setStatus(status, `${suffix}${last ? ` Последняя синхронизация: ${last}.` : ''}`, 'success');
    return result;
  } catch (error) {
    if (!silent) setStatus(status, error.message || String(error), 'error');
    return { ok: false, error: error.message || String(error) };
  }
}

$('github-token').addEventListener('input', () => {
  $('publish-profile').hidden = !$('github-token').value.trim();
});
$('github-token').addEventListener('change', () => saveGitHubToken().catch(() => {}));

async function checkGitHubUpdates(silent = false) {
  const settings = await getGitHubSettings();
  const status = $('update-status');
  // One action checks the extension release and refreshes standard profiles.
  const syncResult = await requestStandardSync(!silent, true);
  if (!silent) {
    if (syncResult?.ok) setStatus($('standard-sync-status'), syncResult.skipped ? 'Стандартные профили уже актуальны.' : `Стандартные профили обновлены: ${syncResult.count}.`, 'success');
    else if (syncResult?.error) setStatus($('standard-sync-status'), `Не удалось обновить стандартные профили: ${syncResult.error}`, 'error');
  }
  $('download-update').hidden = true;
  latestUpdateUrl = '';
  latestUpdateVersion = '';
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(settings.repo)) {
    if (!silent) setStatus(status, 'Проверьте owner и repository в файле github-config.js.', 'error');
    return;
  }
  if (!silent) setStatus(status, 'Проверяю последнюю версию на GitHub…');
  try {
    const response = await fetch(`https://api.github.com/repos/${settings.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (!response.ok) {
      if (response.status === 404) throw new Error('Релиз не найден. Опубликуйте GitHub Release с ZIP-архивом.');
      if (response.status === 403) throw new Error('GitHub ограничил частоту запросов. Повторите проверку позже.');
      throw new Error(`GitHub API: HTTP ${response.status}.`);
    }
    const release = await response.json();
    const releaseVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
    const asset = (release.assets || []).find((item) => item.name === 'google-region-monitor.zip')
      || (release.assets || []).find((item) => /google.*region.*monitor.*\.zip$/i.test(item.name));
    if (!asset?.browser_download_url) throw new Error('В релизе нет файла google-region-monitor.zip.');
    if (isVersionNewer(releaseVersion, EXTENSION_VERSION)) {
      latestUpdateUrl = asset.browser_download_url;
      latestUpdateVersion = releaseVersion;
      $('download-update').textContent = `Скачать v${releaseVersion}`;
      $('download-update').hidden = false;
      setStatus(status, `Доступна версия ${releaseVersion} (установлена ${EXTENSION_VERSION}). После скачивания распакуйте архив и перезагрузите расширение.`, 'success');
    } else {
      setStatus(status, `Установлена последняя версия: ${EXTENSION_VERSION}.`);
    }
  } catch (error) {
    if (!silent || settings.repo) setStatus(status, error.message || String(error), 'error');
  }
}
$('check-updates').addEventListener('click', () => checkGitHubUpdates(false));
$('download-update').addEventListener('click', async () => {
  if (!latestUpdateUrl) return;
  try {
    await chrome.downloads.download({ url: latestUpdateUrl, filename: `google-region-monitor-v${latestUpdateVersion}.zip`, conflictAction: 'uniquify', saveAs: true });
    setStatus($('update-status'), 'Загрузка обновления запущена. Распакуйте архив и перезагрузите расширение на chrome://extensions.', 'success');
  } catch (error) {
    setStatus($('update-status'), error.message || String(error), 'error');
  }
});

function slugify(value, fallback = `profile-${Date.now()}`) {
  const transliteration = { а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'yo', ж:'zh', з:'z', и:'i', й:'i', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh', щ:'shch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya' };
  const source = String(value || '').toLowerCase().replace(/[а-яё]/g, (char) => transliteration[char] ?? char);
  const slug = source.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return slug || fallback;
}
function profileToConfigEntry(profile, id) {
  return {
    id,
    name: profile.name,
    interfaceLang: profile.interfaceLang || '',
    resultLangs: profile.resultLangs || '',
    region: profile.region || '',
    queries: [...(profile.queries || [])]
  };
}
function getStandardIdForUserProfile(profile, existingEntries = standardProfiles) {
  if (profile.publishedStandardId) return String(profile.publishedStandardId);
  const used = new Set(existingEntries.map((item) => String(item.id)));
  const base = slugify(profile.name, `profile-${profile.id}`);
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  return id;
}
function makeStandardConfig(extraProfile = null) {
  const entries = standardProfiles.map((profile) => profileToConfigEntry(profile, profile.id));
  if (extraProfile) {
    const id = getStandardIdForUserProfile(extraProfile, entries);
    const entry = profileToConfigEntry(extraProfile, id);
    const existingIndex = entries.findIndex((item) => item.id === id);
    if (existingIndex >= 0) entries[existingIndex] = entry;
    else entries.push(entry);
  }
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), profiles: entries };
}
function downloadJsonFile(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function decodeBase64Utf8(value) {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function publishUserProfileToGitHub(profile) {
  const settings = await getGitHubSettings();
  if (!validGitHubSettings(settings)) throw new Error('Сначала заполните репозиторий, ветку и путь к файлу стандартных профилей.');
  // Always refresh before modifying the remote config, so we don't overwrite a newer list.
  const syncResult = await requestStandardSync(true, true);
  if (!syncResult?.ok) throw new Error('Сначала синхронизируйте стандартные профили из GitHub.');
  const standardId = getStandardIdForUserProfile(profile, standardProfiles);

  if (!settings.token) throw new Error('Для публикации профиля заполните GitHub Fine-grained token.');

  const apiUrl = `https://api.github.com/repos/${settings.repo}/contents/${settings.path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${settings.token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  let sha;
  const getResponse = await fetch(`${apiUrl}?ref=${encodeURIComponent(settings.branch)}`, { headers });
  if (getResponse.ok) {
    const remoteFile = await getResponse.json();
    sha = remoteFile.sha;
    // Rebase on the latest file before PUT, protecting edits made after the sync request.
    if (remoteFile.content) {
      let remoteConfig;
      try { remoteConfig = JSON.parse(decodeBase64Utf8(remoteFile.content)); } catch (_) { throw new Error('Не удалось разобрать текущий JSON в GitHub.'); }
      if (!Array.isArray(remoteConfig.profiles)) throw new Error('В GitHub JSON отсутствует массив profiles. Публикация отменена, чтобы не затереть файл.');
      const remoteProfiles = remoteConfig.profiles;
      const id = getStandardIdForUserProfile(profile, remoteProfiles);
      const existingIndex = remoteProfiles.findIndex((item) => String(item.id || '') === id);
      const entry = profileToConfigEntry(profile, id);
      if (existingIndex >= 0) remoteProfiles[existingIndex] = entry;
      else remoteProfiles.push(entry);
      remoteConfig.schemaVersion = 1;
      remoteConfig.updatedAt = new Date().toISOString();
      remoteConfig.profiles = remoteProfiles;
      const body = JSON.stringify(remoteConfig, null, 2);
      const putResponse = await fetch(apiUrl, {
        method: 'PUT', headers,
        body: JSON.stringify({ message: `Add standard profile: ${profile.name}`, content: encodeBase64Utf8(body), sha, branch: settings.branch })
      });
      if (!putResponse.ok) throw new Error(`GitHub не принял изменение (HTTP ${putResponse.status}). Проверьте Contents: Read and write и ветку.`);
      return id;
    }
  } else if (getResponse.status !== 404) {
    throw new Error(`Не удалось прочитать файл конфигурации GitHub (HTTP ${getResponse.status}).`);
  }

  // Create file only if it does not exist yet.
  const body = JSON.stringify(config, null, 2);
  const putResponse = await fetch(apiUrl, {
    method: 'PUT', headers,
    body: JSON.stringify({ message: `Add standard profile: ${profile.name}`, content: encodeBase64Utf8(body), ...(sha ? { sha } : {}), branch: settings.branch })
  });
  if (!putResponse.ok) throw new Error(`GitHub не принял изменение (HTTP ${putResponse.status}). Проверьте Contents: Read and write и ветку.`);
  return standardId;
}

$('publish-profile').addEventListener('click', async () => {
  let profile;
  try {
    profile = readProfileFromForm();
    await persistProfiles();
    if (!profile || profile.profileType === 'standard') throw new Error('Сначала сохраните изменения как пользовательскую копию.');
    await saveGitHubToken();
    const settings = await getGitHubSettings();
    if (!settings.token) throw new Error('Для публикации профиля заполните GitHub Fine-grained token.');
    setStatus($('standard-sync-status'), 'Добавляю профиль в стандартную конфигурацию GitHub…');
    const result = await publishUserProfileToGitHub(profile);
    profile.publishedStandardId = result?.id || result;
    await persistProfiles();
    await requestStandardSync(true, true);
    setStatus($('standard-sync-status'), `Профиль опубликован в GitHub как «${result}». Стандартный список обновлён.`, 'success');
  } catch (error) {
    setStatus($('standard-sync-status'), error.message || String(error), 'error');
  }
});


async function initializeGitHubFeatures() {
  const stored = await chrome.storage.local.get({ githubToken: '' });
  $('github-token').value = stored.githubToken || '';
  $('publish-profile').hidden = !String(stored.githubToken || '').trim();
  const settings = await getGitHubSettings();
  if (validGitHubSettings(settings)) {
    await requestStandardSync(false, true);
    await checkGitHubUpdates(true);
  } else {
    setStatus($('standard-sync-status'), 'Настройте owner и repository в файле github-config.js.', 'error');
  }
}

$('app-version').textContent = `v${EXTENSION_VERSION}`;
loadProfiles().then(initializeGitHubFeatures).catch((error) => setStatus($('save-status'), error.message || String(error), 'error'));

// Reflect a daily background sync in an already-open side panel without touching local profiles.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.standardProfiles) return;
  standardProfiles = Array.isArray(changes.standardProfiles.newValue)
    ? changes.standardProfiles.newValue.map((profile) => ({ ...profile, profileType: 'standard' }))
    : [];
  rebuildProfiles();
  if (!getProfileByKey(selectedProfileKey)) selectedProfileKey = profiles[0] ? profileKey(profiles[0]) : null;
  if (!getProfileByKey(monitorProfileKey)) monitorProfileKey = selectedProfileKey;
  renderProfileSelectors();
  renderMonitorQueries();
  const active = document.activeElement;
  const editing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
  if (!editing && selectedProfile()) loadProfileIntoForm();
});
