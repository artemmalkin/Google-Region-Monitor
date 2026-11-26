# GitHub update instructions — v1.9.2

## 1.9.2 — resolve Google /goto result links

- Detects new `https://www.google.com/goto?url=...` organic result links.
- Resolves each unique token using a GET request with manual redirect handling and reads the destination from the HTTP `Location` header. The destination site itself is not loaded.
- Direct URLs are applied before ChatGPT region filtering and HTML report generation, including hidden-result entries.
- Unresolved tokens remain unchanged and are counted in the report/log instead of being guessed from display breadcrumbs.
- Adds the `webRequest` permission and observes only `https://www.google.com/goto*` redirects.

## 1.9.1 — release cleanup, one-task Google Search pagination, and billing statistics

- Removed the embedded manual 2Captcha developer console, its controls, styles, scripts, test file, and the now-unused clipboard permission. Normal monitoring, API-key storage, and API-log export remain available.
- Each `google_search` query now creates one Scraper API task with `page_num` equal to the selected page count (1–10). Multi-page HTML is returned in the same response using `with_html: true`; no separate offset task is created for each page.
- The standalone `scrape` backend is unchanged: it still creates one `task_type: "scrape"` task for each selected Google page.
- The explicit statistics refresh now loads `getBalance` and `task_history` for both `google_search` and `scrape`. Average cost uses completed `done` records and their `price` for the selected backend; last-report cost is reconciled using the report's saved response IDs.
- Task history is not requested automatically. The internal `x-debug.price` value is not used for billing calculations.

## 1.10.1 — fix false CAPTCHA detection in Scrape HTML

- Fixed a false positive: generic Google page scripts (`hasCaptchaSupport=true`, shared `/sorry/index` handlers) are no longer treated as an actual CAPTCHA page.
- CAPTCHA detection now examines visible body text after removing scripts/styles and checks concrete challenge elements/forms.
- Validated against a real 2Captcha response: HTTP 200 with an ordinary Google SERP containing seven organic result headings. The previous detector stopped before page 2 and page 3.


## 1.10.0 — page-by-page 2Captcha Scrape mode

- Added a separate **2Captcha Scrape (HTML)** monitoring backend. The existing `google_search` backend remains available for side-by-side comparison.
- Each selected Google results page is fetched with one `task_type: "scrape"` task using `data_format: "raw"` and `format: "json"`; the extension parses the returned `body` HTML locally.
- Pagination uses ordinary Google offsets: no `start` for page 1, then `start=10`, `start=20`, and so on. Profile language/region, time filter, and `filter=0` stay in the Google URL.
- Added extraction of organic result titles, links, and snippets from each HTML page. Successfully fetched empty pages are retained in the report; failed pages are reported as missing.
- Further tasks stop when Google returns a CAPTCHA/automated-traffic page or target HTTP 403/429.
- API exchange logging records each Scrape request and raw response while redacting the API key and Authorization header.

## 1.9.8 — corrected 2Captcha offset range

- Page 1 uses the base URL with `page_num=1`; page 2 uses the documented `start=10` mode without `page_num`.
- Pages 3 onward use `start=20` and `page_num=max(2, N-2)`, following the documented `start=20, page_num=2` example.
- For a 3-page selection, the API can return pages 3 and 4; page 4 is intentionally excluded from the final report.
- Removed the previous `start=20` + `page_num=1` request pattern that returned `no_results` in the v1.9.7 diagnostic log.
- A multi-page query uses no more than three sequential API tasks. Automatic balance/history requests remain disabled.

## 1.9.7 — initial offset pagination

- Page 1 used the base URL with `page_num=1`; page 2 used `start=10` without `page_num`; pages 3–N used `start=20` with `page_num=N-2`.
- Requests ran sequentially with a 750 ms pause; a 3–10-page query used up to three API tasks.
- Absolute `page_position.page` numbering was preserved and missing pages were reported rather than fabricated.

## 1.9.6

