@echo off
rem Opens the CULT site on sample data. Close this window to stop it.
cd /d "%~dp0"
start "" cmd /c "timeout /t 6 >nul & start http://127.0.0.1:8811/"
node node_modules\wrangler\bin\wrangler.js dev --port 8811 --var DEMO:1
