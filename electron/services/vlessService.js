const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const http = require('http');

const execAsync = promisify(exec);

// Публичный / дефолтный URL подписки VLESS Reality. Может быть переопределен через переменную среды ZAPRET_DEFAULT_SUB_URL
const DEFAULT_SUB_URL = process.env.ZAPRET_DEFAULT_SUB_URL || '';
const SOCKS_PORT = 10808;
const HTTP_PORT = 10809;
const PROBE_SOCKS_PORT = 29808;
const PROBE_HTTP_PORT = 29809;
const SUB_INFO_REFRESH_TTL = 30 * 60 * 1000; // 30 минут

function parseVlessUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'vless:') return null;
    const uuid = parsed.username;
    const host = parsed.hostname;
    const port = parseInt(parsed.port, 10) || 443;
    const params = new URLSearchParams(parsed.search);
    const hash = decodeURIComponent(parsed.hash.replace(/^#/, '')) || `${host}:${port}`;

    const streamSettings = {
      network: params.get('type') || 'tcp',
      security: params.get('security') || 'none'
    };

    if (streamSettings.security === 'reality') {
      streamSettings.realitySettings = {
        serverName: params.get('sni') || host,
        publicKey: params.get('pbk') || '',
        shortId: params.get('sid') || '',
        fingerprint: params.get('fp') || 'chrome'
      };
    } else if (streamSettings.security === 'tls') {
      streamSettings.tlsSettings = {
        serverName: params.get('sni') || host,
        fingerprint: params.get('fp') || 'chrome'
      };
    }

    if (streamSettings.network === 'grpc') {
      streamSettings.grpcSettings = {
        serviceName: params.get('serviceName') || ''
      };
      if (params.get('authority')) streamSettings.grpcSettings.authority = params.get('authority');
    } else if (streamSettings.network === 'ws') {
      streamSettings.wsSettings = {
        path: params.get('path') || '/'
      };
    } else if (streamSettings.network === 'xhttp') {
      streamSettings.xhttpSettings = {
        path: params.get('path') || '/',
        mode: params.get('mode') || 'auto'
      };
      const extra = params.get('extra');
      if (extra) {
        try {
          streamSettings.xhttpSettings.extra = JSON.parse(decodeURIComponent(extra));
        } catch {}
      }
    }

    return {
      remarks: hash,
      outbounds: [
        {
          tag: 'proxy',
          protocol: 'vless',
          settings: {
            vnext: [
              {
                address: host,
                port: port,
                users: [
                  {
                    id: uuid,
                    encryption: params.get('encryption') || 'none',
                    flow: params.get('flow') || ''
                  }
                ]
              }
            ]
          },
          streamSettings
        },
        {
          tag: 'direct',
          protocol: 'freedom'
        }
      ]
    };
  } catch {
    return null;
  }
}

function parseTrojanUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'trojan:') return null;
    const password = parsed.username;
    const host = parsed.hostname;
    const port = parseInt(parsed.port, 10) || 443;
    const params = new URLSearchParams(parsed.search);
    const hash = decodeURIComponent(parsed.hash.replace(/^#/, '')) || `${host}:${port}`;

    const streamSettings = {
      network: params.get('type') || 'tcp',
      security: params.get('security') || 'tls'
    };

    if (streamSettings.security === 'tls') {
      streamSettings.tlsSettings = {
        serverName: params.get('sni') || host,
        fingerprint: params.get('fp') || 'chrome'
      };
      const alpn = params.get('alpn');
      if (alpn) {
        streamSettings.tlsSettings.alpn = alpn.split(',');
      }
    } else if (streamSettings.security === 'reality') {
      streamSettings.realitySettings = {
        serverName: params.get('sni') || host,
        publicKey: params.get('pbk') || '',
        shortId: params.get('sid') || '',
        fingerprint: params.get('fp') || 'chrome'
      };
    }

    if (streamSettings.network === 'ws') {
      streamSettings.wsSettings = {
        path: params.get('path') || '/',
        headers: {
          Host: params.get('host') || host
        }
      };
    } else if (streamSettings.network === 'grpc') {
      streamSettings.grpcSettings = {
        serviceName: params.get('serviceName') || ''
      };
      if (params.get('authority')) streamSettings.grpcSettings.authority = params.get('authority');
    }

    return {
      remarks: hash,
      outbounds: [
        {
          tag: 'proxy',
          protocol: 'trojan',
          settings: {
            servers: [
              {
                address: host,
                port: port,
                password: password
              }
            ]
          },
          streamSettings
        },
        {
          tag: 'direct',
          protocol: 'freedom'
        }
      ]
    };
  } catch {
    return null;
  }
}

class VlessService {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.appPath = options.appPath || '';
    this.isPackaged = Boolean(options.isPackaged);
    this.resourcesPath = options.resourcesPath || '';
    this.installDir = path.join(userDataPath, 'vless');
    this.exePath = path.join(this.installDir, 'xray.exe');
    this.tunExePath = path.join(this.installDir, 'sing-box.exe');
    this.configPath = path.join(this.installDir, 'vless_settings.json');
    this.activeRunConfigPath = path.join(this.installDir, 'active_run.json');
    this.activeTunConfigPath = path.join(this.installDir, 'active_tun.json');
    this.zapretService = options.zapretService || null;

    this._child = null;
    this._tunChild = null;
    this._isConnected = false;
    this._watchdogTimer = null;
    this._watchdogRunning = false;
    this._subInfoLastRefresh = 0;

    this.settings = this.loadSettings();
    this._seedFromBundled();

    // Auto-refresh subscription info on startup
    if (this.settings.subscriptionUrl && /^https?:\/\//i.test(this.settings.subscriptionUrl)) {
      this.refreshSubscriptionInfo().catch(() => {});
    }

