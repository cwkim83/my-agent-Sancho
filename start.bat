@echo off
cd /d "%~dp0"
rem supervisor.js starts server.js and watches it (auto-rollback to last-good, stops after 3 failures)
start "Sancho server" cmd /k node supervisor.js
timeout /t 2 /nobreak >nul
start http://127.0.0.1:8790