- A single `google_search` task requested the selected range with `page_num` and `with_html: true`.
- HTML-derived organic results were merged with structured results, and pages missing from the API response were reported rather than invented.
- The API exchange log retained response bodies and HTML while redacting credentials.

## 1.9.5

- Added a post-run **Download 2Captcha API log** button. It exports a JSON trace of every API request and response, including polling requests, HTTP status, useful response headers, raw response bodies, and network errors.
- The trace is retained locally in memory for the most recent run; downloading it performs no new API requests.
- API keys and Authorization values are redacted before logging and export. The log includes search queries and result payloads, so review it before publishing publicly.
- The button is shown after a 2Captcha report or a failed 2Captcha run whenever diagnostic events are available.

## 1.9.4

- Multi-page 2Captcha search uses the documented `pages` parameter for the initial combined request.
- If the combined response omits pages, only the missing offsets are fetched with separate `start=10`, `start=20`, etc. requests; the per-page fallback omits the `pages` parameter as recommended by 2Captcha.
- Missing-page requests run sequentially with a 500 ms pause; pages already received are never requested again.
- If `/tasks/sync` returns `408`/`pending`, the extension retrieves the same task using `response_id` at a 3-second interval instead of creating a duplicate task.
- The monitoring log reports the number of API tasks and collected pages per query.
- Removed the redundant log text about balance/history requests. Automatic balance and task-history requests remain disabled.

## 1.9.3

- Для многостраничного поиска 2Captcha используется документированный параметр `page_num` (1–10); из поискового URL перед отправкой удаляются неподдерживаемые `num` и `filter`, а также `start`.
- Результаты группируются по `page_position.page`; если поле отсутствует, номер страницы вычисляется по абсолютному `position`.
- Мониторинг больше не запрашивает баланс и историю расходов до/после отчёта. При открытии расширения и сохранении ключа автоматические запросы статистики также не выполняются.
- HTML-отчёт больше не содержит баланс, оценку оставшихся заданий или статистику стоимости.
- Кнопка «Обновить баланс» выполняет один отдельный запрос `getBalance`; история задач не запрашивается. Средняя цена и последний подтверждённый расход остаются только в локальном кеше.

## 1.9.0

- Из расширения убрана работа через Google Preferences: язык интерфейса (`hl`), страна (`gl`) и фильтр языка результатов (`lr`) теперь передаются прямо в ссылке поиска — так же, как в кликабельных запросах вкладки «Мониторинг».
- Удалены кнопки «Считать текущие», «Открыть Google Preferences», «Применить профиль в Google» и «Вернуть русский профиль», а также автоматическое переключение настроек Google при выборе профиля и перед/после мониторинга.
- Настройка профиля без кодов: страна и язык интерфейса выбираются из списков по названиям, языки фильтрации результатов добавляются и убираются кнопками-«чипами». Коды подставляются автоматически; формат хранения профилей и стандартные профили GitHub не изменились.
- Выбор домена Google (например, `google.co.id`) намеренно не добавлен: Google с 2017 года определяет страну по местоположению и параметру `gl`, а страновые домены с 2025 года перенаправляет на `google.com`, поэтому выдача от домена не становится более местной.


## 1.8.5

- В разделе «Мониторинг» каждый текст запроса открывается в новой вкладке Google по прямой ссылке; формирование отчёта не запускается.
- Прямая ссылка учитывает регион (`gl`), язык интерфейса (`hl`), языки результатов (`lr`) и выбранный период (`tbs`) текущего профиля.
- Открывается только первая страница результатов. Автоматический обход страниц и управление вкладкой мониторинга не задействуются.

## 1.8.4

- Исправлен номер версии расширения в `manifest.json`: теперь он совпадает с версией архива — `1.8.4`.
- Обновлены заголовки документации, чтобы установленная версия и сопровождающие файлы не расходились.
- Сохранены изменения синхронизации стандартных профилей из предыдущей сборки: принудительная загрузка с токеном использует GitHub Contents API вместо CDN-кэша.

