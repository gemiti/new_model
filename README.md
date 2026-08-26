# 🎣 Прогноз клёва

Гибридное PWA-приложение для прогнозирования активности клёва рыбы на основе солунарной теории и погодных данных.

## Описание модели

Приложение использует двухслойную детерминированную модель:

1. **Солунарный слой** — астрономический расчёт положения Солнца и Луны, определение больших и малых периодов, бонусов за наложение с восходом/закатом, коэффициента фазы Луны.
2. **Погодный слой** — корректировка по барометрическому давлению (тренд за 3 ч), ветру, осадкам, облачности и сезонному коэффициенту.

Итоговый индекс — относительная шкала 0–100.

## Данные

- **Погода**: [Open-Meteo API](https://open-meteo.com/) (бесплатно, без API-ключа)
- **Геокодинг**: [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api)

## Возможности

- 🔍 Поиск населённых пунктов с автодополнением
- 📍 Определение местоположения по GPS
- 📊 Индекс клёва «сейчас» с анимированным кольцом
- 🏆 Топ-3 лучших слота на день
- 📈 График активности по часам
- 📅 Прогноз на 5 дней вперёд
- 📱 PWA — можно установить на телефон как приложение
- 🌙 Тёмная тема

## Публикация на GitHub Pages

1. Создайте новый репозиторий на GitHub
2. Загрузите файлы из архива в корень репозитория
3. Перейдите в **Settings → Pages**
4. В разделе **Build and deployment** выберите **Source: GitHub Actions**
5. Создайте файл `.github/workflows/pages.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - id: deployment
        uses: actions/deploy-pages@v4
```

6. После деплоя приложение будет доступно по адресу `https://<username>.github.io/<repo>/`

## Установка на телефон (PWA)

- **iOS Safari** → Поделиться → На экран «Домой»
- **Android Chrome** → Меню → Установить приложение

## Структура проекта

```
.
├── index.html       # Полностью автономный файл (CSS + JS inline)
├── manifest.json    # PWA манифест
├── sw.js            # Service Worker
└── README.md
```

**Важно**: `index.html` содержит встроенные стили и скрипт, поэтому работает даже если внешние файлы не загрузятся. Это решает проблемы с путями на GitHub Pages в подпапках.

## Лицензия

MIT
