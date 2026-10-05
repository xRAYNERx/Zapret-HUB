# Руководство по правильной интеграции проверки пинга серверов (VLESS / VPN) в Android-версию Zapret.NET

> Данный документ составлен на основе стабильной архитектуры десктопной версии **Zapret.NET v2.0.3** (Electron + Xray/Sing-box).  
> Передайте этот файл AI-разработчику или в чат разработки Android-приложения для точного исправления логики замера задержки и доступности серверов.

---

## 1. В чём корень проблемы: почему сейчас пинг работает криво?

Если на Android пинг показывает нереалистичные цифры (900–2500 мс), зависает или показывает «всё работает» на заблокированных серверах, в коде допущены типичные ошибки:

1. **Использование системного ICMP ping (`Runtime.exec("ping ...")` или `InetAddress.isReachable`):**
   * **Почему это фатальная ошибка:** В РФ IP-адрес зарубежного сервера может прекрасно отвечать на ICMP (ping 30 мс), но протокол VLESS Reality или порт 443 на нём **наглухо заблокированы ТСПУ/РКН**. ICMP не проверяет работоспособность прокси.
   * `InetAddress.isReachable()` на Android вообще пытается стучаться на 7 TCP-порт (Echo), который везде закрыт, и почти всегда выдаёт таймаут.
2. **Простой TCP Handshake на порт сервера (Raw Socket Connect):**
   * Показывает лишь то, что открыт порт (или ответил CDN/SNI-маскировка), но не проверяет, пропускает ли провайдер TLS-хэндшейк и Reality-ключ.
3. **Тяжёлый HTTPS-запрос к `https://google.com` или `https://youtube.com`:**
   * Скачивание HTML, двойное шифрование TLS (внутри туннеля поверх VLESS TLS), редиректы 301/302. Такой замер всегда добавляет лишние 300–800 мс «мусорного» времени.
4. **Учёт «холодного старта» (Cold Handshake):**
   * При первом подключении к VLESS Reality происходит генерация ключей и согласование сессии. Это занимает 400–900 мс единоразово. Если измерить только этот первый коннект, пользователь видит пинг «800 мс», хотя реальная задержка передачи пакетов — 45 мс.
5. **Локальный DNS-резолвинг:**
   * Если Android пытается отрезолвить домен сервера через DNS мобильного оператора, запрос может перехватываться или зависать на 1-2 секунды.

---

## 2. Как это работает в Desktop Zapret.NET (Эталонная логика)

В десктопном приложении (`vlessService.js`) замер разделен на два четких сценария:

1. **Эндпоинт проверки:** 
   * Основной: `http://cp.cloudflare.com/generate_204` (Anycast CDN Cloudflare, расположен максимально близко к серверу выхода).
   * Запасной: `http://www.google.com/generate_204` (или `http://connectivitycheck.gstatic.com/generate_204`).
   * *Почему HTTP, а не HTTPS?* Потому что сам туннель VLESS уже зашифрован (TLS Reality). HTTP-запрос `generate_204` весит всего ~50 байт и возвращает статус `204 No Content` с пустым телом (0 байт). Это даёт **чистый Round-Trip Time (RTT)** без накладных расходов.
2. **Маршрутизация замера:** 
   * Запрос отправляется **строго через SOCKS5-порт прокси** с удалённым DNS-резолвингом (`socks5h://127.0.0.1:port`).
3. **Критерий успешности:** 
   * HTTP-код `204` (или `200`). Если пришёл 204 — сервер 100% не заблокирован ТСПУ и пропускает трафик.
4. **Фильтрация холодного старта:** 
   * Если первое измерение заняло > 600 мс (время ушло на установление Reality-сессии), сразу делается быстрый второй замер по уже прогретому соединению — именно он записывается в итоговый пинг.

---

## 3. Сценарии реализации в Android-клиенте

В Android-приложении нужно разделить пинг на **два независимых механизма**:

