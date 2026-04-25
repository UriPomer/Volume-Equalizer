@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

:: 读取 manifest.json 中的版本号
for /f "tokens=2 delims=:," %%a in ('findstr "version" manifest.json') do (
    set "VERSION=%%a"
    set "VERSION=!VERSION:"=!"
    set "VERSION=!VERSION: =!"
    goto :got_version
)
:got_version

if "%VERSION%"=="" (
    echo 无法读取版本号，使用默认名称
    set "VERSION=unknown"
)

set "ZIP_NAME=BiliVolume-v%VERSION%.zip"

echo ========================================
echo 项目: BiliVolume
echo 版本: %VERSION%
echo 输出: %ZIP_NAME%
echo ========================================
echo.

:: 检查 dist 目录
if not exist "dist\content.js" (
    echo [错误] dist/content.js 不存在，请先运行 npm run build
    pause
    exit /b 1
)

if not exist "dist\manifest.json" (
    echo [错误] dist/manifest.json 不存在，请先运行 npm run build
    pause
    exit /b 1
)

:: 清理旧 zip
if exist "%ZIP_NAME%" (
    echo 删除旧的 %ZIP_NAME%
    del /f "%ZIP_NAME%"
)

:: 使用 PowerShell 打包（Windows 自带，无需额外安装）
echo 正在打包...
powershell -Command "Compress-Archive -Path 'dist\*' -DestinationPath '%ZIP_NAME%' -Force"

if %errorlevel% neq 0 (
    echo [错误] 打包失败
    pause
    exit /b 1
)

echo.
echo [成功] 已生成 %ZIP_NAME%
echo 完整路径: %PROJECT_DIR%%ZIP_NAME%
pause
