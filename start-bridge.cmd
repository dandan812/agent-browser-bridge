@echo off
cd /d "%~dp0"
node src\bridge.mjs
if errorlevel 1 pause
