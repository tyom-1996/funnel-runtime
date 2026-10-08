# funnel-runtime

Мини-платформа для запуска, версионирования и анализа многошаговых веб-воронок.
Fullstack TypeScript: React + Vite на фронте, Node.js + Express + SQLite на бэке, один репозиторий.

- **Воронка рисуется из JSON-конфига**, который отдаёт сервер. Во фронтенде нет ни одного захардкоженного экрана.
- **Версии конфига** хранятся в БД, публикуются и откатываются без передеплоя. Сессия навсегда закреплена за своей версией.
- **A/B-эксперимент**: вариант назначает сервер, он стабилен в рамках сессии, есть override через query-параметр.
- **Собственный приём событий**: пачками, идемпотентно по `event_id`, с постатусным ответом по каждому событию.
- **Dashboard** считает всё по уникальным сессиям.
- **Генератор трафика** гоняет 100+ сессий через тот же HTTP API и печатает ожидаемые цифры для сверки.

| | |
|---|---|
| Публичный URL | **https://zerdani.com** (Docker на VPS, см. «Деплой») |
| Воронка | `/` (`/?variant=B` — override варианта, `/?utm_campaign=...` — UTM) |
| Админка версий | `/admin` — на публичной инсталляции закрыта токеном (поле «Admin token» вверху страницы; токен — в сопроводительном письме) |
| Аналитика | `/dashboard` — то же |

---

## Локальный запуск

Требуется Node.js ≥ 20.

```bash
npm install
npm run dev          # сервер http://localhost:3000 + Vite http://localhost:5173 (с прокси /api)
```

Production-режим (сервер отдаёт собранный фронтенд сам):

```bash
npm run build
npm start            # http://localhost:3000
```

Другие команды:

```bash
npm test                                  # vitest: shared + server
npm run typecheck                         # tsc по всем пакетам
npm run seed                              # 120 синтетических сессий против http://localhost:3000
npm run seed -- --sessions 300 --seed 7 --base https://host
npm run publish-version -- list           # CLI админки: list | upload <file> | publish <ver> | rollback [ver]
```

Переменные окружения — в [`.env.example`](.env.example). При первом старте сервер загружает все `configs/*.json`
как версии и активирует ту, у которой в JSON `"status": "published"` (это `funnel-v1.json`). Остальные ждут публикации.

Если задан `ADMIN_TOKEN`, админские API требуют заголовок `x-admin-token`; на страницах `/admin` и `/dashboard` есть поле для токена.

---

## Структура репозитория

```
configs/              funnel-v1.json (и последующие версии)
packages/shared/      схема конфига (zod), движок условий, резолв варианта, видимость/прогресс/результат, типы API
packages/server/      Express + better-sqlite3: версии, сессии, события, аналитика, seed, CLI
packages/web/         React: FunnelPage (универсальный рендерер), /admin, /dashboard
AGENTS.md             как велась работа с AI-агентами
```

Движок воронки (`packages/shared`) один и тот же на клиенте, на сервере и в генераторе трафика:
клиент решает, какой шаг показать, сервер валидирует ответы и чистит «мёртвые» ответы, генератор ходит по воронке теми же функциями.

---

## Конфиг воронки

Полная схема — [`packages/shared/src/schema.ts`](packages/shared/src/schema.ts). Ключевые части:

Формат — тот, что выдан в задании (`configs/funnel-v1.json`, `configs/funnel-v3.json`); схема проверяет его при загрузке.

