// Взаимодействие с веб-версией ChatGPT для проверки региональной принадлежности СМИ.
// Каждый запрос отправляется только после открытия нового пустого чата.
let regionChatGPTProcessing = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === 'REGION_MONITOR_CHATGPT_PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (request?.type !== 'REGION_MONITOR_CHATGPT_PROMPT') return false;
  if (regionChatGPTProcessing) {
    sendResponse({ accepted: false, error: 'ChatGPT content script уже обрабатывает другой запрос.' });
    return false;
  }

  regionChatGPTProcessing = true;
  const requestId = String(request.requestId || '');
  handleRegionPrompt(String(request.prompt || ''))
    .then(({ answer, thinkingMode }) => {
      chrome.runtime.sendMessage({
        type: 'REGION_MONITOR_CHATGPT_RESPONSE',
        requestId,
        answer,
        thinkingMode
      });
    })
    .catch((error) => {
      chrome.runtime.sendMessage({
        type: 'REGION_MONITOR_CHATGPT_RESPONSE',
        requestId,
        error: error?.message || String(error)
      });
    })
    .finally(() => { regionChatGPTProcessing = false; });

  sendResponse({ accepted: true });
  return false;
});

async function handleRegionPrompt(prompt) {
  if (!prompt.trim()) throw new Error('Пустой запрос ChatGPT.');
  const input = await waitForElement(
    'textarea#prompt-textarea, textarea[placeholder*="Message"], textarea[placeholder*="Сообщение"], ' +
    'div[contenteditable="true"][role="textbox"], div.ProseMirror, div[contenteditable="true"]',
    25000
  );
  if (!input) throw new Error('Поле ввода ChatGPT не найдено.');

  const thinkingMode = await enableThinkingMode();
  setComposerValue(input, prompt);

  const sendButton = await waitForEnabledButton(
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Отправить"]',
    'button[aria-label*="Отправить сообщение"]',
    '#composer-submit-button'
  );
  if (!sendButton) throw new Error('Кнопка отправки ChatGPT не найдена или не активна.');

  await sleep(250);
  sendButton.click();
  const answer = await waitForAnswer(300000);
  return { answer, thinkingMode };
}

function setComposerValue(input, value) {
  input.focus();
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    input.focus();
    input.replaceChildren();
    input.textContent = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    input.dispatchEvent(new Event('compositionend', { bubbles: true }));
  }
}

