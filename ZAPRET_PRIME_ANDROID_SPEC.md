# Спецификация и руководство разработки: Zapret Prime (Android)

Этот документ содержит архитектуру, правила интеграции и готовые решения для переноса функций Zapret Prime с ПК-версии на Android (Kotlin / Android SDK). Передайте этот файл разработчику или ИИ-ассистенту для реализации.

---

## 1. Замер пинга серверов (Почему ICMP врёт и как сделать правильно)

### 1.1. Главная проблема на Android
Стандартная утилита `ping` (ICMP echo) на Android **не работает корректно без root-прав**:
- Ядро Android блокирует `RAW`-сокеты (`AF_INET, SOCK_RAW`, нет привилегии `CAP_NET_RAW`).
- Системный вызов `Runtime.getRuntime().exec("ping ...")` либо завершается с ошибкой, либо возвращает искажённые тайминги системного стека, либо всегда выдаёт `0 / -1 мс`.

### 1.2. Решение (как сделано на ПК и как делать на Android)
Пинг серверов VLESS / Reality должен измеряться **через задержку установки TCP-соединения (TCP Connect Latency) или TLS Handshake**:
- Измеряется реальное время открытия сетевого сокета к хосту и порту сервера (`Socket.connect`).
- Это гарантированно работает на любых устройствах Android без root и отражает реальную задержку до прокси.

### 1.3. Готовая реализация на Kotlin (Coroutines)

```kotlin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket

data class ServerPingResult(
    val serverId: String,
    val pingMs: Long?,       // null если сервер недоступен / заблокирован
    val isBlocked: Boolean
)

object PingManager {
    private const val CONNECT_TIMEOUT_MS = 2500 // 2.5 сек таймаут

    /**
     * Измеряет задержку TCP-соединения до хоста и порта узла.
     */
    suspend fun measureTcpPing(host: String, port: Int, serverId: String): ServerPingResult {
        return withContext(Dispatchers.IO) {
            val startTime = System.currentTimeMillis()
            var socket: Socket? = null
            try {
                socket = Socket()
                val socketAddress = InetSocketAddress(host, port)
                socket.connect(socketAddress, CONNECT_TIMEOUT_MS)
                val latency = System.currentTimeMillis() - startTime
                ServerPingResult(serverId = serverId, pingMs = latency, isBlocked = false)
            } catch (e: Exception) {
                // Таймаут, Connection Refused или блокировка провайдером
                ServerPingResult(serverId = serverId, pingMs = null, isBlocked = true)
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }
    }
}
```

### 1.4. Цветовая градация плашек пинга (как в ПК-версии)
- **`< 80 мс`** — Зелёный (отличный): текст `#34d399`, фон `rgba(16, 185, 129, 0.1)`, бордер `rgba(16, 185, 129, 0.2)`
- **`80 – 160 мс`** — Янтарный/Жёлтый (средний): текст `#fbbf24`, фон `rgba(245, 158, 11, 0.1)`, бордер `rgba(245, 158, 11, 0.2)`
- **`> 160 мс`** — Серый (высокий): текст `#94a3b8`, фон `rgba(255, 255, 255, 0.05)`
- **Сбой / Блок** — Красный: текст `#f87171`, фон `rgba(239, 68, 68, 0.1)`, текст «Блок»

---

## 2. Встроенный Telegram Proxy в телефон

### 2.1. Логика работы
На компьютере Zapret Prime запускает локальный процесс-демон и даёт ссылку Telegram. На Android поднимать отдельный бинарник не требуется — трафик организуется через локальный SOCKS5/HTTP инбаунд туннельного ядра.

### 2.2. Архитектура решения
1. В конфигурации VPN-ядра (sing-box или Xray core) настраивается локальный порт для входящих подключений (inbound):
   - Протокол: `socks` или `mixed`
   - Адрес: `127.0.0.1`
   - Порт: например, `10808`
2. Этот порт слушает локальный интерфейс устройства и направляет трафик через активный VPN-туннель.
3. В интерфейсе приложения при нажатии кнопки **«Подключить в Telegram»** генерируется ссылка вида:
   ```
   tg://socks?server=127.0.0.1&port=10808
   ```
4. Приложение отправляет системный `Intent`, который перехватывает официальный клиент Telegram и мгновенно предлагает сохранить прокси в один клик.

### 2.3. Готовая реализация Intent на Kotlin

```kotlin
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast

object TelegramProxyHelper {
    private const val PROXY_PORT = 10808
    private const val PROXY_HOST = "127.0.0.1"

    fun buildProxyUrl(): String {
        return "tg://socks?server=$PROXY_HOST&port=$PROXY_PORT"
    }

    /**
     * Открывает Telegram с преднастроенным локальным прокси
     */
    fun openTelegramProxy(context: Context) {
        val proxyUri = Uri.parse(buildProxyUrl())
        val intent = Intent(Intent.ACTION_VIEW, proxyUri).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }

        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            // Если Telegram не установлен или Intent не перехвачен — копируем в буфер обмена
            copyToClipboard(context, buildProxyUrl())
            Toast.makeText(
                context,
                "Ссылка скопирована в буфер обмена (Telegram не найден)",
                Toast.LENGTH_SHORT
            ).show()
        }
    }

    fun copyToClipboard(context: Context, text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Telegram Proxy", text)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(context, "Прокси-ссылка скопирована", Toast.LENGTH_SHORT).show()
    }
}
```

---

## 3. Прямые исключения трафика (Steam, TikTok, банки)

### 3.1. Зачем это нужно
Сервисы Steam и TikTok не требуют обхода и при пропуске через зарубежный VPN или модификаторы DPI работают медленно или блокируют запросы по гео-IP.

### 3.2. Настройка маршрутизации (Routing Rules)

В конфигурационном JSON sing-box / Xray добавить прямое правило (`direct`):

#### Для sing-box (`route.rules`):
```json
{
  "rules": [
    {
      "domain_suffix": [
        "steampowered.com",
        "steamcommunity.com",
        "steamstatic.com",
        "steamcontent.com",
        "steamserver.net",
        "tiktok.com",
        "tiktokcdn.com",
        "byteoversea.com",
        "ibytedtos.com",
        "musical.ly"
      ],
      "outbound": "direct"
    }
  ]
}
```

#### Для Xray-core (`routing.rules`):
```json
{
  "rules": [
    {
      "type": "field",
      "domain": [
        "domain:steampowered.com",
        "domain:steamcommunity.com",
        "domain:steamstatic.com",
        "domain:steamcontent.com",
        "domain:tiktok.com",
        "domain:tiktokcdn.com",
        "domain:byteoversea.com"
      ],
      "outboundTag": "direct"
    }
  ]
}
```

---

## 4. UI и анимации переключателей

### 4.1. Логика кнопок питания (Power Buttons)
- При нажатии на кнопку старта/стопа туннеля или прокси **нельзя сразу менять статус** или делать анимацию на 1 секунду.
- Состояние кнопки должно быть `isBusy = true`:
  1. Блокировать повторные клики (`button.isEnabled = false`).
  2. Крутить индикатор загрузки (`CircularProgressIndicator`) непрерывно.
  3. Снимать загрузку и менять цвет (зеленый/серый) **строго после получения подтверждения** от фоновой службы `VpnService` / ядра о реальном старте или остановке туннеля.

### 4.2. Размер плашек пинга
- Все плашки замера пинга в списке серверов должны иметь фиксированный минимальный размер (на ПК: `min-w-[58px]`, `h-7`, скругление `8dp`), чтобы при переключении серверов список не прыгал по ширине.
