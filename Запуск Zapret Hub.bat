@echo off
cd /d "%~dp0"

set "EXE=%~dp0dist\win-unpacked\Zapret HUB.exe"

if not exist "%EXE%" (
  echo.
  echo Сборка не найдена:
  echo %EXE%
  echo.
  echo Выполните: npm run build
  echo Или для разработки: npm start
  echo.
  pause
  exit /b 1
)

start "" "%EXE%"
exit /b 0