## 1.8.3

- Исправлена загрузка стандартных профилей: `queryGroupsRevision` теперь сохраняется при нормализации GitHub JSON и записи в локальный кеш.
- После публикации изменённых групп поисковых запросов расширение распознаёт GitHub-версию как актуальную и больше не заменяет её группами из встроенного каталога.
- Добавлена проверка корректности `queryGroupsRevision` при синхронизации, чтобы повреждённая метаинформация не приводила к незаметной миграции профиля.


## 1.8.2

- В стандартных профилях запросы разделены на две обычные редактируемые группы данных: «Основные запросы» и «Росатом и его проекты». В коде мониторинга нет специальной логики для этих названий.
- В профилях Вьетнама, Индонезии и Китая сохранены дословно три старые поисковые строки Rosatom из исходного каталога v1.5.4.
- Добавлено `queryGroupsRevision: 2`: устаревшие сгруппированные GitHub-профили однократно обновляются до новой структуры, при этом сохраняются пользовательские дополнительные группы и строки.
- История установленной версии берётся только из точного раздела текущей версии в локальном `GITHUB_UPDATES.md`. Если запись версии отсутствует, расширение сообщает об этом, не показывая чужие изменения.
- Если описание GitHub Release пустое, история доступной версии сначала ищется в удалённом `GITHUB_UPDATES.md`, затем в локальном архиве с явной пометкой источника.

## 1.8.1

- The installed version shown in the panel is taken from `manifest.json`.
- The bundled installed-version changelog declares its own version and is rendered only when it matches the manifest version.
- A mismatch now shows a clear warning instead of displaying notes for one build under another build's version; the warning instructs users to replace the full unpacked folder from one ZIP archive.
- The remote release card uses the GitHub Release body when present. If the body is empty, it falls back to the exact version section in the packaged or remote `GITHUB_UPDATES.md`, clearly labelling the source. A download button is shown only when that release is newer than the installed extension.

## 1.8.0

- Added arbitrary `profileGroup` values to combine country profiles into user-named sets such as South Asia or Latin America. Both profile selectors group and alphabetize entries in the extension UI.
- Added editable `queryGroups` per profile. Group names and membership are profile data, not hard-coded categories.
- Removed company-specific query classification from the Monitoring UI.
- Standard profile display names and `profileGroup` can be overridden locally without creating a copy; optional GitHub publishing makes the metadata shared.
- Legacy flat `queries` arrays migrate into a neutral “Основные запросы” group. Explicit grouped GitHub profiles are authoritative during sync, so intentional group/query removals persist.
- Updated README, standard profile documentation and JSON schema.

## 1.7.0 (historical)

- Added a release notes panel and UI-level profile sorting.
- The previous version had a special company-specific query classification; it is replaced in 1.8.0 by user-managed named query groups.

# GitHub: профили и релизы расширения

## Версия 1.6.0 — страновые профили и оптимизация Google Search

- Каталог увеличен до 19 стран по двум методичкам; прежние профили Вьетнам, Индонезия и Китай сохранены, добавлено 16 новых.
- Близкие поисковые формулировки объединены через `OR`; отдельными остались самостоятельные тематические блоки и соцсети.
- Встроенный каталог из ZIP дополняет GitHub-каталог; при совпадающем ID поля GitHub имеют приоритет, а поисковые строки объединяются для миграции старых профилей без потери уникальных дополнительных запросов.
- Выпадающие списки стандартных и пользовательских профилей сортируются по алфавиту.

## 1. Подготовка репозитория

1. Создайте публичный репозиторий GitHub.
2. Загрузите в корень репозитория все файлы полного исходного архива.
3. Убедитесь, что существует `config/standard-profiles.json`.
4. Параметры проекта уже заданы в `github-config.js`: `artemmalkin/Google-Region-Monitor`, ветка `master`, путь `config/standard-profiles.json`. При необходимости измените их там до сборки.

## 2. Обновление стандартных профилей