### Сценарий А. Пинг активного подключения (Live Ping раз в 5–7 секунд)
Когда `VpnService` включён, весь трафик (или трафик на порт локального SOCKS5 ядра `127.0.0.1:10808`) идёт через текущий выбранный сервер.

* Раз в 5 секунд корутина в фоне делает лёгкий GET-запрос на `http://cp.cloudflare.com/generate_204`.
* Используется единый экземпляр `OkHttpClient` с включённым пулом постоянных соединений (`ConnectionPool`), чтобы не тратить время на переподключение.
* Время замеряется через `SystemClock.elapsedRealtime()`.
* Полученное значение (например, `48 ms`) отправляется во ViewModel / StateFlow и отображается на плашке статуса.
* Если 2 раза подряд произошёл таймаут (таймаут ставим 3.5 секунды) — статус меняется на `blocked / disconnected`.

### Сценарий Б. Пинг списка серверов (Batch Ping / Выбор лучшей ноды)
Когда пользователь открывает список серверов или нажимает кнопку «Проверить пинг»:

* **Вариант 1 (Если ядро поддерживает внутренний тест, например Sing-box / Xray-core / LibXray):**
  Вызывать метод `LibXray.ping()` или встроенный URLTest ядра с указанием `http://cp.cloudflare.com/generate_204`.
* **Вариант 2 (Универсальный сетевой замер на Kotlin через OkHttp):**
  Если ядра поднимают локальные inbounds или есть доступ к тестовому проксированию:
  Запускать параллельные проверки (через `async` с ограничением пула до 6-8 одновременных задач).
  Таймаут на сервер — ровно **3 секунды**.

---

## 4. Готовый эталонный код на Kotlin (Android)

### 4.1. Клиент замера задержки (`LatencyTester.kt`)

```kotlin
package com.zapretprime.android.network

import android.os.SystemClock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit

object LatencyTester {

    private const val PROBE_URL_PRIMARY = "http://cp.cloudflare.com/generate_204"
    private const val PROBE_URL_FALLBACK = "http://www.google.com/generate_204"

    // Пул для переиспользования тёплых TCP-соединений в активном мониторинге
    private val warmConnectionPool = ConnectionPool(5, 30, TimeUnit.SECONDS)

    /**
     * Клиент для мониторинга активного туннеля (когда VPN уже поднят)
     */
    private val activeVpnClient = OkHttpClient.Builder()
        .connectionPool(warmConnectionPool)
        .connectTimeout(3000, TimeUnit.MILLISECONDS)
        .readTimeout(3000, TimeUnit.MILLISECONDS)
        .callTimeout(3500, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .build()

    /**
     * Создание клиента с SOCKS5 прокси для проверки конкретного порта
     * @param socksPort Локальный порт, на котором слушает тестовый inbound ядра (например, 10808)
     */
    fun createSocksClient(socksPort: Int): OkHttpClient {
        val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort))
        return OkHttpClient.Builder()
            .proxy(proxy)
            .connectTimeout(3000, TimeUnit.MILLISECONDS)
            .readTimeout(3000, TimeUnit.MILLISECONDS)
            .callTimeout(3500, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(false)
            .followRedirects(false)
            .build()
    }

    sealed class PingResult {
        data class Success(val latencyMs: Int) : PingResult()
        data class Blocked(val reason: String) : PingResult()
    }

    /**
     * Измеряет чистую HTTP RTT задержку до Anycast эндпоинта
     */
    suspend fun measurePing(client: OkHttpClient = activeVpnClient): PingResult = withContext(Dispatchers.IO) {
        val firstAttempt = executeProbe(client, PROBE_URL_PRIMARY)
        
        if (firstAttempt is PingResult.Success) {
            // Если первый замер превысил 600 мс (холодный старт Reality/TLS),
            // делаем моментальный повторный замер по уже прогретому сокету
            if (firstAttempt.latencyMs > 600) {
                val warmAttempt = executeProbe(client, PROBE_URL_PRIMARY)
                if (warmAttempt is PingResult.Success) {
                    return@withContext warmAttempt
                }
            }
            return@withContext firstAttempt
        }

        // Запасной опрос Google, если Cloudflare не ответил
        return@withContext executeProbe(client, PROBE_URL_FALLBACK)
    }

    private fun executeProbe(client: OkHttpClient, url: String): PingResult {
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", "ZapretPrime-Android/2.0")
            .header("Connection", "keep-alive")
            .get()
            .build()

        val start = SystemClock.elapsedRealtime()
        return try {
            client.newCall(request).execute().use { response ->
                val elapsed = (SystemClock.elapsedRealtime() - start).toInt()
                if (response.code == 204 || response.code == 200) {
                    PingResult.Success(latencyMs = maxOf(1, elapsed))
                } else {
                    PingResult.Blocked("HTTP ${response.code}")
                }
            }
        } catch (e: Exception) {
            PingResult.Blocked(e.message ?: "Timeout / TSPU Blocked")
        }
    }
}
```