    // Always clear leftover system proxy if VPN process is not running (e.g. after PC reboot)
    this.cleanupStaleProxy().catch(() => {});
  }

  async cleanupStaleProxy() {
    try {
      const isRunning = await this.isProcessRunning();
      if (isRunning) return;
      const { stdout } = await execAsync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { windowsHide: true }
      ).catch(() => ({ stdout: '' }));
      if (stdout && (stdout.includes(`127.0.0.1:${HTTP_PORT}`) || stdout.includes(`127.0.0.1:${SOCKS_PORT}`))) {
        await this.setSystemProxy(false);
      }
    } catch (e) {
      console.error('[VlessService] Failed to cleanup stale proxy:', e);
    }
  }

  getBundledDir() {
    if (this.isPackaged && this.resourcesPath) {
      const p = path.join(this.resourcesPath, 'vless');
      if (fs.existsSync(path.join(p, 'xray.exe'))) return p;
    }
    const local = path.join(__dirname, '..', '..', 'bundled', 'vless');
    if (fs.existsSync(path.join(local, 'xray.exe'))) return local;
    return null;
  }

  _seedFromBundled() {
    try {
      const bundled = this.getBundledDir();
      if (!bundled) return;
      fs.mkdirSync(this.installDir, { recursive: true });
      for (const f of ['xray.exe', 'sing-box.exe', 'wintun.dll', 'geoip.dat', 'geosite.dat']) {
        const src = path.join(bundled, f);
        const dst = path.join(this.installDir, f);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
        }
      }
    } catch (e) {
      console.error('[VlessService] Failed to seed from bundled:', e);
    }
  }

  loadSettings() {
    const defaults = {
      subscriptionUrl: DEFAULT_SUB_URL,
      selectedServerIndex: 0,
      systemProxy: true,
      autoFallback: true,
      lastWorkingIp: '',
      servers: []
    };
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        return { ...defaults, ...JSON.parse(raw) };
      }
    } catch {}
    return defaults;
  }

  saveSettings() {
    try {
      fs.mkdirSync(this.installDir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.settings, null, 2), 'utf8');
    } catch (e) {
      console.error('[VlessService] Failed to save settings:', e);
    }
  }

  _ensureProxyHelper() {
    try {
      fs.mkdirSync(this.installDir, { recursive: true });
      const helperPath = path.join(this.installDir, 'set-proxy.ps1');
      const bundledHelper = path.join(__dirname, '..', 'helpers', 'set-proxy.ps1');
      if (fs.existsSync(bundledHelper)) {
        fs.copyFileSync(bundledHelper, helperPath);
      } else if (!fs.existsSync(helperPath)) {
        const psScript = [
          'param (',
          '    [string]$Enable = "0",',
          '    [int]$Port = 10809,',
          '    [string]$Bypass = "localhost;127.*;10.*;192.168.*;<local>"',
          ')',
          '',
          '$isEnabled = ($Enable -eq "1" -or $Enable -eq "true" -or $Enable -eq "$true")',
          '',
          '$code = @"',
          'using System;',
          'using System.Runtime.InteropServices;',
          '',
          'public class WinInetProxy {',
          '    [DllImport("wininet.dll", CharSet = CharSet.Auto, SetLastError = true)]',
          '    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
          '',
          '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]',
          '    public struct INTERNET_PER_CONN_OPTION_LIST {',
          '        public int dwSize;',
          '        public IntPtr pszConnection;',
          '        public int dwOptionCount;',
          '        public int dwOptionError;',
          '        public IntPtr pOptions;',
          '    }',
          '',
          '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]',
          '    public struct INTERNET_PER_CONN_OPTION {',
          '        public int dwOption;',
          '        public ValueUnion Value;',
          '    }',
          '',
          '    [StructLayout(LayoutKind.Explicit)]',
          '    public struct ValueUnion {',
          '        [FieldOffset(0)]',
          '        public int dwValue;',
          '        [FieldOffset(0)]',
          '        public IntPtr pszValue;',
          '        [FieldOffset(0)]',
          '        public System.Runtime.InteropServices.ComTypes.FILETIME ftValue;',
          '    }',
          '',
          '    public const int INTERNET_OPTION_PER_CONNECTION_OPTION = 75;',
          '    public const int INTERNET_OPTION_SETTINGS_CHANGED = 39;',
          '    public const int INTERNET_OPTION_REFRESH = 37;',
          '',
          '    public const int INTERNET_PER_CONN_FLAGS = 1;',
          '    public const int INTERNET_PER_CONN_PROXY_SERVER = 2;',
          '    public const int INTERNET_PER_CONN_PROXY_BYPASS = 3;',
          '',
          '    public const int PROXY_TYPE_DIRECT = 0x00000001;',
          '    public const int PROXY_TYPE_PROXY = 0x00000002;',
          '',
          '    public static bool SetProxy(bool enable, string proxyServer, string proxyBypass) {',
          '        int optionCount = enable ? 3 : 1;',
          '        int optSize = Marshal.SizeOf(typeof(INTERNET_PER_CONN_OPTION));',
          '        IntPtr pOptions = Marshal.AllocCoTaskMem(optSize * optionCount);',
          '',
          '        try {',
          '            if (enable) {',
          '                INTERNET_PER_CONN_OPTION opt1 = new INTERNET_PER_CONN_OPTION();',
          '                opt1.dwOption = INTERNET_PER_CONN_FLAGS;',
          '                opt1.Value.dwValue = PROXY_TYPE_DIRECT | PROXY_TYPE_PROXY;',
          '                Marshal.StructureToPtr(opt1, pOptions, false);',
          '',
          '                INTERNET_PER_CONN_OPTION opt2 = new INTERNET_PER_CONN_OPTION();',
          '                opt2.dwOption = INTERNET_PER_CONN_PROXY_SERVER;',
          '                opt2.Value.pszValue = Marshal.StringToHGlobalAuto(proxyServer);',
          '                Marshal.StructureToPtr(opt2, new IntPtr(pOptions.ToInt64() + optSize), false);',
          '',
          '                INTERNET_PER_CONN_OPTION opt3 = new INTERNET_PER_CONN_OPTION();',
          '                opt3.dwOption = INTERNET_PER_CONN_PROXY_BYPASS;',
          '                opt3.Value.pszValue = Marshal.StringToHGlobalAuto(proxyBypass ?? "<local>");',
          '                Marshal.StructureToPtr(opt3, new IntPtr(pOptions.ToInt64() + (optSize * 2)), false);',
          '            } else {',
          '                INTERNET_PER_CONN_OPTION opt1 = new INTERNET_PER_CONN_OPTION();',
          '                opt1.dwOption = INTERNET_PER_CONN_FLAGS;',
          '                opt1.Value.dwValue = PROXY_TYPE_DIRECT;',
          '                Marshal.StructureToPtr(opt1, pOptions, false);',
          '            }',
          '',
          '            INTERNET_PER_CONN_OPTION_LIST list = new INTERNET_PER_CONN_OPTION_LIST();',
          '            list.dwSize = Marshal.SizeOf(typeof(INTERNET_PER_CONN_OPTION_LIST));',
          '            list.pszConnection = IntPtr.Zero;',
          '            list.dwOptionCount = optionCount;',
          '            list.dwOptionError = 0;',
          '            list.pOptions = pOptions;',
          '',
          '            int listSize = Marshal.SizeOf(typeof(INTERNET_PER_CONN_OPTION_LIST));',
          '            IntPtr pList = Marshal.AllocCoTaskMem(listSize);',
          '            Marshal.StructureToPtr(list, pList, false);',
          '',
          '            bool res = InternetSetOption(IntPtr.Zero, INTERNET_OPTION_PER_CONNECTION_OPTION, pList, listSize);',
          '            Marshal.FreeCoTaskMem(pList);',
          '',
          '            InternetSetOption(IntPtr.Zero, INTERNET_OPTION_SETTINGS_CHANGED, IntPtr.Zero, 0);',
          '            InternetSetOption(IntPtr.Zero, INTERNET_OPTION_REFRESH, IntPtr.Zero, 0);',
          '',
          '            return res;',
          '        } finally {',
          '            Marshal.FreeCoTaskMem(pOptions);',
          '        }',
          '    }',
          '}',
          '"@',
          '',
          'if (-not ([System.Management.Automation.PSTypeName]\'WinInetProxy\').Type) {',
          '    Add-Type -TypeDefinition $code',
          '}',
          '',
          '$server = "127.0.0.1:$Port"',
          '$res = [WinInetProxy]::SetProxy($isEnabled, $server, $Bypass)',
          '',
          'if ($isEnabled) {',
          '    Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyEnable -Value 1 -Type DWord -ErrorAction SilentlyContinue',
          '    Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyServer -Value $server -Type String -ErrorAction SilentlyContinue',
          '    Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyOverride -Value $Bypass -Type String -ErrorAction SilentlyContinue',
          '} else {',
          '    Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyEnable -Value 0 -Type DWord -ErrorAction SilentlyContinue',
          '}',
          '',
          'Write-Output $res'
        ].join('\r\n');
        fs.writeFileSync(helperPath, psScript, 'utf8');
      }
    } catch (e) {
      console.warn('[VlessService] Failed to ensure proxy helper:', e);
    }
  }

  async setSystemProxy(enable, httpPort = HTTP_PORT, socksPort = SOCKS_PORT) {
    try {
      this._ensureProxyHelper();
      const psHelper = path.join(this.installDir, 'set-proxy.ps1');
      const bypassVal = 'localhost;127.*;10.*;192.168.*;<local>';
      const enableArg = enable ? '1' : '0';

      if (fs.existsSync(psHelper)) {
        await execAsync(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${psHelper}" -Enable ${enableArg} -Port ${httpPort} -Bypass "${bypassVal}"`,
          { windowsHide: true, timeout: 6000 }
        );
      } else {
        if (enable) {
          const serverVal = `127.0.0.1:${httpPort}`;
          await execAsync(
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f && ` +
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${serverVal}" /f && ` +
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${bypassVal}" /f`,
            { windowsHide: true }
          );
        } else {
          await execAsync(
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
            { windowsHide: true }
          );
        }
      }
    } catch (e) {
      console.error('[VlessService] Failed to toggle system proxy:', e);
    }
  }

  async updateBypassRules() {
    if (this.settings.systemProxy && this._isConnected && (await this.isProcessRunning())) {
      await this.setSystemProxy(true);
    }
  }

  async isProcessRunning() {
    if (!this._child || this._child.killed) return false;
    try {
      process.kill(this._child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async refreshSubscriptionInfo() {
    const url = (this.settings.subscriptionUrl || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return null;

    try {
      const { stdout } = await execAsync(
        `curl.exe -s -I -A "Happ/4.2.1, Zapret.NET/2.0.0" --max-time 8 "${url.replace(/"/g, '`"')}"`,
        { windowsHide: true, timeout: 9000 }
      );
      if (stdout) {
        const uMatch = stdout.match(/subscription-userinfo:\s*([^\r\n]+)/i);
        const tMatch = stdout.match(/profile-title:\s*(?:base64:)?([^\r\n]+)/i);

        if (uMatch) {
          const userinfo = uMatch[1];
          const expMatch = userinfo.match(/expire=(\d+)/i);
          const upMatch = userinfo.match(/upload=(\d+)/i);
          const downMatch = userinfo.match(/download=(\d+)/i);
          const totMatch = userinfo.match(/total=(\d+)/i);

          const expire = expMatch ? parseInt(expMatch[1], 10) : null;
          let daysLeft = null;
          if (expire && expire > 0) {
            daysLeft = Math.max(0, Math.ceil((new Date(expire * 1000) - Date.now()) / (86400 * 1000)));
          }

          let serviceName = null;
          if (tMatch) {
            try {
              serviceName = Buffer.from(tMatch[1].trim(), 'base64').toString('utf8');
            } catch {
              serviceName = tMatch[1].trim();
            }
          }

          this.settings.subscriptionInfo = {
            expire,
            daysLeft,
            serviceName: serviceName || this.settings.subscriptionInfo?.serviceName || 'DedVPN Private',
            upload: upMatch ? parseInt(upMatch[1], 10) : 0,
            download: downMatch ? parseInt(downMatch[1], 10) : 0,
            total: totMatch ? parseInt(totMatch[1], 10) : 0,
            updatedAt: Date.now()
          };
          this.saveSettings();
          return this.settings.subscriptionInfo;
        }
      }
    } catch (e) {
      console.error('[VlessService] Failed to refresh subscription info:', e);
    }
    return null;
  }

  fetchUrlContent(url, depth = 0) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const getter = parsed.protocol === 'https:' ? https : http;
      getter.get(url, {
        headers: {
          'User-Agent': 'Happ/4.2.1, Zapret.NET/2.0.0',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (depth >= 6) {
            res.resume();
            return reject(new Error('Слишком много редиректов при загрузке подписки'));
          }
          return this.fetchUrlContent(res.headers.location, depth + 1).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  async fetchSubscriptionUrl(url) {
    try {
      const { stdout } = await execAsync(
        `curl.exe -s -L -D - -H "Cache-Control: no-cache, no-store, must-revalidate" -H "Pragma: no-cache" -A "Happ/4.2.1, Zapret.NET/2.0.0" --max-time 15 "${url.replace(/"/g, '`"')}"`,
        { windowsHide: true, timeout: 16000 }
      );
      if (stdout && stdout.trim().length > 0) {
        const parts = stdout.split(/\r?\n\r?\n/);
        let userinfo = null;
        let profileTitle = null;
        for (const part of parts) {
          const uMatch = part.match(/subscription-userinfo:\s*([^\r\n]+)/i);
          if (uMatch) userinfo = uMatch[1];
          const tMatch = part.match(/profile-title:\s*(?:base64:)?([^\r\n]+)/i);
          if (tMatch) profileTitle = tMatch[1];
        }

        if (userinfo) {
          const expMatch = userinfo.match(/expire=(\d+)/i);
          const upMatch = userinfo.match(/upload=(\d+)/i);
          const downMatch = userinfo.match(/download=(\d+)/i);
          const totMatch = userinfo.match(/total=(\d+)/i);

          const expire = expMatch ? parseInt(expMatch[1], 10) : null;
          let daysLeft = null;
          if (expire && expire > 0) {
            daysLeft = Math.max(0, Math.ceil((new Date(expire * 1000) - Date.now()) / (86400 * 1000)));
          }

          let serviceName = null;
          if (profileTitle) {
            try {
              serviceName = Buffer.from(profileTitle.trim(), 'base64').toString('utf8');
            } catch {
              serviceName = profileTitle.trim();
            }
          }

          this.settings.subscriptionInfo = {
            expire,
            daysLeft,
            serviceName,
            upload: upMatch ? parseInt(upMatch[1], 10) : 0,
            download: downMatch ? parseInt(downMatch[1], 10) : 0,
            total: totMatch ? parseInt(totMatch[1], 10) : 0,
            updatedAt: Date.now()
          };
          this.saveSettings();
        }

        const body = parts[parts.length - 1];
        return body || stdout;
      }
    } catch {}
    return this.fetchUrlContent(url);
  }

  parseSubscriptionPayload(raw) {
    if (!raw || typeof raw !== 'string') return [];
    let text = raw.trim();
    let servers = [];

    const parseLine = (line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith('vless://')) {
        const parsed = parseVlessUri(trimmed);
        if (parsed && parsed.outbounds && parsed.outbounds[0]) {
          const out = parsed.outbounds[0];
          const vn = out.settings && out.settings.vnext && out.settings.vnext[0];
          if (!vn) return null;
          return {
            id: `server_${idx}`,
            name: parsed.remarks || `VLESS Сервер #${idx + 1}`,
            address: vn.address,
            port: vn.port,
            protocol: 'vless',
            network: out.streamSettings?.network || 'tcp',
            security: out.streamSettings?.security || 'none',
            sni: out.streamSettings?.realitySettings?.serverName || out.streamSettings?.tlsSettings?.serverName || '',
            status: 'unknown',
            latency: null,
            ping: null,
            rawConfig: parsed
          };
        }
      } else if (trimmed.startsWith('trojan://')) {
        const parsed = parseTrojanUri(trimmed);
        if (parsed && parsed.outbounds && parsed.outbounds[0]) {
          const out = parsed.outbounds[0];
          const srv = out.settings && out.settings.servers && out.settings.servers[0];
          if (!srv) return null;
          return {
            id: `server_${idx}`,
            name: parsed.remarks || `Trojan Сервер #${idx + 1}`,
            address: srv.address,
            port: srv.port,
            protocol: 'trojan',
            network: out.streamSettings?.network || 'tcp',
            security: out.streamSettings?.security || 'tls',
            sni: out.streamSettings?.tlsSettings?.serverName || '',
            status: 'unknown',
            latency: null,
            ping: null,
            rawConfig: parsed
          };
        }
      }
      return null;
    };

    const parseJson = (str) => {
      try {
        const json = JSON.parse(str);
        if (Array.isArray(json)) {
          return json.map((s, idx) => {
            const remarks = s._remarks || s.remarks || `Сервер #${idx + 1}`;
            const outbounds = s.outbounds || [];
            const firstOut = outbounds[0] || {};
            const protocol = firstOut.protocol || 'vless';
            const settings = firstOut.settings || {};
            const vnext = (settings.vnext && settings.vnext[0]) || {};
            const srvObj = (settings.servers && settings.servers[0]) || {};
            const address = vnext.address || srvObj.address || '';
            const port = vnext.port || srvObj.port || 443;
            const stream = firstOut.streamSettings || {};
            const network = stream.network || 'tcp';
            const security = stream.security || 'none';
            const sni = (stream.realitySettings && stream.realitySettings.serverName) || (stream.tlsSettings && stream.tlsSettings.serverName) || '';

            return {
              id: `server_${idx}`,
              name: remarks,
              address,
              port,
              protocol,
              network,
              security,
              sni,
              status: 'unknown',
              latency: null,
              ping: null,
              rawConfig: s
            };
          }).filter(s => s.address);
        }
      } catch {}
      return [];
    };

    // 1. Try parsing JSON directly
    if (text.startsWith('[') || text.startsWith('{')) {
      servers = parseJson(text);
      if (servers.length > 0) return servers;
    }

    // 2. Try parsing plaintext lines (vless:// or trojan://)
    if (text.includes('vless://') || text.includes('trojan://')) {
      const lines = text.split(/\r?\n/);
      let idx = 0;
      for (const line of lines) {
        const s = parseLine(line, idx);
        if (s) {
          servers.push(s);
          idx++;
        }
      }
      if (servers.length > 0) return servers;
    }

    // 3. Try base64 decoding whole text
    try {
      const cleanBase64 = text.replace(/\s+/g, '');
      const decoded = Buffer.from(cleanBase64, 'base64').toString('utf8');
      if (decoded && decoded !== text) {
        if (decoded.trim().startsWith('[') || decoded.trim().startsWith('{')) {
          servers = parseJson(decoded.trim());
          if (servers.length > 0) return servers;
        }
        const lines = decoded.split(/\r?\n/);
        let idx = 0;
        for (const line of lines) {
          const s = parseLine(line, idx);
          if (s) {
            servers.push(s);
            idx++;
          }
        }
        if (servers.length > 0) return servers;
      }
    } catch {}

    // 4. Try line-by-line base64 decode
    const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let idx = 0;
    for (const rLine of rawLines) {
      try {
        const decLine = Buffer.from(rLine, 'base64').toString('utf8');
        const s = parseLine(decLine, idx);
        if (s) {
          servers.push(s);
          idx++;
        }
      } catch {}
    }

    return servers;
  }

  async probeSocksPort(port, timeoutMs = 2500, fetchIp = false, skipWarmReProbe = false) {
    const maxSec = Math.max(1.5, Math.min(6, (timeoutMs / 1000))).toFixed(1);
    let isReachable = false;
    let externalIp = '';
    let measuredPing = null;

    // 1. Primary probe: Cloudflare Anycast edge generate_204 with precise curl timing
    try {
      const { stdout } = await execAsync(
        `curl.exe -x socks5h://127.0.0.1:${port} http://cp.cloudflare.com/generate_204 -s -o NUL -w "%{http_code}:%{time_total}" --max-time ${maxSec}`,
        { windowsHide: true, timeout: timeoutMs + 1000 }
      );
      const parts = (stdout || '').trim().split(':');
      const code = parts[0];
      const timeSec = parseFloat(parts[1]);
      if (code === '204' || code === '200') {
        isReachable = true;
        if (!isNaN(timeSec) && timeSec > 0) {
          measuredPing = Math.max(1, Math.round(timeSec * 1000));
        }
      }
    } catch {}

    // 2. Secondary fallback probe: Google generate_204 (fast check)
    if (!isReachable) {
      try {
        const fallbackSec = Math.min(1.5, parseFloat(maxSec)).toFixed(1);
        const { stdout } = await execAsync(
          `curl.exe -x socks5h://127.0.0.1:${port} http://www.google.com/generate_204 -s -o NUL -w "%{http_code}:%{time_total}" --max-time ${fallbackSec}`,
          { windowsHide: true, timeout: Math.round(parseFloat(fallbackSec) * 1000) + 1000 }
        );
        const parts = (stdout || '').trim().split(':');
        const code = parts[0];
        const timeSec = parseFloat(parts[1]);
        if (code === '204' || code === '200') {
          isReachable = true;
          if (!isNaN(timeSec) && timeSec > 0) {
            measuredPing = Math.max(1, Math.round(timeSec * 1000));
          }
        }
      } catch {}
    }

    if (!isReachable) {
      return { ok: false, error: 'Заблокирован ТСПУ (нет ответа)' };
    }

    // If first probe had high latency due to cold-start TLS/Reality handshake, measure true roundtrip over warm tunnel (skipped in batch tests)
    if (!skipWarmReProbe && isReachable && measuredPing && measuredPing > 600) {
      try {
        const { stdout: warmOut } = await execAsync(
          `curl.exe -x socks5h://127.0.0.1:${port} http://cp.cloudflare.com/generate_204 -s -o NUL -w "%{http_code}:%{time_total}" --max-time 2.5`,
          { windowsHide: true, timeout: 3000 }
        );
        const warmParts = (warmOut || '').trim().split(':');
        if (warmParts[0] === '204' || warmParts[0] === '200') {
          const warmTime = parseFloat(warmParts[1]);
          if (!isNaN(warmTime) && warmTime > 0) {
            measuredPing = Math.max(1, Math.round(warmTime * 1000));
          }
        }
      } catch {}
    }

    const ping = measuredPing || 45;

    // 3. Only fetch external IP if explicitly requested (e.g. for active connection)
    if (fetchIp) {
      try {
        const { stdout } = await execAsync(
          `curl.exe -x socks5h://127.0.0.1:${port} http://ident.me --max-time 2 -s`,
          { windowsHide: true, timeout: 2500 }
        );
        const trimmed = (stdout || '').trim();
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
          externalIp = trimmed;
        }
      } catch {}

      if (!externalIp) {
        try {
          const { stdout } = await execAsync(
            `curl.exe -x socks5h://127.0.0.1:${port} https://1.1.1.1/cdn-cgi/trace --max-time 2 -s`,
            { windowsHide: true, timeout: 2500 }
          );
          const m = (stdout || '').match(/ip=([0-9.]+)/);
          if (m && /^(\d{1,3}\.){3}\d{1,3}$/.test(m[1])) {
            externalIp = m[1];
          }
        } catch {}
      }
    }

    return { ok: true, ping, ip: externalIp || '', latency: ping };
  }

  async probeAlternativeOutbound(outbound, timeoutMs = 2500, portOffset = 0, skipWarmReProbe = true) {
    const testPort = PROBE_SOCKS_PORT + 99 + (portOffset % 100);
    const testCfg = {
      log: { loglevel: 'warning' },
      inbounds: [
        {
          tag: 'socks_test_alt',
          port: testPort,
          listen: '127.0.0.1',
          protocol: 'socks',
          settings: { udp: true }
        }
      ],
      outbounds: [
        { ...outbound, tag: 'proxy' },
        { tag: 'direct', protocol: 'freedom' }
      ],
      dns: {
        servers: [
          'https://1.1.1.1/dns-query',
          'https://8.8.8.8/dns-query',
          '77.88.8.8'
        ],
        queryStrategy: 'UseIPv4'
      },
      routing: {
        domainStrategy: 'AsIs',
        rules: [{ type: 'field', inboundTag: ['socks_test_alt'], outboundTag: 'proxy' }]
      }
    };

    const tmpPath = path.join(this.installDir, 'probe_alt_tmp.json');
    fs.mkdirSync(this.installDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(testCfg), 'utf8');

    let child = null;
    try {
      child = spawn(this.exePath, ['run', '-c', tmpPath], { windowsHide: true, stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 400));
      return await this.probeSocksPort(testPort, timeoutMs, false, skipWarmReProbe);
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      if (child) {
        try { child.kill(); } catch {}
      }
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  async updateSubscription(url = null, resetPings = true) {
    const target = (url || this.settings.subscriptionUrl || '').trim();
    if (!target) throw new Error('Не указана ссылка на подписку');

    let raw = '';
    if (/^https?:\/\//i.test(target)) {
      this.settings.subscriptionUrl = target;
      raw = await this.fetchSubscriptionUrl(target);
    } else {
      raw = target;
      if (!this.settings.subscriptionUrl || !/^https?:\/\//i.test(this.settings.subscriptionUrl)) {
        this.settings.subscriptionUrl = target;
      }
    }

    const parsedServers = this.parseSubscriptionPayload(raw);
    if (!parsedServers || parsedServers.length === 0) {
      throw new Error('Не удалось распознать формат подписки. Проверьте правильность ссылки или ключа.');
    }

    // Preserve previously working/promoted outbounds for each server
    const oldServersByName = new Map();
    (this.settings.servers || []).forEach(s => {
      if (s.name) oldServersByName.set(s.name, s);
    });

    parsedServers.forEach(s => {
      const old = oldServersByName.get(s.name);
      if (old && old.rawConfig && Array.isArray(old.rawConfig.outbounds)) {
        const oldFirstHost = old.rawConfig.outbounds[0]?.settings?.servers?.[0]?.address || old.rawConfig.outbounds[0]?.settings?.vnext?.[0]?.address;
        if (oldFirstHost && s.rawConfig && Array.isArray(s.rawConfig.outbounds)) {
          const matchIdx = s.rawConfig.outbounds.findIndex(o => 
            (o.settings?.servers?.[0]?.address || o.settings?.vnext?.[0]?.address) === oldFirstHost
          );
          if (matchIdx > 0) {
            const [promoted] = s.rawConfig.outbounds.splice(matchIdx, 1);
            s.rawConfig.outbounds.unshift(promoted);
            s.address = oldFirstHost;
          }
        }
      }
    });

    if (!resetPings) {
      const oldServersMap = new Map();
      (this.settings.servers || []).forEach(s => {
        const key = `${s.name || ''}_${s.address || ''}_${s.port || ''}`;
        oldServersMap.set(key, s);
      });

      parsedServers.forEach(s => {
        const key = `${s.name || ''}_${s.address || ''}_${s.port || ''}`;
        const old = oldServersMap.get(key);
        if (old && old.status && old.status !== 'unknown') {
          s.status = old.status;
          s.ping = old.ping;
          s.latency = old.latency;
          s.ip = old.ip;
        }
      });
    }

    this.settings.servers = parsedServers;
    this.saveSettings();
    return { count: parsedServers.length, serverCount: parsedServers.length, servers: parsedServers, subscriptionInfo: this.settings.subscriptionInfo, daysLeft: this.settings.subscriptionInfo?.daysLeft };
  }

  async clearSubscription() {
    if (this._isConnected) {
      await this.disconnect(true);
    }
    this.settings.subscriptionUrl = '';
    this.settings.subscriptionInfo = null;
    this.settings.servers = [];
    this.settings.selectedServerIndex = 0;
    this.saveSettings();
    return this.getStatus();
  }

  async testSingleServer(serverIndex, customTimeout = 3000) {
    const srv = this.settings.servers[serverIndex];
    if (!srv) throw new Error('Сервер не найден');

    this._seedFromBundled();
    if (!fs.existsSync(this.exePath)) {
      throw new Error('Ядро Xray не найдено в приложении');
    }

    const testPort = PROBE_SOCKS_PORT;
    const testCfg = {
      log: { loglevel: 'warning' },
      inbounds: [
        {
          tag: 'socks_test',
          port: testPort,
          listen: '127.0.0.1',
          protocol: 'socks',
          settings: { udp: true },
          sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
        }
      ],
      outbounds: [
        { ...srv.rawConfig.outbounds[0], tag: 'proxy' },
        { tag: 'direct', protocol: 'freedom' }
      ],
      dns: {
        servers: [
          'https://1.1.1.1/dns-query',
          'https://8.8.8.8/dns-query',
          'https://common.dot.dns.yandex.net/dns-query',
          '77.88.8.8'
        ],
        queryStrategy: 'UseIPv4'
      },
      routing: {
        domainStrategy: 'AsIs',
        rules: [
          {
            type: 'field',
            inboundTag: ['socks_test'],
            outboundTag: 'proxy'
          }
        ]
      }
    };

    const tmpPath = path.join(this.installDir, `probe_${serverIndex}.json`);
    fs.mkdirSync(this.installDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(testCfg), 'utf8');

    let probeChild = null;
    try {
      probeChild = spawn(this.exePath, ['run', '-c', tmpPath], {
        windowsHide: true,
        stdio: 'ignore'
      });

      await new Promise(r => setTimeout(r, 600));

      const res = await this.probeSocksPort(testPort, customTimeout);
      let finalRes = res;

      // If primary outbound failed, check fallback proxy outbounds
      if (!finalRes.ok && srv.rawConfig && Array.isArray(srv.rawConfig.outbounds)) {
        const altProxies = srv.rawConfig.outbounds.filter((o, oIdx) => 
          oIdx > 0 && ['vless', 'trojan', 'vmess', 'shadowsocks'].includes((o.protocol || '').toLowerCase())
        );
        for (let altIdx = 0; altIdx < altProxies.length; altIdx++) {
          const alt = altProxies[altIdx];
          const altRes = await this.probeAlternativeOutbound(alt, customTimeout, altIdx);
          if (altRes.ok) {
            finalRes = altRes;
            const altIdx = srv.rawConfig.outbounds.indexOf(alt);
            if (altIdx > 0) {
              const [promoted] = srv.rawConfig.outbounds.splice(altIdx, 1);
              srv.rawConfig.outbounds.unshift(promoted);
            }
            const newHost = alt.settings?.servers?.[0]?.address || alt.settings?.vnext?.[0]?.address;
            const newPort = alt.settings?.servers?.[0]?.port || alt.settings?.vnext?.[0]?.port;
            if (newHost) srv.address = newHost;
            if (newPort) srv.port = newPort;
            break;
          }
        }
      }

      if (finalRes.ok) {
        srv.status = 'ok';
        srv.ping = finalRes.ping;
        srv.latency = finalRes.latency;
        srv.ip = finalRes.ip;
        srv.error = null;
        this.saveSettings();
        return { ok: true, ping: finalRes.ping, latency: finalRes.latency, ip: finalRes.ip };
      } else {
        srv.status = 'blocked';
        srv.ping = null;
        srv.latency = null;
        srv.error = finalRes.error || 'Заблокирован ТСПУ (нет ответа)';
        this.saveSettings();
        return { ok: false, error: srv.error };
      }
    } catch (e) {
      srv.status = 'blocked';
      srv.ping = null;
      srv.latency = null;
      srv.error = 'Заблокирован ТСПУ (таймаут)';
      this.saveSettings();
      return { ok: false, error: srv.error };
    } finally {
      if (probeChild) {
        try { probeChild.kill(); } catch {}
      }
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  async testAllServers(onProgress) {
    const servers = this.settings.servers;
    if (!servers || servers.length === 0) {
      return { servers: [], summary: { total: 0, ok: 0, blocked: 0 } };
    }

    this._seedFromBundled();
    if (!fs.existsSync(this.exePath)) {
      throw new Error('Ядро Xray не найдено в приложении');
    }

    const BASE_PORT = 29800;
    const MAX_CONCURRENT = 16;
    let okCount = 0;
    let blockedCount = 0;

    for (let chunkStart = 0; chunkStart < servers.length; chunkStart += MAX_CONCURRENT) {
      const chunk = servers.slice(chunkStart, chunkStart + MAX_CONCURRENT);
      const inbounds = [];
      const outbounds = [];
      const rules = [];

      chunk.forEach((srv, cIdx) => {
        const port = BASE_PORT + cIdx;
        const inTag = `in_${cIdx}`;
        const outTag = `proxy_${cIdx}`;

        inbounds.push({
          tag: inTag,
          port: port,
          listen: '127.0.0.1',
          protocol: 'socks',
          settings: { udp: true },
          sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
        });

        const outCfg = JSON.parse(JSON.stringify(srv.rawConfig.outbounds[0]));
        outCfg.tag = outTag;
        outbounds.push(outCfg);

        rules.push({
          type: 'field',
          inboundTag: [inTag],
          outboundTag: outTag
        });
      });

      outbounds.push({ tag: 'direct', protocol: 'freedom' });

      const testConfig = {
        log: { loglevel: 'warning' },
        inbounds,
        outbounds,
        dns: {
          servers: [
            'https://1.1.1.1/dns-query',
            'https://8.8.8.8/dns-query',
            'https://common.dot.dns.yandex.net/dns-query',
            '77.88.8.8'
          ],
          queryStrategy: 'UseIPv4'
        },
        routing: {
          domainStrategy: 'AsIs',
          rules
        }
      };

      const tmpPath = path.join(this.installDir, `test_chunk_${chunkStart}.json`);
      fs.mkdirSync(this.installDir, { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(testConfig), 'utf8');

      let probeChild = null;
      try {
        probeChild = spawn(this.exePath, ['run', '-c', tmpPath], {
          windowsHide: true,
          stdio: 'ignore'
        });

        // Give 500ms to bind ports
        await new Promise(r => setTimeout(r, 500));

        // Test chunk in sub-batches of 8
        const SUB_BATCH = 8;
        for (let j = 0; j < chunk.length; j += SUB_BATCH) {
          const subBatch = chunk.slice(j, j + SUB_BATCH);
          await Promise.all(subBatch.map(async (srv, subIdx) => {
            const cIdx = j + subIdx;
            const globalIdx = chunkStart + cIdx;
            const port = BASE_PORT + cIdx;
            let res = await this.probeSocksPort(port, 2500, false, true);

            // If primary outbound failed, check fallback proxy outbounds
            if (!res.ok && srv.rawConfig && Array.isArray(srv.rawConfig.outbounds)) {
              const altProxies = srv.rawConfig.outbounds.filter((o, oIdx) => 
                oIdx > 0 && ['vless', 'trojan', 'vmess', 'shadowsocks'].includes((o.protocol || '').toLowerCase())
              );
              for (const alt of altProxies) {
                const altRes = await this.probeAlternativeOutbound(alt, 2000, cIdx, true);
                if (altRes.ok) {
                  res = altRes;
                  const altIdx = srv.rawConfig.outbounds.indexOf(alt);
                  if (altIdx > 0) {
                    const [promoted] = srv.rawConfig.outbounds.splice(altIdx, 1);
                    srv.rawConfig.outbounds.unshift(promoted);
                  }
                  const newHost = alt.settings?.servers?.[0]?.address || alt.settings?.vnext?.[0]?.address;
                  const newPort = alt.settings?.servers?.[0]?.port || alt.settings?.vnext?.[0]?.port;
                  if (newHost) srv.address = newHost;
                  if (newPort) srv.port = newPort;
                  break;
                }
              }
            }

            srv.status = res.ok ? 'ok' : 'blocked';
            srv.ping = res.ping || null;
            srv.latency = res.latency || null;
            srv.ip = res.ip || null;
            srv.error = res.ok ? null : (res.error || 'Заблокирован ТСПУ (таймаут)');

            if (res.ok) okCount++;
            else blockedCount++;

            if (typeof onProgress === 'function') {
              onProgress({
                index: globalIdx,
                current: globalIdx + 1,
                total: servers.length,
                server: srv,
                result: res
              });
            }

            return { index: globalIdx, ...res };
          }));
        }
      } finally {
        if (probeChild) {
          try { probeChild.kill(); } catch {}
        }
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }

    this.saveSettings();

    return {
      servers: this.settings.servers,
      summary: { total: servers.length, ok: okCount, blocked: blockedCount }
    };
  }

  async connect(index = null) {
    this._seedFromBundled();
    if (!fs.existsSync(this.exePath)) {
      throw new Error('Ядро Xray не найдено. Проверьте установку.');
    }

    // Only fetch subscription if servers list is currently empty
    if (!this.settings.servers || this.settings.servers.length === 0) {
      if (this.settings.subscriptionUrl && /^https?:\/\//i.test(this.settings.subscriptionUrl)) {
        await this.updateSubscription(null, false);
      }
    }

    // Auto-select best server if not provided: choose from already measured servers if available
    if (index === null || index === undefined || index < 0) {
      let found = (this.settings.servers || [])
        .map((s, idx) => ({ ...s, originalIndex: idx }))
        .filter(s => s.status === 'ok' && typeof s.ping === 'number' && s.ping > 0)
        .sort((a, b) => (a.ping - b.ping));

      if (found.length === 0) {
        const testRes = await this.testAllServers();
        found = (testRes.servers || [])
          .map((s, idx) => ({ ...s, originalIndex: idx }))
          .filter(s => s.status === 'ok' && typeof s.ping === 'number' && s.ping > 0)
          .sort((a, b) => (a.ping - b.ping));
      }

      if (found.length > 0) {
        index = found[0].originalIndex;
      } else if (this.settings.servers && this.settings.servers.length > 0) {
        index = 0;
      } else {
        throw new Error('Все серверы подписки заблокированы ТСПУ провайдера.');
      }
    } else if (this.settings.servers[index]?.status === 'blocked' && this.settings.autoFallback) {
      const working = this.settings.servers
        .map((s, idx) => ({ ...s, originalIndex: idx }))
        .filter(s => s.status === 'ok' && typeof s.ping === 'number' && s.ping > 0)
        .sort((a, b) => ((a.ping || 9999) - (b.ping || 9999)));
      if (working.length > 0) {
        console.log(`[VlessService] Server ${this.settings.servers[index].name} is blocked, auto-routing to ${working[0].name}`);
        index = working[0].originalIndex;
      }
    }

    const srv = this.settings.servers[index];
    if (!srv) throw new Error('Выбранный сервер не существует');

    this.settings.selectedServerIndex = index;
    await this.disconnect(false);

    // Prepare active run config
    const runCfg = JSON.parse(JSON.stringify(srv.rawConfig));
    const proxyTag = (runCfg.outbounds && runCfg.outbounds[0] && runCfg.outbounds[0].tag) || 'proxy';

    runCfg.inbounds = [
      {
        tag: 'socks_in',
        port: SOCKS_PORT,
        listen: '127.0.0.1',
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
      },
      {
        tag: 'http_in',
        port: HTTP_PORT,
        listen: '127.0.0.1',
        protocol: 'http',
        settings: { allowTransparent: false },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
      }
    ];

    runCfg.outbounds = runCfg.outbounds || [];
    if (!runCfg.outbounds.some(o => o.tag === 'direct')) {
      runCfg.outbounds.push({ tag: 'direct', protocol: 'freedom' });
    }

    runCfg.dns = {
      servers: [
        'https://1.1.1.1/dns-query',
        'https://8.8.8.8/dns-query',
        'https://common.dot.dns.yandex.net/dns-query',
        '77.88.8.8'
      ],
      queryStrategy: 'UseIPv4'
    };

    runCfg.routing = runCfg.routing || {};
    runCfg.routing.domainStrategy = 'AsIs';
    runCfg.routing.rules = runCfg.routing.rules || [];

    // Remove IP checkers from existing direct rules (e.g. if provider bundled domain:ru or domain:ipify)
    const ipCheckersRegex = /2ip|ipinfo|ipify|ifconfig|icanhazip|whoer|browserleaks|whatismyip/i;
    runCfg.routing.rules.forEach(r => {
      if (r && r.outboundTag === 'direct' && Array.isArray(r.domain)) {
        r.domain = r.domain.filter(d => !ipCheckersRegex.test(d));
      }
    });

    // Filter out rules that have empty domain arrays to avoid Xray config validation errors
    runCfg.routing.rules = runCfg.routing.rules.filter(r => !Array.isArray(r.domain) || r.domain.length > 0);

    // Direct routing for Whitelist (list-exclude)
    try {
      const excludeSites = this.zapretService
        ? (this.zapretService.getAllExcludeSites ? this.zapretService.getAllExcludeSites() : this.zapretService.getExcludeSites())
        : [];
      const filteredExcludes = Array.isArray(excludeSites)
        ? excludeSites.filter(d => !ipCheckersRegex.test(d))
        : [];
      if (filteredExcludes.length > 0) {
        runCfg.routing.rules.unshift({
          type: 'field',
          domain: filteredExcludes,
          outboundTag: 'direct'
        });
      }
    } catch {}

    // Force IP checkers to route through proxy so users can reliably verify VPN connectivity
    const ipCheckersList = [
      'domain:2ip.ru', 'domain:2ip.io', 'domain:ipinfo.io', 'domain:ipify.org',
      'domain:ifconfig.me', 'domain:icanhazip.com', 'domain:whoer.net', 'domain:browserleaks.com'
    ];
    runCfg.routing.rules.unshift({
      type: 'field',
      domain: ipCheckersList,
      outboundTag: proxyTag
    });

    runCfg.routing.rules.push({
      type: 'field',
      inboundTag: ['socks_in', 'http_in'],
      outboundTag: proxyTag
    });

    runCfg.log = { loglevel: 'warning' };

    fs.mkdirSync(this.installDir, { recursive: true });
    fs.writeFileSync(this.activeRunConfigPath, JSON.stringify(runCfg), 'utf8');

    // Launch xray.exe
    const child = spawn(this.exePath, ['run', '-c', this.activeRunConfigPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.unref();
    this._child = child;

    await new Promise(r => setTimeout(r, 600));

    // Verify connection is alive before enabling system proxy
    let probeRes = await this.probeSocksPort(SOCKS_PORT, 5500);

    // If primary outbound failed during connect, check if server has alternative proxy outbounds
    if (!probeRes.ok && srv.rawConfig && Array.isArray(srv.rawConfig.outbounds)) {
      const altProxies = srv.rawConfig.outbounds.filter((o, oIdx) =>
        oIdx > 0 && ['vless', 'trojan', 'vmess', 'shadowsocks'].includes((o.protocol || '').toLowerCase())
      );
      for (const alt of altProxies) {
        const altIdx = srv.rawConfig.outbounds.indexOf(alt);
        if (altIdx > 0) {
          const [promoted] = srv.rawConfig.outbounds.splice(altIdx, 1);
          srv.rawConfig.outbounds.unshift(promoted);
        }
        const newHost = alt.settings?.servers?.[0]?.address || alt.settings?.vnext?.[0]?.address;
        const newPort = alt.settings?.servers?.[0]?.port || alt.settings?.vnext?.[0]?.port;
        if (newHost) srv.address = newHost;
        if (newPort) srv.port = newPort;

        // Re-generate run config with promoted outbound
        const newRunCfg = JSON.parse(JSON.stringify(srv.rawConfig));
        newRunCfg.inbounds = runCfg.inbounds;
        newRunCfg.dns = runCfg.dns;
        newRunCfg.routing = runCfg.routing;
        newRunCfg.log = runCfg.log;
        fs.writeFileSync(this.activeRunConfigPath, JSON.stringify(newRunCfg), 'utf8');

        // Kill previous child and restart
        if (this._child) {
          try { process.kill(this._child.pid, 'SIGKILL'); } catch {}
          this._child = null;
        }
        try { await execAsync('taskkill /F /IM xray.exe /T', { windowsHide: true, timeout: 3000 }); } catch {}

        const altChild = spawn(this.exePath, ['run', '-c', this.activeRunConfigPath], {
          detached: true,
          windowsHide: true,
          stdio: 'ignore'
        });
        altChild.unref();
        this._child = altChild;
        await new Promise(r => setTimeout(r, 600));

        probeRes = await this.probeSocksPort(SOCKS_PORT, 5500);
        if (probeRes.ok) break;
      }
    }

    if (!probeRes.ok) {
      await this.disconnect(true);
      srv.status = 'blocked';
      this.saveSettings();
      throw new Error(`Узел «${srv.name}» заблокирован ТСПУ (нет ответа). Выберите другой сервер.`);
    }

    srv.ip = probeRes.ip;
    srv.ping = probeRes.ping;
    srv.latency = probeRes.latency;
    srv.status = 'ok';
    this._isConnected = true;

    // Start TUN (Transparent system-wide adapter) if sing-box & wintun are present
    await this.startTun();

    if (this.settings.systemProxy) {
      await this.setSystemProxy(true, HTTP_PORT, SOCKS_PORT);
    }

    this.saveSettings();
    this.startWatchdog();

    return this.getStatus();
  }

  async startTun() {
    try {
      if (!fs.existsSync(this.tunExePath)) return;
      const tunConfig = {
        dns: {
          servers: [
            {
              address: '8.8.8.8',
              detour: 'direct',
              tag: 'dns-proxy'
            }
          ]
        },
        inbounds: [
          {
            type: 'tun',
            tag: 'tun-in',
            interface_name: 'zapret-tun',
            address: ['172.18.0.1/30'],
            mtu: 1500,
            auto_route: true,
            strict_route: true,
            stack: 'mixed'
          }
        ],
        outbounds: [
          {
            type: 'socks',
            tag: 'proxy',
            server: '127.0.0.1',
            server_port: SOCKS_PORT,
            udp_fragment: true,
            domain_resolver: {
              server: 'dns-proxy',
              strategy: 'prefer_ipv4'
            }
          },
          {
            type: 'direct',
            tag: 'direct',
            domain_resolver: {
              server: 'dns-proxy',
              strategy: 'prefer_ipv4'
            }
          }
        ],
        route: {
          auto_detect_interface: true,
          final: 'proxy',
          rules: [
            {
              process_name: ['xray.exe', 'sing-box.exe', 'winws.exe'],
              outbound: 'direct'
            },
            {
              action: 'sniff'
            },
            {
              protocol: 'dns',
              action: 'hijack-dns'
            }
          ]
        },
        log: {
          level: 'warn',
          timestamp: true
        }
      };

      // Direct routing for Whitelist in TUN mode (sing-box)
      try {
        const excludeSites = this.zapretService
          ? (this.zapretService.getAllExcludeSites ? this.zapretService.getAllExcludeSites() : this.zapretService.getExcludeSites())
          : [];
        const filteredExcludes = Array.isArray(excludeSites)
          ? excludeSites.filter(d => !/^(?:.*\.)?2ip\.(?:ru|io)$/i.test(d))
          : [];
        if (filteredExcludes.length > 0) {
          tunConfig.route.rules.unshift({
            domain_suffix: filteredExcludes,
            outbound: 'direct'
          });
        }
      } catch {}

      fs.writeFileSync(this.activeTunConfigPath, JSON.stringify(tunConfig, null, 2), 'utf8');

      // Stop any previous instance of sing-box
      try {
        await execAsync('taskkill /F /IM sing-box.exe /T', { windowsHide: true, timeout: 3000 });
      } catch {}

      const tunChild = spawn(this.tunExePath, ['run', '-c', this.activeTunConfigPath], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      tunChild.unref();
      this._tunChild = tunChild;
      console.log('[VlessService] TUN adapter started (zapret-tun via sing-box)');
    } catch (e) {
      console.warn('[VlessService] Could not start TUN adapter (system proxy fallback active):', e);
    }
  }

  async stopTun() {
    if (this._tunChild) {
      try { process.kill(this._tunChild.pid, 'SIGKILL'); } catch {}
      this._tunChild = null;
    }
    try {
      await execAsync('taskkill /F /IM sing-box.exe /T', { windowsHide: true, timeout: 5000 });
    } catch {}
    this._tunChild = null;
  }

  async disconnect(restoreProxy = true) {
    this._isConnected = false;
    this.stopWatchdog();
    if (typeof this.onPingUpdate === 'function') {
      this.onPingUpdate({ index: -1, ping: null, serverName: '', disconnected: true });
    }
    await this.stopTun();

    if (this._child) {
      try {
        process.kill(this._child.pid, 'SIGKILL');
      } catch {}
      this._child = null;
    }
    try {
      await execAsync('taskkill /F /IM xray.exe /T', { windowsHide: true, timeout: 5000 });
    } catch {}
    this._child = null;

    if (restoreProxy) {
      await this.setSystemProxy(false);
    }

    return this.getStatus();
  }

  startWatchdog() {
    this.stopWatchdog();
    this._watchdogFailures = 0;
    this._watchdogTimer = setInterval(async () => {
      if (this._watchdogRunning) return;
      this._watchdogRunning = true;
      try {
        const isRunning = await this.isProcessRunning();
        if (!isRunning) return;

        const currentIndex = this.settings.selectedServerIndex;
        const srv = (this.settings.servers && typeof currentIndex === 'number')
          ? this.settings.servers[currentIndex]
          : null;

        // Ultra-lightweight ping probe via socks5h
        let probeOk = false;
        let measuredPing = null;
        try {
          const { stdout } = await execAsync(
            `curl.exe -x socks5h://127.0.0.1:${SOCKS_PORT} http://cp.cloudflare.com/generate_204 -s -o NUL -w "%{http_code}:%{time_total}" --max-time 3`,
            { windowsHide: true, timeout: 3500 }
          );
          const parts = (stdout || '').trim().split(':');
          if (parts[0] === '204' || parts[0] === '200') {
            probeOk = true;
            const timeSec = parseFloat(parts[1]);
            if (!isNaN(timeSec) && timeSec > 0) {
              measuredPing = Math.max(1, Math.round(timeSec * 1000));
            }
          }
        } catch {}

        if (!probeOk) {
          try {
            const { stdout } = await execAsync(
              `curl.exe -x socks5h://127.0.0.1:${SOCKS_PORT} http://www.google.com/generate_204 -s -o NUL -w "%{http_code}:%{time_total}" --max-time 3`,
              { windowsHide: true, timeout: 3500 }
            );
            const parts = (stdout || '').trim().split(':');
            if (parts[0] === '204' || parts[0] === '200') {
              probeOk = true;
              const timeSec = parseFloat(parts[1]);
              if (!isNaN(timeSec) && timeSec > 0) {
                measuredPing = Math.max(1, Math.round(timeSec * 1000));
              }
            }
          } catch {}
        }

        if (probeOk) {
          this._watchdogFailures = 0;
          const pingMs = measuredPing || 45;
          if (srv) {
            srv.ping = pingMs;
            srv.latency = pingMs;
            srv.status = 'ok';
          }
          if (typeof this.onPingUpdate === 'function') {
            this.onPingUpdate({
              index: currentIndex,
              ping: pingMs,
              serverName: srv ? srv.name : 'VLESS Node'
            });
          }
          return;
        }

        // Probe failed
        this._watchdogFailures = (this._watchdogFailures || 0) + 1;
        if (this._watchdogFailures >= 2) {
          if (srv) {
            srv.status = 'blocked';
          }
          if (typeof this.onPingUpdate === 'function') {
            this.onPingUpdate({
              index: currentIndex,
              ping: null,
              serverName: srv ? srv.name : 'VLESS Node',
              blocked: true
            });
          }

          if (this.settings.autoFallback) {
            console.log('[VlessService] Current node blocked, auto-fallbacking...');
            const otherWorking = (this.settings.servers || [])
              .map((s, idx) => ({ ...s, originalIndex: idx }))
              .filter(s => (s.status === 'ok' || s.status === 'working') && s.originalIndex !== currentIndex)
              .sort((a, b) => ((a.ping || a.latency || 9999) - (b.ping || b.latency || 9999)));

            if (otherWorking.length > 0) {
              const nextServer = otherWorking[0];
              try {
                await this.connect(nextServer.originalIndex);
              } catch {}
            }
          }
        }
      } finally {
        this._watchdogRunning = false;
      }
    }, 5000);
  }

  stopWatchdog() {
    this._watchdogFailures = 0;
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    this._watchdogRunning = false;
  }

  async toggleSystemProxy(enabled) {
    this.settings.systemProxy = Boolean(enabled);
    this.saveSettings();
    const isRunning = await this.isProcessRunning();
    if (isRunning) {
      await this.setSystemProxy(this.settings.systemProxy);
    }
    return this.settings.systemProxy;
  }

  async setAutoFallback(enabled) {
    this.settings.autoFallback = Boolean(enabled);
    this.saveSettings();
    return this.settings.autoFallback;
  }

  async getStatus() {
    const running = Boolean(this._isConnected && (await this.isProcessRunning()));
    const currentServer = this.settings.servers[this.settings.selectedServerIndex] || null;

    let daysLeft = null;
    if (this.settings.subscriptionInfo?.expire) {
      daysLeft = Math.max(0, Math.ceil((new Date(this.settings.subscriptionInfo.expire * 1000) - Date.now()) / (86400 * 1000)));
      this.settings.subscriptionInfo.daysLeft = daysLeft;
    } else if (this.settings.subscriptionUrl && /^https?:\/\//i.test(this.settings.subscriptionUrl)) {
      const now = Date.now();
      if (now - this._subInfoLastRefresh > SUB_INFO_REFRESH_TTL) {
        this._subInfoLastRefresh = now;
        this.refreshSubscriptionInfo().catch(() => {});
      }
    }

    return {
      running,
      activeServer: currentServer,
      activeServerIndex: this.settings.selectedServerIndex,
      subscriptionUrl: this.settings.subscriptionUrl,
      subscriptionInfo: this.settings.subscriptionInfo || null,
      daysLeft: daysLeft ?? (this.settings.subscriptionInfo?.daysLeft ?? null),
      systemProxy: this.settings.systemProxy,
      autoFallback: this.settings.autoFallback,
      servers: this.settings.servers,
      socksPort: SOCKS_PORT,
      httpPort: HTTP_PORT
    };
  }
}

module.exports = { VlessService, DEFAULT_SUB_URL };