Стандартные профили хранятся в `config/standard-profiles.json`. Отредактируйте массив `profiles` и сделайте commit/push. Пример одного элемента:

```json
{
  "id": "indonesia",
  "name": "Индонезия",
  "interfaceLang": "id",
  "resultLangs": "id, en",
  "region": "ID",
  "queries": [
    "rosatom",
    "\"rosatom\" AND \"rooppur\""
  ]
}
```

`id` должен быть уникальным в массиве. После commit расширения пользователей получат изменения:

- вручную — по кнопке **Проверить обновление** (она же проверяет GitHub Release);
- автоматически — примерно раз в 24 часа через Chrome Alarms и при запуске Chrome, если с предыдущей синхронизации прошло 24 часа.

Для загрузки используется публичный Raw URL `raw.githubusercontent.com`. При ошибке загрузки предыдущий стандартный список остаётся на месте. Локальные пользовательские профили не изменяются.

Подробная схема описана в [STANDARD_PROFILES.md](STANDARD_PROFILES.md), JSON Schema находится в `config/standard-profiles.schema.json`.

## 3. Добавление, редактирование и удаление стандартных профилей из расширения

Вставьте Fine-grained Personal Access Token с разрешением `Contents: Read and write` только для нужного репозитория.

- **Добавить мой профиль в GitHub** публикует выбранный пользовательский локальный профиль.
- **Сохранить изменения стандартного профиля в GitHub** обновляет стандартную запись с сохранением её постоянного `id`.
- Кнопка **×** рядом с выбором стандартного профиля удаляет его из `config/standard-profiles.json` после подтверждения.

Все три операции выполняются через GitHub Contents API и создают commit в настроенной ветке. Перед обновлением/удалением расширение читает актуальный файл и использует его SHA. При конфликте из-за параллельного commit действие завершается ошибкой без перезаписи более новой версии; нажмите «Проверить обновление» и повторите. После успешного commit расширение принудительно синхронизирует список.

Обычная кнопка «Сохранить профиль» по-прежнему создаёт локальную копию стандартного профиля и не изменяет общий список. Токен остаётся в локальном хранилище расширения и не попадает в экспорт профиля/конфигурации. Не коммитьте токен в GitHub и не передавайте его другим пользователям.

## 4. Публикация новой версии расширения

В `manifest.json` увеличьте номер `version`, отправьте коммит в GitHub и создайте соответствующий тег. Например:

```bash
git tag v1.4.0
git push origin v1.4.0
```

Workflow `.github/workflows/release.yml` проверит совпадение тега и `manifest.json`, соберёт `google-region-monitor.zip` и приложит архив к GitHub Release.

Расширение проверяет последний Release и предлагает скачать новый ZIP. У распакованной установки Chrome обновление файлов автоматически не устанавливается: после скачивания пользователь должен распаковать новую версию и перезагрузить расширение через `chrome://extensions`. Для штатного автообновления файлов расширения используйте Chrome Web Store.


## Настройки версии 1.3.0

Настройки репозитория задаются только в `github-config.js`: `owner`, `repository`, `branch`, `standardProfilesPath`. Не добавляйте Fine-grained token в этот файл. Токен задаётся пользователем в интерфейсе; кнопки добавления/обновления стандартного профиля появляются при заполненном токене. Ручная синхронизация стандартных профилей объединена с кнопкой «Проверить обновление».


## Изменения версии 1.4.0

Управление стандартными профилями теперь доступно прямо из панели: редактирование с отправкой commit в GitHub и удаление с подтверждением. Fine-grained token нужен для каждой операции записи.


## Изменения версии 1.4.1

Исправлено применение настроек Google Preferences: расширение нажимает на внутреннюю область элемента управления, ищет подтверждение по служебному действию Google, не зависит от текста кнопки на конкретном языке и применяет `hl` последним.


## v1.4.3