---

### 4.2. Фоновый цикл мониторинга активного подключения (`VpnWatchdog.kt`)

Запускается при старте VPN-сервиса и постоянно шлёт актуальный пинг в UI:

```kotlin
package com.zapretprime.android.service

import com.zapretprime.android.network.LatencyTester
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class VpnWatchdog(
    private val scope: CoroutineScope,
    private val onPingUpdated: (pingMs: Int?, isBlocked: Boolean) -> Unit
) {
    private var job: Job? = null
    private var consecutiveFailures = 0

    fun start() {
        stop()
        consecutiveFailures = 0
        job = scope.launch(Dispatchers.IO) {
            while (isActive) {
                when (val result = LatencyTester.measurePing()) {
                    is LatencyTester.PingResult.Success -> {
                        consecutiveFailures = 0
                        withContext(Dispatchers.Main) {
                            onPingUpdated(result.latencyMs, false)
                        }
                    }
                    is LatencyTester.PingResult.Blocked -> {
                        consecutiveFailures++
                        if (consecutiveFailures >= 2) {
                            withContext(Dispatchers.Main) {
                                onPingUpdated(null, true)
                            }
                        }
                    }
                }
                delay(5000) // Проверка каждые 5 секунд
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        consecutiveFailures = 0
        onPingUpdated(null, false)
    }
}
```

---

### 4.3. Цветовая градация и отображение пинга в UI (Compose / XML)

Чтобы пинг читался наглядно, как в десктопной версии Zapret.NET:

| Диапазон задержки | Цвет | Бейдж |
|---|---|---|
| **1 – 89 мс** | Изумрудный (`#34d399` / Emerald) | Отличный быстрый сервер |
| **90 – 199 мс** | Бирюзовый / Зелёный (`#2dd4bf` / Teal) | Стабильное соединение |
| **200 – 399 мс** | Янтарный / Жёлтый (`#fbbf24` / Amber) | Средняя задержка (дальний регион) |
| **400+ мс** | Оранжевый (`#fb923c` / Orange) | Медленный сервер |
| **Таймаут / Ошибка** | Красный (`#f87171` / Rose) | Текст: `✕` или `Заблокирован` |

---

## 5. Чек-лист проверки для разработчика Android

1. [ ] **Полностью удалить вызовы `Runtime.getRuntime().exec("ping")`** и `InetAddress.isReachable`.
2. [ ] **Заменить тестовый URL** с `https://google.com` на `http://cp.cloudflare.com/generate_204`.
3. [ ] **Убедиться, что запрос идёт через прокси/TUN**, а не напрямую в обход туннеля через сотовую сеть.
4. [ ] **Выставить таймаут 3000 мс.** Не нужно ждать 10-15 секунд — если нода не ответила за 3 секунды, она либо заблокирована ТСПУ, либо непригодна для серфинга.
5. [ ] **Добавить сброс пинга на `"-"`** в момент отключения VPN (`onDestroy` в `VpnService`).
6. [ ] **Использовать `Dispatchers.IO`** для всех сетевых замеров, ни в коем случае не блокировать Main Thread.
