# Chrome扩展私钥生成脚本
# 使用方法：在PowerShell中运行此脚本

Write-Host "=== Chrome扩展私钥生成工具 ===" -ForegroundColor Cyan

# 查找Chrome安装路径
$chromePaths = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LocalAppData}\Google\Chrome\Application\chrome.exe"
)

$chromePath = $null
foreach ($path in $chromePaths) {
    if (Test-Path $path) {
        $chromePath = $path
        break
    }
}

if (-not $chromePath) {
    Write-Host "错误: 未找到Chrome浏览器" -ForegroundColor Red
    Write-Host "请确保已安装Chrome浏览器" -ForegroundColor Yellow
    exit 1
}

Write-Host "找到Chrome: $chromePath" -ForegroundColor Green

# 获取当前目录
$extensionDir = $PSScriptRoot
$pemFile = Join-Path $extensionDir "key.pem"
$crxFile = Join-Path $extensionDir "extension.crx"

Write-Host "扩展目录: $extensionDir" -ForegroundColor Green

# 如果已存在私钥文件
if (Test-Path $pemFile) {
    Write-Host "警告: 私钥文件已存在 (key.pem)" -ForegroundColor Yellow
    $confirm = Read-Host "是否覆盖? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "操作已取消" -ForegroundColor Yellow
        exit 0
    }
    Remove-Item $pemFile -Force
}

# 打包扩展（会生成.pem文件）
Write-Host "`n正在生成私钥文件..." -ForegroundColor Cyan

try {
    & $chromePath --pack-extension="$extensionDir" 2>&1 | Out-Null
    
    # Chrome会在父目录生成文件
    $parentDir = Split-Path $extensionDir -Parent
    $parentPem = Join-Path $parentDir "BiliVolume.pem"
    $parentCrx = Join-Path $parentDir "BiliVolume.crx"
    
    # 移动文件到项目目录
    if (Test-Path $parentPem) {
        Move-Item $parentPem $pemFile -Force
        Write-Host "✓ 私钥文件已生成: key.pem" -ForegroundColor Green
    }
    
    if (Test-Path $parentCrx) {
        Move-Item $parentCrx $crxFile -Force
        Write-Host "✓ 安装包已生成: extension.crx" -ForegroundColor Green
    }
    
    if (-not (Test-Path $pemFile)) {
        Write-Host "错误: 私钥文件生成失败" -ForegroundColor Red
        Write-Host "请尝试手动打包:" -ForegroundColor Yellow
        Write-Host "1. 打开 chrome://extensions/" -ForegroundColor Yellow
        Write-Host "2. 启用'开发者模式'" -ForegroundColor Yellow
        Write-Host "3. 点击'打包扩展程序'" -ForegroundColor Yellow
        Write-Host "4. 选择扩展根目录: $extensionDir" -ForegroundColor Yellow
        exit 1
    }
    
    Write-Host "`n=== 生成成功 ===" -ForegroundColor Green
    Write-Host "私钥文件: $pemFile" -ForegroundColor Cyan
    Write-Host "安装包: $crxFile" -ForegroundColor Cyan
    Write-Host "`n⚠️  重要提示:" -ForegroundColor Yellow
    Write-Host "1. 请妥善保管 key.pem 文件，丢失后无法恢复" -ForegroundColor Yellow
    Write-Host "2. 不要将私钥文件提交到Git仓库" -ForegroundColor Yellow
    Write-Host "3. 更新扩展时必须使用同一个私钥文件" -ForegroundColor Yellow
    
} catch {
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host "`n请尝试手动方式:" -ForegroundColor Yellow
    Write-Host "1. 打开Chrome浏览器" -ForegroundColor Yellow
    Write-Host "2. 访问 chrome://extensions/" -ForegroundColor Yellow
    Write-Host "3. 启用右上角的'开发者模式'" -ForegroundColor Yellow
    Write-Host "4. 点击'打包扩展程序'" -ForegroundColor Yellow
    Write-Host "5. 扩展根目录选择: $extensionDir" -ForegroundColor Yellow
    Write-Host "6. 私钥文件留空（首次打包）" -ForegroundColor Yellow
    exit 1
}
