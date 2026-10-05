@echo off
setlocal

rem ============================================
rem TraeWork auto checkin - entry point
rem Uses system Node.js first; falls back to
rem Trae's built-in Electron Node runtime.
rem ============================================

set "SCRIPT=%~dp0checkin.js"

rem Optional: set TRAE_EXE to force a specific Trae executable.
if defined TRAE_EXE goto run_trae

where node >nul 2>nul
if %errorlevel%==0 goto run_node

call :probe_trae
if not defined TRAE_EXE (
  echo ERROR: Node.js not found and Trae executable not found.
  echo Install Node.js, or set TRAE_EXE inside this file.
  exit /b 2
)

:run_trae
set "ELECTRON_RUN_AS_NODE=1"
set "VSCODE_DEV="
"%TRAE_EXE%" "%SCRIPT%" %*
exit /b %errorlevel%

:run_node
node "%SCRIPT%" %*
exit /b %errorlevel%

:probe_trae
if exist "%LOCALAPPDATA%\Programs\Trae CN\Trae CN.exe" set "TRAE_EXE=%LOCALAPPDATA%\Programs\Trae CN\Trae CN.exe"
if defined TRAE_EXE goto :eof
if exist "%LOCALAPPDATA%\Programs\TRAE SOLO CN\TRAE SOLO CN.exe" set "TRAE_EXE=%LOCALAPPDATA%\Programs\TRAE SOLO CN\TRAE SOLO CN.exe"
if defined TRAE_EXE goto :eof
if exist "%LOCALAPPDATA%\Programs\Trae\Trae.exe" set "TRAE_EXE=%LOCALAPPDATA%\Programs\Trae\Trae.exe"
if defined TRAE_EXE goto :eof
if exist "D:\Trae CN\Trae CN.exe" set "TRAE_EXE=D:\Trae CN\Trae CN.exe"
if defined TRAE_EXE goto :eof
if exist "D:\Trae CN\TRAE SOLO CN\TRAE SOLO CN.exe" set "TRAE_EXE=D:\Trae CN\TRAE SOLO CN\TRAE SOLO CN.exe"
goto :eof
