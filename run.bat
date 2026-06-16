@echo off
cd /d "%~dp0"

set "EXE=%~dp0dist\win-unpacked\Zapret HUB.exe"

if not exist "%EXE%" (
  echo.
  echo Build not found:
  echo %EXE%
  echo.
  echo Run: npm run build
  echo Or for dev: npm start
  echo.
  pause
  exit /b 1
)

start "" "%EXE%"
exit /b 0