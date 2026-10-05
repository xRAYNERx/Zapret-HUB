# Сторонние компоненты

Zapret.NET — обёртка (GUI) вокруг открытых инструментов обхода DPI. Ниже — что используется и на каких условиях.

## WinDivert & winws
- **Проект:** [bol-van/zapret](https://github.com/bol-van/zapret) / WinDivert
- **Назначение:** перехват и модификация сетевых пакетов (`winws.exe`, `WinDivert64.sys`, `WinDivert.dll`)
- **Лицензия:** см. upstream

## Telegram Proxy (ZapretTgProxy)
- **Проект:** Встроенный компонент Zapret.NET
- **Назначение:** локальный шлюз MTProto / WebSocket Fake-TLS для Telegram

## Xray-core (VPN VLESS Reality)
- **Проект:** [XTLS/Xray-core](https://github.com/XTLS/Xray-core)
- **Назначение:** ядро VPN-модуля VLESS Reality
- **Лицензия:** Mozilla Public License 2.0

## Electron

- **Проект:** [electron/electron](https://github.com/electron/electron)
- **Лицензия:** MIT

## Прочие npm-зависимости

См. `package.json` и `package-lock.json`. Основные: `electron-builder`, `png-to-ico`.