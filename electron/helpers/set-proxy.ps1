param (
    [string]$Enable = "0",
    [int]$Port = 10809,
    [string]$Bypass = "localhost;127.*;10.*;192.168.*;<local>"
)

$isEnabled = ($Enable -eq "1" -or $Enable -eq "true" -or $Enable -eq "$true")

$code = @"
using System;
using System.Runtime.InteropServices;

public class WinInetProxy {
    [DllImport("wininet.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct INTERNET_PER_CONN_OPTION_LIST {
        public int dwSize;
        public IntPtr pszConnection;
        public int dwOptionCount;
        public int dwOptionError;
        public IntPtr pOptions;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct INTERNET_PER_CONN_OPTION {
        public int dwOption;
        public ValueUnion Value;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct ValueUnion {
        [FieldOffset(0)]
        public int dwValue;
        [FieldOffset(0)]
        public IntPtr pszValue;
        [FieldOffset(0)]
        public System.Runtime.InteropServices.ComTypes.FILETIME ftValue;
    }

    public const int INTERNET_OPTION_PER_CONNECTION_OPTION = 75;
    public const int INTERNET_OPTION_SETTINGS_CHANGED = 39;
    public const int INTERNET_OPTION_REFRESH = 37;

    public const int INTERNET_PER_CONN_FLAGS = 1;
    public const int INTERNET_PER_CONN_PROXY_SERVER = 2;
    public const int INTERNET_PER_CONN_PROXY_BYPASS = 3;

    public const int PROXY_TYPE_DIRECT = 0x00000001;
    public const int PROXY_TYPE_PROXY = 0x00000002;

    public static bool SetProxy(bool enable, string proxyServer, string proxyBypass) {
        int optionCount = enable ? 3 : 1;
        int optSize = Marshal.SizeOf(typeof(INTERNET_PER_CONN_OPTION));
        IntPtr pOptions = Marshal.AllocCoTaskMem(optSize * optionCount);

        try {
            if (enable) {
                INTERNET_PER_CONN_OPTION opt1 = new INTERNET_PER_CONN_OPTION();
                opt1.dwOption = INTERNET_PER_CONN_FLAGS;
                opt1.Value.dwValue = PROXY_TYPE_DIRECT | PROXY_TYPE_PROXY;
                Marshal.StructureToPtr(opt1, pOptions, false);

                INTERNET_PER_CONN_OPTION opt2 = new INTERNET_PER_CONN_OPTION();
                opt2.dwOption = INTERNET_PER_CONN_PROXY_SERVER;
                opt2.Value.pszValue = Marshal.StringToHGlobalAuto(proxyServer);
                Marshal.StructureToPtr(opt2, new IntPtr(pOptions.ToInt64() + optSize), false);

                INTERNET_PER_CONN_OPTION opt3 = new INTERNET_PER_CONN_OPTION();
                opt3.dwOption = INTERNET_PER_CONN_PROXY_BYPASS;
                opt3.Value.pszValue = Marshal.StringToHGlobalAuto(proxyBypass ?? "<local>");
                Marshal.StructureToPtr(opt3, new IntPtr(pOptions.ToInt64() + (optSize * 2)), false);
            } else {
                INTERNET_PER_CONN_OPTION opt1 = new INTERNET_PER_CONN_OPTION();
                opt1.dwOption = INTERNET_PER_CONN_FLAGS;
                opt1.Value.dwValue = PROXY_TYPE_DIRECT;
                Marshal.StructureToPtr(opt1, pOptions, false);
            }

            INTERNET_PER_CONN_OPTION_LIST list = new INTERNET_PER_CONN_OPTION_LIST();
            list.dwSize = Marshal.SizeOf(typeof(INTERNET_PER_CONN_OPTION_LIST));
            list.pszConnection = IntPtr.Zero;
            list.dwOptionCount = optionCount;
            list.dwOptionError = 0;
            list.pOptions = pOptions;

            int listSize = Marshal.SizeOf(typeof(INTERNET_PER_CONN_OPTION_LIST));
            IntPtr pList = Marshal.AllocCoTaskMem(listSize);
            Marshal.StructureToPtr(list, pList, false);

            bool res = InternetSetOption(IntPtr.Zero, INTERNET_OPTION_PER_CONNECTION_OPTION, pList, listSize);
            Marshal.FreeCoTaskMem(pList);

            InternetSetOption(IntPtr.Zero, INTERNET_OPTION_SETTINGS_CHANGED, IntPtr.Zero, 0);
            InternetSetOption(IntPtr.Zero, INTERNET_OPTION_REFRESH, IntPtr.Zero, 0);

            return res;
        } finally {
            Marshal.FreeCoTaskMem(pOptions);
        }
    }
}
"@

if (-not ([System.Management.Automation.PSTypeName]'WinInetProxy').Type) {
    Add-Type -TypeDefinition $code
}

$server = "127.0.0.1:$Port"
$res = [WinInetProxy]::SetProxy($isEnabled, $server, $Bypass)

# Belt and suspenders: write registry values as well
if ($isEnabled) {
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 1 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyServer -Value $server -Type String -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyOverride -Value $Bypass -Type String -ErrorAction SilentlyContinue
} else {
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 0 -Type DWord -ErrorAction SilentlyContinue
}

Write-Output $res
