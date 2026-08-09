@echo off
chcp 65001 >nul
cd /d "%~dp0"

netstat -ano | findstr /R /C:":8888 .*LISTENING" >nul
if errorlevel 1 (
  start "記帳網站伺服器" /min cmd /c "npm.cmd run dev"
  timeout /t 3 /nobreak >nul
)
start "" "http://localhost:8888"
