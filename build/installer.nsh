!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER

Var CleanInstallCheckbox
Var DoCleanInstall

!macro customPageAfterChangeDir
  Page custom CleanInstallPageCreate CleanInstallPageLeave
!macroend

!macro customCheckAppRunning
  # Принудительно выгружаем все процессы перед началом установки
  nsExec::Exec 'taskkill /F /IM "Zapret HUB.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM winws.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM xray.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM ZapretTgProxy.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM TgWsProxy.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM sing-box.exe'
  Pop $0
!macroend

Function CleanInstallPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "Выберите параметры установки Zapret HUB:"
  Pop $0

  ${NSD_CreateCheckbox} 0 24u 100% 14u "Выполнить чистую установку (рекомендуется)"
  Pop $CleanInstallCheckbox
  ${NSD_Check} $CleanInstallCheckbox

  ${NSD_CreateLabel} 14u 42u 92% 80u "При выборе чистой установки установщик:$\r$\n • Принудительно завершит процессы Zapret HUB, winws, xray и ZapretTgProxy;$\r$\n • Остановит и удалит устаревшие системные службы (zapret, WinDivert);$\r$\n • Очистит выбранную папку установки от остатков предыдущих версий.$\r$\n$\r$\nВаши настройки (выбранная стратегия, ссылки VPN, списки сайтов) сохранятся в безопасности в папке AppData."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function CleanInstallPageLeave
  ${NSD_GetState} $CleanInstallCheckbox $DoCleanInstall

  ${If} $DoCleanInstall == ${BST_CHECKED}
    Call DoCleanInstallRoutine
  ${EndIf}
FunctionEnd

Function DoCleanInstallRoutine
  DetailPrint "Завершение фоновых процессов..."
  nsExec::Exec 'taskkill /F /IM "Zapret HUB.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM winws.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM xray.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM ZapretTgProxy.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM TgWsProxy.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM sing-box.exe'
  Pop $0

  DetailPrint "Остановка и удаление системных служб..."
  nsExec::Exec 'sc stop zapret'
  Pop $0
  nsExec::Exec 'sc delete zapret'
  Pop $0
  nsExec::Exec 'sc stop WinDivert'
  Pop $0
  nsExec::Exec 'sc delete WinDivert'
  Pop $0
  nsExec::Exec 'sc stop WinDivert14'
  Pop $0
  nsExec::Exec 'sc delete WinDivert14'
  Pop $0

  # Очистка предыдущей версии в целевой директории
  ${If} ${FileExists} "$INSTDIR\Zapret HUB.exe"
    DetailPrint "Очистка файлов предыдущей версии в $INSTDIR..."
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    Delete "$INSTDIR\Zapret HUB.exe"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.bin"
  ${EndIf}
FunctionEnd

!endif