```jsonc
{
  "funnelId": "team-workflow-audit",
  "version": 1,                    // число; в БД/URL/аналитике используется как строка "1"; номера НЕ обязаны идти подряд
  "status": "published",           // подсказка для первичной загрузки; реальный статус живёт в БД
  "title": "Find your team's operating style",
  "session":  { "ttlHours": 72, "persistAnswers": true, "pinVersion": true, "pinExperimentVariant": true },
  "progress": { "countVisibleOnly": true, "excludeTypes": ["info", "result"] },
  "experiment": {
    "id": "question-order-and-result-framing-v1",
    "overrideQueryParam": "variant",
    "variants": {
      "A": { "weight": 50, "stepSequence": ["intro", "team_size", "work_mode", ...] },
      "B": { "weight": 50, "stepSequence": [...],
             "stepOverrides":   { "intro": { "content": { "title": "...", "primaryActionLabel": "Show me" } } },
             "resultOverrides": { "balanced": { "title": "...", "cta": { "label": "..." } } } }
    }
  },
  "steps": {
    "office_days": { "id": "office_days", "type": "number",
                     "content":    { "title": "How many office days…?", "helperText": "…" },
                     "input":      { "name": "office_days", "min": 0, "max": 5, "step": 1, "unit": "days" },
                     "validation": { "required": true, "messages": { "required": "…", "min": "…", "max": "…" } },
                     "visibleWhen": { "answer": "work_mode", "operator": "in", "value": ["hybrid", "office"] } },
    "priorities":  { "type": "multi-select", "input": { "options": [ { "value": "speed", "label": "Decision speed" }, ... ] },
                     "validation": { "minSelections": 1, "maxSelections": 3 } },
    "result":      { "type": "result", "content": { "loadingTitle": "…", "errorTitle": "…", "retryLabel": "…" } }
  },
  "results": { "balanced": { "id": "balanced", "title": "…", "summary": "…", "recommendations": ["…"],
                             "cta": { "label": "View the action list", "action": "expand_recommendation" } }, ... },
  "resultRules": [ { "resultId": "async_native", "when": { "any": [ { "all": [ {...}, {...} ] }, {...} ] } }, ... ],
  "defaultResultId": "balanced",
  "events": {
    "baseProperties": ["event_id", "session_id", "client_timestamp", "funnel_id", "funnel_version", "experiment_id", "variant", "step_id", "utm_*"],
    "allowed": [ { "name": "step_viewed", "trigger": "…", "properties": ["step_type", "visible_step_index", "visible_step_count"] }, ... ],
    "privacy": { "storeRawAnswers": false, "allowAnswerKinds": true }
  }
}
```

- **Типы шагов**: `info`, `single-select`, `multi-select`, `number`, `result`. На каждый тип — один универсальный компонент; все тексты берутся из `content` (`eyebrow`, `title`, `body`, `helperText`, `primaryActionLabel`), параметры ввода — из `input`.
- **Валидация** целиком из конфига: `required`, границы `input.min`/`max`/`step` (`step: 1` → целые), `minSelections`/`maxSelections`, значение из `options[].value`; тексты ошибок — `validation.messages` по имени правила. Нативная валидация браузера отключена (`noValidate`), чтобы показывались именно эти тексты. Та же функция валидирует ответ на сервере.
- **Движок условий**: лист `{ "answer", "operator", "value" }` с операторами `eq`, `neq`, `in`, `contains`, `gte`, `gt`, `lte`, `lt`; группы `all` / `any` / `not` вкладываются на любую глубину. Один и тот же движок для `visibleWhen` и `resultRules`. В `resultRules` побеждает первое совпавшее правило, иначе `defaultResultId`. Отсутствующий ответ никогда не матчится.
- **Вариант** накладывается поверх базовых шагов: `stepSequence` задаёт порядок (и состав!) шагов, `stepOverrides[id].content` deep-merge'ится в шаг, `resultOverrides[id]` — в результат (`*` — для всех результатов).
- **Экран результата**: `title` + `summary`; CTA с `action: "expand_recommendation"` раскрывает `recommendations` на месте и даёт события `cta_clicked` и (если версия разрешает) `recommendation_expanded`. `content.loadingTitle` показывается, пока сохраняется переход на результат, `errorTitle`/`retryLabel` — если сохранение не удалось.
- **Прогресс** считает только видимые шаги минус `progress.excludeTypes`.
- **Ветвление и «передумал»**: видимость вычисляется последовательно, и шаг видит только ответы видимых шагов перед ним. Если пользователь ответил на `office_days`, вернулся и переключил `work_mode` на `remote`, сервер при сохранении выкидывает ответ `office_days` (`pruneAnswers`). Он не участвует ни в прогрессе, ни в расчёте результата, а при обратном переключении на `hybrid` вопрос задаётся заново.

---

## Модель данных (SQLite)

Схема — [`packages/server/src/db.ts`](packages/server/src/db.ts). Все «гибкие» вещи лежат в JSON, поэтому новые шаги, события и результаты не требуют миграций.

