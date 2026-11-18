@echo off
rem Keeps the sticker helper running: starts it, and if it ever stops
rem (crash, network hiccup at boot) waits 10 s and starts it again.
rem Started hidden at login by start-helper.vbs (see setup.ps1).
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>&1 || set "NODE=%ProgramFiles%\nodejs\node.exe"
:loop
"%NODE%" server.js > helper.log 2>&1
timeout /t 10 /nobreak >nul
goto loop
