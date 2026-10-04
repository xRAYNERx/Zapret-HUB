# Руководство по интеграции локального Telegram Proxy в Android-версию Zapret Prime

> Данный документ составлен на основе реализации модуля **Telegram Proxy (`ZapretTgProxy` / `TgWsProxy`)** в десктопной версии Zapret Prime.  
> Передайте этот файл AI-разработчику или в чат разработки Android-приложения для быстрой и безошибочной реализации фичи на Android.

---

## 1. Как это работает в десктопной версии Zapret Prime

В ПК-версии Zapret Prime встроен отдельный легковесный прокси-сервер (`ZapretTgProxy.exe`, форк `TgWsProxy`):

1. **Локальный порт и хост:** Сервер слушает локальный сокет `127.0.0.1:1443`.
2. **Секрет (Fake-TLS):** При первом старте генерируется случайный 16-байтный hex-ключ (32 символа). Для маскировки трафика под TLS к нему добавляется префикс `dd`:  
   `secret = "dd" + 32_hex_chars` (например, `dd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`).
3. **Ссылка для подключения:** Формируется стандартная ссылка для мессенджера:  
   `tg://proxy?server=127.0.0.1&port=1443&secret=dd<ваш_ключ>`  
   *(Запасная веб-ссылка: `https://t.me/proxy?server=127.0.0.1&port=1443&secret=dd<ваш_ключ>`)*.
4. **Подключение:** Пользователь нажимает кнопку «Подключить к Telegram» — ОС открывает Telegram с диалогом «Включить прокси?». После подтверждения весь трафик Telegram (сообщения, фото, видео, голосовые звонки) идёт через локальный сокет на порт `1443`, где прокси заворачивает его в защищённый туннель к Cloudflare / серверам Telegram в обход блокировок ТСПУ.

---

## 2. Почему у AI-разработчика не получается на Android: 4 главных капкана

Если просто попытаться скопировать десктопную логику в лоб, на Android она разобьётся о системные ограничения ОС:

### Капкан №1: Защита W^X (Write XOR Execute) и SELinux в Android 10+ (API 29+)
* **Типичная ошибка:** AI кладёт скомпилированный бинарник в `context.filesDir` или `context.cacheDir`, делает `chmod 755` и вызывает `Runtime.getRuntime().exec()`.
* **Что происходит:** Android 10+ мгновенно блокирует исполнение файлов из папок данных приложения: `avc: denied { execute }` или `java.io.IOException: Permission denied`.
* **Как правильно:** Любой нативный исполняемый файл (ELF) **ОБЯЗАН** лежать в папке нативных библиотек `app/src/main/jniLibs/arm64-v8a/` с префиксом `lib` и расширением `.so` (например, `libtgproxy.so`). Android при установке APK автоматически копирует его в изолированную защищенную системную директорию `nativeLibraryDir` с системными правами на исполнение (`r-xp`).

### Капкан №2: Убийство процесса в фоне (Doze Mode / OOM Killer)
* **Типичная ошибка:** AI запускает процесс через корутину в обычной Activity или ViewModel.
* **Что происходит:** Как только пользователь переключается из Zapret Prime в приложение Telegram, Android через 10–20 секунд замораживает или убивает процесс прокси. Прокси мгновенно отваливается.
* **Как правильно:** Запуск бинарника должен производиться строго внутри **Android `ForegroundService`** с постоянным уведомлением в шторке («Telegram Proxy работает») и частичным WakeLock при необходимости.

### Капкан №3: Архитектура процессора (ARM64 vs x86)
* На десктопе используется PE-бинарник `ZapretTgProxy.exe` под Windows x64.
* Для смартфонов нужен бинарник под **Linux ARM64 (`arm64-v8a`)** и опционально `armeabi-v7a`.

### Капкан №4: Конфликт с VPN (если включен TUN)
* Если в приложении одновременно запущен VLESS VPN через `VpnService`, нужно убедиться, что локальный трафик `127.0.0.1` не блокируется и не заворачивается внутрь себя самого (`builder.addDisallowedApplication(packageName)`).

---

## 3. Два рабочих способа реализации на Android

### Способ 1 (Точная копия десктопа): Запуск бинарника `tgws-proxy` через `jniLibs`

Исходный код `TgWsProxy` написан на Go. Собрать бинарник под Android ARM64 можно одной командой:
```bash
# Кросс-компиляция Go под Android ARM64:
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o libtgproxy.so main.go
```
Полученный файл `libtgproxy.so` кладётся в проект Android:
`app/src/main/jniLibs/arm64-v8a/libtgproxy.so`

---

### Способ 2 (Без сторонних бинарников — через встроенный Xray / Sing-box):
Если в вашем Android-приложении уже подключено ядро Xray / Sing-box для VLESS, **отдельный бинарник вообще не нужен!**
В ядре поднимается дополнительный локальный inbound:
* SOCKS5 на порту `127.0.0.1:1443`
* Telegram поддерживает не только MTProto, но и SOCKS5!
* Ссылка для Telegram в таком случае:
  `tg://socks?server=127.0.0.1&port=1443`
Это даёт точно такой же обход блокировок Telegram, не требуя сторонних демонов.

---

## 4. Готовый код на Kotlin (для Способа 1 — нативный бинарник)

### 4.1. Генерация настроек и ссылки (`TgProxyConfig.kt`)

