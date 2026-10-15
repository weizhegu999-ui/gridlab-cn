@echo off
setlocal
cd /d "%~dp0"
set "GRIDLAB_NODE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined GRIDLAB_NODE set "GRIDLAB_NODE=%%I"
if not defined GRIDLAB_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "GRIDLAB_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined GRIDLAB_NODE (
  echo Node.js 20+ is required. Install Node.js or run this from a terminal with node.exe in PATH.
  pause
  exit /b 1
)
"%GRIDLAB_NODE%" scripts\serve.mjs --open
if errorlevel 1 pause
endlocal
