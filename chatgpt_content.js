// chatgpt_content.js – с блокировкой параллельной обработки
// ОБНОВЛЕНО: новые селекторы под актуальную разметку ChatGPT (2025+).
// Раньше использовался [data-message-author-role="assistant"] — его больше нет.
// Теперь ответы ищутся по data-markdown-text-style="assistant-message"
// с несколькими фолбэками.

let isProcessing = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "ping") {
    sendResponse({ status: "ok" });
    return true;
  }

  if (request.type === "chatgpt_request") {
    if (isProcessing) {
      console.warn('⚠️ ChatGPT content script уже обрабатывает запрос, отклоняем новый');
      sendResponse({ error: "Already processing another request" });
      return true;
    }

    isProcessing = true;

    handlePrompt(request.prompt, request.expectedId)
      .then(answer => {
        const id = request.expectedId || 'default';
        const key = `chatgpt_response_${id}`;
        console.log("✅ Получен ответ от ChatGPT, сохраняем в storage, длина:", answer.length);
        chrome.runtime.sendMessage({ type: 'chatgpt_response_ready', id, value: answer }, () => {
          if (chrome.runtime.lastError) {
            console.warn('⚠️ Не удалось доставить ответ ChatGPT напрямую в background:', chrome.runtime.lastError.message);
          }
        });
        chrome.storage.local.set({ [key]: answer }, () => {
          if (chrome.runtime.lastError) {
            console.warn("⚠️ Ошибка сохранения ответа ChatGPT в storage:", chrome.runtime.lastError.message);
          } else {
            console.log(`✅ Ответ ChatGPT сохранён в storage с ключом ${key}`);
          }
        });
      })
      .catch(err => {
        const id = request.expectedId || 'default';
        const key = `chatgpt_error_${id}`;
        console.error("❌ Ошибка ChatGPT:", err.message);
        chrome.runtime.sendMessage({ type: 'chatgpt_error_ready', id, value: err.message }, () => {
          if (chrome.runtime.lastError) {
            console.warn('⚠️ Не удалось доставить ошибку ChatGPT напрямую в background:', chrome.runtime.lastError.message);
          }
        });
        chrome.storage.local.set({ [key]: err.message }, () => {
          if (chrome.runtime.lastError) {
            console.warn("⚠️ Ошибка сохранения ошибки ChatGPT в storage:", chrome.runtime.lastError.message);
          }
        });
      })
      .finally(() => {
        isProcessing = false;
      });

    sendResponse({ received: true });
    return true;
  }
});

async function handlePrompt(prompt, expectedId) {
  const input = await waitForElement(
    'textarea#prompt-textarea, ' +
    'textarea[placeholder*="Message"], ' +
    'div[contenteditable="true"][role="textbox"], ' +
    'div.ProseMirror, ' +
    'div[contenteditable="true"]'
  );
  if (!input) throw new Error("Поле ввода ChatGPT не найдено");

  input.focus();
  if (input.tagName === 'TEXTAREA') {
    input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    input.innerText = '';
    input.innerText = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    input.dispatchEvent(new Event('compositionend', { bubbles: true }));
  }

  const sendButton = await waitForEnabledButton(
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Отправить"]',
    'button[aria-label*="Отправить сообщение"]',
    '#composer-submit-button'
  );
  if (!sendButton) throw new Error("Кнопка отправки ChatGPT не найдена или не активна");

  await sleep(200);
  sendButton.click();

  const answer = await waitForAnswer(expectedId);
  return answer;
}