// В новых версиях веб-интерфейса Thinking Standard/Extended отображается как
// Medium/High. Выбираем High, затем Medium; для доступных бесплатных планов
// используем Think из меню композера. Если режим нельзя включить, запрос не идёт.
async function enableThinkingMode() {
  const visible = (element) => {
    if (!element || element.offsetParent === null) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  const textOf = (element) => `${element.innerText || element.textContent || ''} ${element.getAttribute?.('aria-label') || ''}`
    .replace(/\s+/g, ' ').trim();
  const controls = () => [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')].filter(visible);
  const exactMode = (text, mode) => {
    const firstLine = String(text || '').split('\n')[0].trim().toLowerCase();
    const compact = String(text || '').trim().toLowerCase();
    return firstLine === mode || compact === mode || compact.startsWith(`${mode} `) || compact.startsWith(`${mode} ·`);
  };

  await sleep(350);
  let list = controls();
  const pickerSelectors = [
    'button[data-testid*="model" i]',
    '[data-testid*="model-switcher" i]',
    'button[aria-label*="model" i]',
    'button[aria-label*="модел" i]'
  ];
  let picker = null;
  for (const selector of pickerSelectors) {
    picker = [...document.querySelectorAll(selector)].find(visible);
    if (picker) break;
  }
  if (!picker) {
    const composer = document.querySelector('[data-testid*="composer"], form, [class*="composer"]');
    const scope = composer || document;
    const candidates = [...scope.querySelectorAll('button, [role="button"]')].filter(visible);
    picker = candidates.find((element) => /\b(?:GPT[- ]?\d|Instant|Medium|High|Мгновенно|Средний|Высокий)\b/i.test(textOf(element)));
  }

  // Если выбранный режим уже является режимом размышления — оставляем его.
  if (picker) {
    const currentText = textOf(picker);
    if (/\bHigh\b|\bMedium\b|\bThink(?:ing)?\b|Высокий|Средний|Размышлен/i.test(currentText)) {
      if (exactMode(currentText, 'high') || /\bHigh\b|Высокий/i.test(currentText)) return 'High (уже выбран)';
      if (exactMode(currentText, 'medium') || /\bMedium\b|Средний/i.test(currentText)) return 'Medium (уже выбран)';
      if (/\bThink(?:ing)?\b|Размышлен/i.test(currentText)) return 'Think (уже выбран)';
    }
    picker.click();
    await sleep(300);
  }

  const chooseOption = (modes) => {
    const candidates = controls();
    for (const mode of modes) {
      const found = candidates.find((element) => {
        const text = textOf(element);
        if (mode === 'high') return exactMode(text, 'high') || exactMode(text, 'высокий');
        if (mode === 'medium') return exactMode(text, 'medium') || exactMode(text, 'средний');
        return /^(think|thinking|думать|размышлять)(?:\s|$)/i.test(text.trim());
      });
      if (found) {
        found.click();
        return mode === 'high' ? 'High' : mode === 'medium' ? 'Medium' : 'Think';
      }
    }
    return '';
  };

  // Предпочитаем высокий уровень размышления; Medium — доступный запасной вариант.
  let selected = chooseOption(['high', 'medium', 'think']);
  if (selected) {
    await sleep(250);
    return selected;
  }

  // Для тарифов, где Thinking вызывается через кнопку Think в меню «+».
  list = controls();
  const thinkDirect = list.find((element) => /^(think|thinking|думать|размышлять)$/i.test(textOf(element).trim()));
  if (thinkDirect) {
    thinkDirect.click();
    await sleep(250);
    return 'Think';
  }

  const addButton = list.find((element) => {
    const label = textOf(element);
    const aria = element.getAttribute('aria-label') || '';
    return /^(add|more|добавить|больше)$/i.test(label) || /add|more|добавить/i.test(aria);
  });
  if (addButton) {
    addButton.click();
    await sleep(250);
    selected = chooseOption(['think']);
    if (selected) {
      await sleep(250);
      return selected;
    }
  }

  throw new Error('Не удалось включить режим размышления ChatGPT (High, Medium или Think). Проверьте, доступен ли этот режим в вашем аккаунте и виден ли переключатель модели.');
}

function getAssistantMessageNodes() {
  let nodes = document.querySelectorAll('[data-markdown-text-style="assistant-message"]');
  if (nodes.length) return Array.from(nodes);
  nodes = document.querySelectorAll('[data-content-search-unit-key$=":assistant"]');
  if (nodes.length) return Array.from(nodes);
  const headers = document.querySelectorAll('[data-conversation-role="assistant"]');
  if (headers.length) return Array.from(headers)
    .map((header) => header.closest('[data-chatgpt-search-message-ids]') || header.parentElement)
    .filter(Boolean);
  return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
}

function cleanAssistantText(value) {
  return String(value || '').replace(/^\s*(ChatGPT сказал:|ChatGPT said:)\s*/i, '').trim();
}

function waitForAnswer(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let lastText = '';
    let stableCount = 0;
    const started = Date.now();
    const intervalId = setInterval(() => {
      const messages = getAssistantMessageNodes();
      if (!messages.length) return;
      const currentText = cleanAssistantText(messages[messages.length - 1].innerText || messages[messages.length - 1].textContent || '');
      if (!currentText) return;
      const stopButton = document.querySelector(
        'button[aria-label*="Stop"], button[aria-label*="Остановить"], button[data-testid="stop-button"], button[data-testid*="stop" i]'
      );
      if (stopButton && stopButton.offsetParent !== null) {
        stableCount = 0;
        lastText = currentText;
        return;
      }
      if (currentText === lastText) {
        stableCount++;
        if (stableCount >= 4 && currentText.length > 15) {
          clearInterval(intervalId);
          clearTimeout(timeoutId);
          resolve(currentText);
        }
      } else {
        lastText = currentText;
        stableCount = 0;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        reject(new Error('Таймаут ожидания ответа от ChatGPT (5 минут).'));
      }
    }, 500);
    const timeoutId = setTimeout(() => {
      clearInterval(intervalId);
      reject(new Error('Таймаут ожидания ответа от ChatGPT (5 минут).'));
    }, timeoutMs);
  });
}

function waitForElement(selector, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const isVisible = (element) => {
      if (!element || element.offsetParent === null) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const find = () => [...document.querySelectorAll(selector)].find(isVisible) || null;
    const initial = find();
    if (initial) return resolve(initial);
    const observer = new MutationObserver(() => {
      const element = find();
      if (element) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(element);
      }
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Поле ввода ChatGPT не появилось за отведённое время.'));
    }, timeoutMs);
  });
}

function waitForEnabledButton(...selectors) {
  return new Promise((resolve, reject) => {
    const find = () => {
      for (const selector of selectors) {
        const buttons = [...document.querySelectorAll(selector)];
        const button = buttons.find((element) => {
          if (element.disabled || element.offsetParent === null) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
        });
        if (button) return button;
      }
      return null;
    };
    const immediate = find();
    if (immediate) return resolve(immediate);
    const observer = new MutationObserver(() => {
      const button = find();
      if (button) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(button);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'class', 'style'] });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Кнопка отправки ChatGPT не появилась или осталась неактивной.'));
    }, 15000);
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