| Таблица | Назначение | Ключевые поля |
|---|---|---|
| `funnel_versions` | версии конфига | `version` PK, `status` (draft/published/archived), `is_active` (partial unique index — активна максимум одна), `config_json`, `published_at` |
| `publication_log` | журнал публикаций | `action` (publish/rollback), `from_version`, `to_version`. Откат берёт `from_version` последней публикации, а не «номер минус один» |
| `sessions` | пользовательские сессии | `session_id` PK, `funnel_version` (пин), `variant`, `variant_source` (assigned/override), `current_step_id`, `answers_json`, `utm_json`, `expires_at` (TTL 72 ч) |
| `events` | аналитические события | `event_id` PK (идемпотентность), `session_id`, `event_type`, `step_id`, `funnel_version`, `variant`, `client_timestamp`, `server_timestamp`, `utm_source/medium/campaign`, `properties_json` |
| `ingest_stats` | счётчики accepted/duplicate/rejected | для дашборда |

Сырые ответы живут **только** в `sessions.answers_json` (с TTL), в `events` их нет.

### API

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/api/sessions?variant=B` | новая сессия на **активной** версии; вариант назначает сервер (веса) или берёт из override-параметра, имя которого задаёт конфиг |
| `GET` | `/api/sessions/:id` | сессия + конфиг **её** версии и варианта (резолвленный) |
| `PATCH` | `/api/sessions/:id` | `{ answers, currentStepId }` — валидация по конфигу сессии, прунинг скрытых ответов |
| `POST` | `/api/events` | массив событий → `{ results: [{event_id, status, reason?}], summary }`; `207` если есть отклонённые |
| `GET` | `/api/admin/versions` | список версий, активная, журнал публикаций |
| `POST` | `/api/admin/versions` | загрузить JSON как draft (валидация zod + ссылочная целостность) |
| `POST` | `/api/admin/versions/:v/publish` | сделать активной |
| `POST` | `/api/admin/rollback` | `{ toVersion? }` — откат к предыдущей активной (по журналу) или к указанной |
| `GET` | `/api/analytics?version=&variant=&utm_campaign=` | все метрики дашборда |
| `GET` | `/api/health` | `{ ok, activeVersion }` |

---

## Схема событий

Клиент шлёт:

```json
{
  "event_id": "uuid, генерирует клиент",
  "session_id": "uuid",
  "event_type": "step_viewed",
  "step_id": "work_mode",
  "client_timestamp": "2026-10-08T19:49:04.055Z",
  "properties": { "step_type": "single-select", "visible_step_index": 1, "visible_step_count": 8 }
}
```

Сервер дописывает `server_timestamp`, а `funnel_version`, `variant` и UTM **берёт из сессии**, а не из тела запроса. Набор допустимых `event_type` — это `events.allowed` той версии, к которой привязана сессия.

| Событие | Когда | properties |
|---|---|---|
| `session_started` | создана сессия | — (версия, вариант, эксперимент и UTM сервер берёт из сессии) |
| `step_viewed` | показан шаг (в т.ч. повторно и после refresh) | `step_type`, `visible_step_index`, `visible_step_count` |
| `answer_submitted` | ответ прошёл валидацию | `answer_kind` — тип ответа, **без значения** |
| `step_completed` | нажат Continue | `next_step_id` |
| `back_clicked` | нажат Back | `destination_step_id` |
| `result_viewed` | показан результат | `result_id` |
| `cta_clicked` | нажат основной CTA | `result_id`, `action` |
| `recommendation_expanded` | список рекомендаций раскрыт по CTA на экране результата — **только в v3** (`events.allowed`); для сессий на v1 сервер отвечает `rejected` | `result_id`, `action`, `source: "cta"` |

Инварианты приёма:

- `event_id` — PRIMARY KEY, вставка через `INSERT OR IGNORE` → повтор даёт `duplicate`, строк не добавляет. Повтор всей пачки после таймаута безопасен.
- Каждое событие валидируется отдельно; плохое → `rejected` с причиной, остальные сохраняются. Вся пачка — одна транзакция.
- Клиентская очередь: события копятся, уходят пачками (таймер/размер), неотправленные лежат в `localStorage` и переживают refresh; при ошибке сети пачка с теми же `event_id` отправляется снова.
- `events.privacy.storeRawAnswers: false` — сервер дополнительно вырезает из `properties` ключи вроде `value`/`answer`, даже если клиент их пришлёт.

---

## Правила агрегации (dashboard)

Всё — `COUNT(DISTINCT session_id)`. Запрос схлопывает события до уникальных троек `(session, event_type, step_id)`, поэтому повторные просмотры, возвраты назад и дубли ничего не раздувают. Порядок прихода событий не важен: мы спрашиваем «было ли в сессии событие X на шаге Y», а не «что пришло раньше».

| Метрика | Определение |
|---|---|
| Started | сессии, у которых есть хотя бы одно событие |
| Viewed (шаг) | сессии с `step_viewed` на шаге |
| Completed (шаг) | сессии с `step_completed` на шаге |
| Conversion from prev | viewed(шаг) / сессии, дошедшие хотя бы до предыдущей позиции в `stepSequence`. Знаменатель — «позиция достигнута», а не «предыдущий шаг просмотрен», иначе вокруг условных шагов, которые видит только часть трафика, получались бы значения > 100 %. Для самого условного шага эта метрика смешивает ветвление и отвал — это ограничение событийной модели (из событий не видно, кто был eligible) |
| Dropped here | сессии, чей **самый дальний** просмотренный шаг (по позиции в `stepSequence` варианта, не по времени) — этот, и нет `result_viewed` |
| Reached result | сессии с `result_viewed` |
| CTA CTR | сессии с `cta_clicked` / сессии с `result_viewed` |
| CTA / started | сессии с `cta_clicked` / started — **основная метрика A/B** |

Поскольку порядок (и состав) шагов отличается между вариантами и версиями, пошаговая воронка показывается в разрезе `версия × вариант`; сводные таблицы «A vs B» и «по версиям» — поверх этих сегментов. Фильтр по `utm_campaign` применяется ко всем метрикам.

Генератор печатает ожидаемые числа по сегментам и сверяет их с `/api/analytics`; на пустой БД совпадение точное.

---

## A/B-эксперимент

**Гипотеза.** Вариант B — сначала вопросы про режим работы (самая «личная» и простая тема), более продающие тексты («Get your team's 30-day workflow plan») и CTA с конкретным обещанием («Get my 30-day plan») — повышает долю сессий, которые доходят до результата и нажимают CTA.

**Основная метрика:** `cta_clicked / started` (доля начавших сессий с кликом по CTA). Она учитывает и доходимость, и привлекательность результата, и не зависит от того, сколько шагов в варианте.

**Вспомогательные:** `result_viewed / started` (доходимость), CTR на экране результата, отвал по шагам в разрезе варианта.

**Механика.** Вариант назначается сервером по весам из конфига при создании сессии и сохраняется в `sessions.variant`; при refresh он не меняется. `?variant=A|B` (имя параметра — `experiment.overrideQueryParam`) форсирует вариант для новой сессии, `variant_source = override` попадает в `session_started`. Некорректное значение override игнорируется.

---

## Версионирование и откат

- «Опубликовать» = `is_active = 1` у версии в БД. Эффект мгновенный, передеплой не нужен, конфиги версий кешируются в памяти процесса.
- Новые сессии создаются только на активной версии. `GET /api/sessions/:id` всегда отдаёт конфиг **версии сессии**, поэтому старые сессии доживают на своём конфиге после публикации новой версии и после отката.
- Откат — это публикация версии из `publication_log.from_version`, с записью `action = rollback`. Никаких предположений о нумерации версий (v2 может не существовать).
- Загруженная версия хранится как `draft`, пока её не опубликуют. После отката ранее опубликованная версия остаётся `published`, просто не активна.
- Валидация при загрузке: zod-схема + ссылочная целостность (ключ ↔ `id` у шагов и результатов, `stepSequence`/`stepOverrides` ↔ `steps`, `resultRules`/`defaultResultId`/`resultOverrides` ↔ `results`, в каждом варианте есть шаг `result`, положительная сумма весов). Незнакомые поля не отбрасываются (`passthrough`) — конфиг можно расширять без правок кода.

---

## Тесты

`npm test` — 29 тестов (vitest), сервер тестируется через supertest на in-memory SQLite:

- **shared**: движок условий (вкл. вложенные `all`/`any`, отсутствующие ответы), резолв варианта (порядок, тексты, deep-merge результата), видимость и прунинг «мёртвых» ответов, прогресс, валидация с текстами из конфига, правила результата, целостность схемы.
- **server**: закрепление версии за сессией (новая версия опубликована → старая сессия на старой, новая на новой, валидация по своей версии); стабильность A/B и override; дедупликация (повтор пачки, дубль внутри пачки, смешанная пачка с `rejected`, non-array body); версия/вариант/UTM берутся из сессии, сырые значения вырезаются; публикация draft с «непоследовательным» номером и откат по журналу, сессии продолжают жить на своих версиях, аналитика видит обе; расчёт метрик (уникальные сессии, отвал, конверсия, CTR, фильтры).
- **iteration2**: конфиг v3 (ветка `security_constraints`, `tool_count` только в A, новые результаты, `recommendation_expanded`) и полный сценарий «сессии на v1 → publish v3 → старые доходят на v1, новые на v3 → rollback → v3-сессии живут дальше → аналитика по обеим версиям», плюс bootstrap из `configs/` без активации draft.

---

## Деплой

Публичная инсталляция — **https://zerdani.com**: Docker-контейнер на VPS, перед ним nginx (TLS Let's Encrypt) как reverse proxy на `127.0.0.1:3000`.

```bash
docker compose up -d --build        # образ из Dockerfile, SQLite в named volume funnel-data, restart: unless-stopped
docker compose logs -f
docker compose exec app node packages/server/dist/cli.js list   # CLI админки внутри контейнера
```

- `Dockerfile` — multi-stage, финальный образ содержит только prod-зависимости сервера, `configs/` и собранный фронт.
- `docker-compose.yml` — порт публикуется только на `127.0.0.1:3000`, данные в volume `/data`.
- `render.yaml` — blueprint для Render с диском `/data` и `DB_FILE=/data/funnel.sqlite` (альтернатива VPS).
- Без Docker: `npm ci && npm run build && DB_FILE=/var/lib/funnel/funnel.sqlite PORT=3000 npm start` под systemd/pm2.

Сторонних сервисов нет: аналитика, БД и A/B — свои.

---

## Таймлайн

**Итерация 1 — `funnel-v1.json`**

1. Разбор задания, фиксация схемы конфига и движка условий (`packages/shared`), тесты на него.
2. Сервер: схема SQLite, версии/публикация/откат, сессии с пином версии и серверным назначением варианта, идемпотентный приём событий, аналитика по уникальным сессиям. Пять обязательных тестов.
3. Фронтенд: универсальный рендерер шагов, очередь событий, `/admin`, `/dashboard`.
4. Генератор трафика через HTTP с печатью ожидаемых цифр; ручная проверка в браузере сценария «ответил на `office_days` → назад → remote».
5. README, Dockerfile, деплой.

**Переход на выданные конфиги.** Первая версия делалась по текстовому описанию из задания с реконструированным JSON. Когда пришли оригинальные `funnel-v1.json`/`funnel-v3.json`, формат оказался другим (числовой `version`, `steps`/`results`/`variants` как объекты по id, `content`/`input`/`validation` у шага, лист условия `{answer, operator, value}`, `events.allowed` с описанием свойств). Схема, резолв варианта, валидация, рендерер, генератор и тесты переведены на этот формат; модель данных и API не изменились — версия в БД хранится строкой (`"1"`, `"3"`).

**Итерация 2 — `funnel-v3.json`**

1. Получен `funnel-v3.json` (`status: draft`, `version: 3` — версии 2 нет, система на нумерацию не опирается). Что изменилось:

   | Требование | В v3 |
   |---|---|
   | новая условная ветка | `security_constraints` показывается, если в `priorities` есть `compliance` |
   | экран удалён для B | `tool_count` отсутствует в `stepSequence` варианта B (в A остаётся) |
   | новое событие | `recommendation_expanded` — раскрытие рекомендаций по CTA на экране результата (`result_id`, `action`, `source`) |
   | ещё | новый шаг `meeting_hours`, опция `compliance` в `priorities`, результаты `regulated_scale` и `meeting_heavy`, новый `experiment.id` |

2. Положен в `configs/`, добавлен тест-сценарий `iteration2.test.ts`. **Код рантайма менять не пришлось**: движок условий, резолв варианта, валидация и приём событий полностью управляются конфигом; схема БД не менялась (конфиг и свойства событий — JSON).
3. Проверка на живом сервере через CLI и браузер: `upload` → `publish 3` → генератор создаёт трафик на v3 (B без `tool_count`, часть сессий с `security_constraints`, `recommendation_expanded` принимается) → `rollback` → новые сессии снова на v1, сессии v3 продолжают работать, dashboard показывает обе версии, `publication_log` содержит `publish → rollback`.
4. Побочная находка при проверке v3: «conversion from prev» вокруг условного шага давала > 100 % (предыдущий шаг видела только часть трафика). Знаменатель заменён на «сессии, дошедшие до предыдущей позиции» — см. правила агрегации.
5. Обновлены README и AGENTS.md.

Что дальше (вне срока): фоновая очистка истёкших сессий, предагрегаты для больших объёмов, нормальный auth на `/admin`.

---

## Сценарий проверки второй итерации вручную

```bash
npm run build && npm start                      # v1 активна (bootstrap), v3 лежит как draft
npm run seed -- --sessions 50                   # трафик на v1
npm run publish-version -- publish 3            # или кнопка Publish в /admin
npm run seed -- --sessions 50                   # трафик на v3; старые сессии v1 продолжают работать
npm run publish-version -- rollback             # обратно на v1; сессии, начатые на v3, остаются на v3
npm run publish-version -- list
```

После этого `/dashboard` показывает обе версии; `/dashboard` → фильтр Version позволяет сравнить их по шагам.

---

## Ограничения и допущения

- **Override при существующей сессии.** Если в `localStorage` есть сессия, а в URL `?variant=` с другим вариантом — создаётся новая сессия на активной версии (тестировщик явно хочет посмотреть другой вариант). Если вариант совпадает — сессия продолжается.
- **Что считается отвалом.** Сессия без `result_viewed`; отвал приписывается самому дальнему по `stepSequence` шагу, который сессия видела. Сессии, которые ещё «живы» (TTL не истёк), тоже считаются отвалом — отдельного состояния «в процессе» нет.
- **Started** = есть хотя бы одно событие (а не строго `session_started`), чтобы потерянное первое событие не «удаляло» сессию из статистики.
- **Смена ветки стирает ответы скрытой ветки.** Это сознательный выбор: поведение детерминировано и одинаково на клиенте и сервере; при возврате к `hybrid` `office_days` спрашивается заново.
- **Агрегация в памяти процесса.** SQL возвращает уникальные тройки, финальная сборка по шагам — в JS. Для сотен тысяч сессий потребовались бы предагрегаты/materialized view; для задания это осознанный компромисс в пользу прозрачности логики.
- **Одно приложение для воронки, админки и дашборда.** Так просило задание («мини-платформа», один репозиторий, деплой одной командой), и для этого масштаба это правильный размер. Границы внутри уже проведены: публичные API (`/api/sessions`, `/api/events`) и приватные (`/api/admin/*`, `/api/analytics`) — разные группы роутов с разным middleware; весь доменный код в `packages/shared` не зависит ни от Express, ни от React. При росте первым делом я бы разнёс **фронтенды** (публичная воронка должна быть максимально лёгкой и не везти в бандле код админки), затем закрыл бы админку и дашборд нормальной авторизацией с ролями и аудитом (`publication_log` сейчас не хранит `actor`), и только потом — приём событий в отдельный сервис с очередью. Бэкенд при этом может ещё долго оставаться одним процессом.
- **Авторизация — общий `ADMIN_TOKEN`** (на публичной инсталляции включён). Для тестового задания этого достаточно; в проде — SSO/OAuth, роли и аудит, см. выше.
- **Истёкшие сессии не чистятся** фоновым процессом, только отвергаются (`410`); очистка — одна `DELETE ... WHERE expires_at < now` строка, намеренно не добавлена, чтобы не терять ответы для отладки.
- **Один funnelId.** Активная версия одна на весь инстанс; несколько независимых воронок потребуют поля `funnel_id` в `is_active`-индексе.
