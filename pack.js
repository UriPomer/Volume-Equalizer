const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, 'dist');

// 从 manifest.json 读取版本号
const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipName = `bili-volume-eq-v${version}.zip`;
const zipPath = path.join(__dirname, zipName);

// 使用 PowerShell 压缩 dist 目录
const psCmd = `Compress-Archive -Path "${distDir}\\*" -DestinationPath "${zipPath}" -Force`;
execSync(`powershell -Command "${psCmd}"`, { stdio: 'inherit' });

console.log(`\n✅ 打包完成: ${zipPath}`);