// ==================================================================
//  УСТОЙЧИВЫЙ ПОИСК СООБЩЕНИЙ АССИСТЕНТА
// ==================================================================
// ChatGPT периодически меняет разметку. Ниже — набор селекторов
// от самой актуальной версии к устаревшей. Возвращается первый
// непустой результат.
// ==================================================================
function getAssistantMessageNodes() {
  // 1. Актуальная разметка (2025+): контейнер содержимого ответа.
  //    Именно этот селектор виден в присланном HTML:
  //    <div data-markdown-text-style="assistant-message" class="MarkdownRoot-...">
  let nodes = document.querySelectorAll('[data-markdown-text-style="assistant-message"]');
  if (nodes.length > 0) return Array.from(nodes);

  // 2. Блок-обёртка turn-а: data-content-search-unit-key оканчивается на ":assistant"
  nodes = document.querySelectorAll('[data-content-search-unit-key$=":assistant"]');
  if (nodes.length > 0) return Array.from(nodes);

  // 3. По скрытому заголовку роли — поднимаемся к контейнеру turn-а
  const headers = document.querySelectorAll('[data-conversation-role="assistant"]');
  if (headers.length > 0) {
    return headers
      .map(h => h.closest('[data-chatgpt-search-message-ids]') || h.parentElement)
      .filter(Boolean);
  }

  // 4. Устаревшая разметка (на случай откатов ChatGPT)
  return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
}

// Убираем возможный служебный префикс, если сработал фолбэк на обёртку turn-а
function cleanAssistantText(text) {
  if (!text) return '';
  return text
    .replace(/^\s*(ChatGPT сказал:|ChatGPT said:)\s*/i, '')
    .trim();
}

// ===== ОЖИДАНИЕ ОТВЕТА =====
function waitForAnswer(expectedId) {
  return new Promise((resolve, reject) => {
    let lastText = '';
    let stableCount = 0;
    const checkInterval = 500;
    const stableThreshold = 3;

    const intervalId = setInterval(() => {
      const messages = getAssistantMessageNodes();
      if (messages.length === 0) return;

      const lastMessage = messages[messages.length - 1];
      const rawText = lastMessage.innerText || lastMessage.textContent || '';
      const currentText = cleanAssistantText(rawText);

      if (currentText === '') return;

      // Кнопка "Стоп" — генерация ещё идёт (несколько вариантов aria-label/testid)
      const stopButton =
           document.querySelector('button[aria-label*="Stop"]')
        || document.querySelector('button[aria-label*="Остановить"]')
        || document.querySelector('button[data-testid="stop-button"]')
        || document.querySelector('button[data-testid*="stop"]');
      if (stopButton && stopButton.offsetParent !== null) {
        stableCount = 0;
        lastText = currentText;
        return;
      }

      const hasExpectedId = expectedId
        ? new RegExp(`"id"\\s*:\\s*"${expectedId}"`).test(currentText)
        : false;
      const isLongEnough = currentText.length > 40;
      const isLikelyComplete =
           currentText.trim().endsWith('}')
        || currentText.trim().endsWith('"}')
        || currentText.trim().endsWith(']')
        || currentText.trim().endsWith('```');

      if (hasExpectedId && isLikelyComplete && isLongEnough) {
        clearInterval(intervalId);
        resolve(currentText);
        return;
      }

      if (currentText === lastText) {
        stableCount++;
        if (stableCount >= stableThreshold && isLongEnough) {
          clearInterval(intervalId);
          resolve(currentText);
        }
      } else {
        stableCount = 0;
        lastText = currentText;
      }
    }, checkInterval);

    setTimeout(() => {
      clearInterval(intervalId);
      reject(new Error("Таймаут ожидания ответа от ChatGPT (300 с)"));
    }, 300000);
  });
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
function waitForEnabledButton(...selectors) {
  return new Promise((resolve, reject) => {
    const check = () => {
      for (const selector of selectors) {
        const btn = document.querySelector(selector);
        if (btn && !btn.disabled && btn.offsetParent !== null) {
          return resolve(btn);
        }
      }
    };
    check();
    const observer = new MutationObserver(() => check());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'class', 'style']
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Кнопка отправки не появилась за 10 секунд"));
    }, 10000);
    const originalResolve = resolve;
    resolve = (value) => {
      clearTimeout(timeout);
      observer.disconnect();
      originalResolve(value);
    };
  });
}

function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Элемент ${selector} не найден`));
    }, timeout);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}