@echo off
cd /d "%~dp0"
start "Sancho server" cmd /k node server.js
timeout /t 2 /nobreak >nul
start http://127.0.0.1:8790
