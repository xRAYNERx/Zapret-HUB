# Сторонние компоненты

Zapret HUB — обёртка (GUI) вокруг открытых инструментов обхода DPI. Ниже — что используется и на каких условиях.

## Движок обхода (zapret-discord-youtube)

- **Проект:** [Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube)
- **Назначение:** `winws.exe`, стратегии `.bat`, списки доменов/IP
- **Лицензия:** см. репозиторий upstream
- **Примечание:** Zapret HUB не является официальным продуктом Flowseal

## WinDivert

- **Проект:** [bol-van/zapret](https://github.com/bol-van/zapret) / WinDivert
- **Назначение:** перехват и модификация сетевых пакетов (`WinDivert64.sys`, `WinDivert.dll`)
- **Лицензия:** см. upstream

## Telegram WebSocket Proxy

- **Проект:** [Flowseal/tg-ws-proxy](https://github.com/Flowseal/tg-ws-proxy)
- **Назначение:** локальный SOCKS5-прокси для Telegram
- **Лицензия:** см. репозиторий upstream

## Electron

- **Проект:** [electron/electron](https://github.com/electron/electron)
- **Лицензия:** MIT

## Прочие npm-зависимости

См. `package.json` и `package-lock.json`. Основные: `electron-builder`, `png-to-ico`.