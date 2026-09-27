; installer.nsh — custom NSIS hook for Zapret HUB
; Kills running app processes before installation to prevent
; "VCRUNTIME140.dll: decompression resulted in return code -1!" error

!macro preInit
  ; Nothing needed before init
!macroend

!macro customInit
  ; Kill any running instances of the app before installation
  nsExec::ExecToLog 'taskkill /F /IM "Zapret HUB.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "xray.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "winws.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "ZapretTgProxy.exe" /T'
  Sleep 500
!macroend

!macro customInstall
  ; Nothing extra needed during install
!macroend

!macro customUnInstall
  ; Kill processes before uninstall too
  nsExec::ExecToLog 'taskkill /F /IM "Zapret HUB.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "xray.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "winws.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "ZapretTgProxy.exe" /T'
  Sleep 500
!macroend
