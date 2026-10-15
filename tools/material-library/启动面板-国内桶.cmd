@echo off
rem ---------------------------------------------------------------------------
rem Phonecase material panel launcher (CN bucket) - Windows cmd
rem Why WMI: a panel started as a child of a shell/agent process tree gets torn
rem down when that tree ends (observed twice on 2026-10-14). Win32_Process.Create
rem starts it under the WMI host instead, so it survives.
rem Usage: double-click this file, then open http://127.0.0.1:8792
rem ---------------------------------------------------------------------------
setlocal
cd /d D:\Codex-local\harness-workspaces\Phonecase
powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c set PHONECASE_OSS_BUCKET=phonecase-media-cn&& set PHONECASE_OSS_REGION=oss-cn-beijing&& node tools/material-library/panel-sqlite.mjs --serve --port 8792 >> outputs\product-material-library-phase1-20261006\evidence\panel-cn-detached.out.log 2>&1'; CurrentDirectory='D:\Codex-local\harness-workspaces\Phonecase'}"
echo.
echo Panel start requested. Open http://127.0.0.1:8792 in a few seconds.
echo Data bucket: phonecase-media-cn (oss-cn-beijing)
echo Log: outputs\product-material-library-phase1-20261006\evidence\panel-cn-detached.out.log
echo.
pause