- Исправлено применение выбора запросов для отчёта: старт мониторинга больше не перерисовывает список чекбоксов и не сбрасывает выбор на «все».
- Добавлена кнопка «Остановить». Ожидание текущей незавершённой страницы отменяется, а HTML-отчёт скачивается по ранее собранным результатам.
- В отчёт добавлена отметка о ручной остановке и число выбранных/начатых запросов.
- В `github-config.js` заданы параметры репозитория `artemmalkin/Google-Region-Monitor`, ветка `master`.

## v1.4.2

- Google Preferences теперь всегда открывается и активируется на переднем плане перед применением настроек; скрытая временная вкладка больше не используется и не закрывается сразу после выполнения.
- Добавлена команда возврата к русскому профилю: `hl=ru`, `lr=lang_ru`, `gl=RU`.
- После завершения мониторинга русский профиль восстанавливается автоматически по умолчанию; автоматический возврат можно отключить флажком.


## Версия 1.4.4

Поисковые URL включают `filter=0`, чтобы Google показывал результаты, которые обычно исключаются как очень похожие на уже выведенные. Параметр принудительно сохраняется на всех страницах пагинации. Для обхода более чем одной страницы используется обычная пагинация; `num=100` не включён, так как его поддержка Google нестабильна.


## v1.4.6

- Перед экспортом отчёта проверяются уникальные ссылки через веб-версию ChatGPT. Каждый пакет обрабатывается в новом чате.
- В первой реализации v1.4.6 выполнялась попытка переключать режим размышления; в v1.4.7 этот самописный клик удалён в пользу неизменённого механизма из рабочего примера.
- Из отчёта удаляются только URL, для которых ChatGPT вернул ID из переданного пакета.
- При ошибке ChatGPT исходные результаты сохраняются, а отчёт явно показывает, что AI-фильтр не был применён.


## v1.4.7

- Региональный фильтр через ChatGPT стал опциональным и настраивается в боковой панели.
- Протокол ChatGPT и `chatgpt_content.js` восстановлены по рабочему примеру без изменений.
- Каждый пакет отправляется в отдельном новом чате через исходную `startNewChatGPTChat()`.
- Убран самописный выбор режима размышления с нестабильными селекторами; в приложенном примере такого переключателя ChatGPT нет.

## v1.5.0

- Переключатель «Размышление» распознаётся по актуальной структуре composer из предоставленной HTML-разметки ChatGPT: `form[data-chatgpt-composer]` и `[data-composer-trailing-controls]` с `button[aria-pressed]`; добавлен запасной поиск по точному тексту кнопки.
- После клика переключатель больше не нажимается повторно: расширение ждёт, пока `aria-pressed` действительно станет `true`.
- Таймауты загрузки ChatGPT и появления элементов интерфейса увеличены до 120 секунд.
- Ожидание переключения режима «Размышление» увеличено до 120 секунд, ожидание генерации ответа — до 15 минут.
- Ожидание поля ввода и активной кнопки отправки в контент-скрипте увеличено до 120 секунд.


## v1.5.1

- Для регионального фильтра ChatGPT целевой регион берётся только из названия выбранного профиля (`profile.name`).
- Код Google `gl` и языковые настройки профиля удалены из входных данных ChatGPT.
- В JSON-запрос передаётся строковое поле `region` с названием профиля; результаты поиска передаются отдельно для идентификации самого СМИ.


## Примечание об истории v1.5.4

В исходном архиве v1.5.4 `GITHUB_UPDATES.md` содержит записи до v1.5.1 включительно и не содержит отдельного раздела v1.5.4. Поэтому интерфейс не должен приписывать v1.5.4 функции, добавленные в v1.8.0 и позднее. Новая логика показывает только точное совпадение версии; при отсутствии раздела выводится явное сообщение.

## 1.5.4

В исходном архиве v1.5.4 нет отдельной записи об изменениях: история в том архиве заканчивается на v1.5.1. Функции групп страновых профилей и групп поисковых запросов относятся к v1.8.0 и не должны отображаться как изменения v1.5.4.