```kotlin
package com.zapretprime.android.tgproxy

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

object TgProxyConfig {
    const val HOST = "127.0.0.1"
    const val PORT = 1443

    fun getOrCreateSecret(context: Context): String {
        val prefs = context.getSharedPreferences("tg_proxy_prefs", Context.MODE_PRIVATE)
        var secret = prefs.getString("secret", null)
        if (secret.isNullOrEmpty()) {
            val random = SecureRandom()
            val bytes = ByteArray(16)
            random.nextBytes(bytes)
            secret = bytes.joinToString("") { "%02x".format(it) }
            prefs.edit().putString("secret", secret).apply()
        }
        return secret
    }

    /**
     * Создает config.json для TgWsProxy во внутреннем хранилище
     */
    fun createConfigFile(context: Context): File {
        val secret = getOrCreateSecret(context)
        val configDir = File(context.filesDir, "tgproxy")
        if (!configDir.exists()) configDir.mkdirs()

        val configFile = File(configDir, "config.json")
        val json = JSONObject().apply {
            put("host", HOST)
            put("port", PORT)
            put("secret", secret)
            put("cfproxy", true)
            put("verbose", false)
            put("autostart", false)
            put("buf_kb", 256)
            put("pool_size", 4)
            put("ws_keepalive_interval", 30)
            put("dc_ip", JSONArray().apply {
                put("2:149.154.167.220")
                put("4:149.154.167.220")
            })
        }

        configFile.writeText(json.toString(2))
        return configFile
    }

    /**
     * Формирует tg:// ссылку с префиксом Fake-TLS (dd)
     */
    fun getTelegramProxyUrl(context: Context): String {
        val rawSecret = getOrCreateSecret(context)
        val fullSecret = "dd$rawSecret"
        return "tg://proxy?server=$HOST&port=$PORT&secret=$fullSecret"
    }
}
```

---

### 4.2. Сервис управления процессом (`TgProxyForegroundService.kt`)

```kotlin
package com.zapretprime.android.tgproxy

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

class TgProxyForegroundService : Service() {

    private var proxyProcess: Process? = null
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    companion object {
        const val CHANNEL_ID = "tg_proxy_channel"
        const val NOTIFICATION_ID = 14431

        fun start(context: Context) {
            val intent = Intent(context, TgProxyForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, TgProxyForegroundService::class.java)
            context.stopService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Запуск Telegram Proxy..."))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        serviceScope.launch {
            startProxyBinary()
        }
        return START_STICKY
    }

    private suspend fun startProxyBinary() {
        stopProxyProcess()

        // ВАЖНО: берем бинарник из nativeLibraryDir, где у него есть права на исполнение (r-xp)
        val binaryFile = File(applicationInfo.nativeLibraryDir, "libtgproxy.so")
        if (!binaryFile.exists()) {
            updateNotification("Ошибка: libtgproxy.so не найден в jniLibs")
            return
        }

        val configFile = TgProxyConfig.createConfigFile(this)

        try {
            val processBuilder = ProcessBuilder(
                binaryFile.absolutePath,
                "-c", configFile.absolutePath
            ).apply {
                directory(configFile.parentFile)
                redirectErrorStream(true)
            }

            proxyProcess = processBuilder.start()

            // Ожидаем открытие порта 1443
            var isReady = false
            for (i in 0 until 20) {
                delay(150)
                if (isPortOpen("127.0.0.1", TgProxyConfig.PORT)) {
                    isReady = true
                    break
                }
            }

            if (isReady) {
                updateNotification("Telegram Proxy работает на порту 1443")
            } else {
                updateNotification("Не удалось запустить прокси (порт занят)")
            }

        } catch (e: Exception) {
            updateNotification("Ошибка запуска: ${e.localizedMessage}")
        }
    }

    private fun isPortOpen(host: String, port: Int, timeoutMs: Int = 200): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), timeoutMs)
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun stopProxyProcess() {
        try {
            proxyProcess?.destroy()
            proxyProcess = null
        } catch (_: Exception) {}
    }

    private fun updateNotification(text: String) {
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Zapret Prime — Telegram Proxy")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Telegram Proxy Service",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        serviceScope.cancel()
        stopProxyProcess()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
```

---

### 4.3. Кнопка «Подключить к Telegram» (`TelegramOpener.kt`)

```kotlin
package com.zapretprime.android.tgproxy

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast

object TelegramOpener {
    fun openProxyInTelegram(context: Context) {
        val proxyUrl = TgProxyConfig.getTelegramProxyUrl(context)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(proxyUrl)).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }

        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            // Если схема tg:// не перехватилась, пробуем веб-ссылку t.me
            val webUrl = proxyUrl.replace("tg://proxy", "https://t.me/proxy")
            try {
                val webIntent = Intent(Intent.ACTION_VIEW, Uri.parse(webUrl)).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(webIntent)
            } catch (_: Exception) {
                Toast.makeText(context, "Telegram не установлен на устройстве", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
```

---

## 5. Чек-лист для проверки в Android-проекте

1. [ ] Добавить `FOREGROUND_SERVICE` в `AndroidManifest.xml`:
   ```xml
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
   <uses-permission android:name="android.permission.INTERNET" />
   ```
2. [ ] Убедиться, что бинарник лежит именно в `app/src/main/jniLibs/arm64-v8a/libtgproxy.so`, а **НЕ** копируется вручную в `filesDir`.
3. [ ] В `build.gradle` (app) добавить сохранение библиотек без сжатия:
   ```groovy
   android {
       packagingOptions {
           jniLibs {
               useLegacyPackaging = true
           }
       }
   }
   ```
4. [ ] Проверить, что секрет передаётся с префиксом `dd` (Fake-TLS), иначе Telegram в РФ не сможет пробить DPI провайдера.
5. [ ] При нажатии кнопки «Выключить TG Proxy» вызывать `TgProxyForegroundService.stop(context)`.
