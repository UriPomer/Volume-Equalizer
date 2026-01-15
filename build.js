/**
 * 简单的打包脚本 - 合并所有模块到 content.js
 * 使用 Node.js 运行: node build.js
 */

const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const outputFile = path.join(__dirname, 'content.js');

// 读取所有源文件
const files = [
  'config.js',
  'lufs-calculator.js',
  'settings.js',
  'audio-context.js',
  'pid-controller.js',
  'controller.js',
  'media-scanner.js',
  'ui-panel.js',
  'main.js'
];

console.log('🔨 开始构建...');

let bundleContent = '(() => {\n';
bundleContent += '  "use strict";\n\n';

// 处理每个文件
files.forEach((file, index) => {
  console.log(`📦 处理: ${file}`);
  const filePath = path.join(srcDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // 移除 import/export 语句
  content = content
    .replace(/^import\s+.*?from\s+['"].*?['"];?\s*$/gm, '')
    .replace(/^export\s+/gm, '  ')
    .replace(/^export\s+default\s+/gm, '  const _default_export = ');

  // 添加注释分隔符
  bundleContent += `  // ===== ${file} =====\n`;
  bundleContent += content;
  bundleContent += '\n\n';
});

bundleContent += '})();\n';

// 写入输出文件
fs.writeFileSync(outputFile, bundleContent, 'utf8');

console.log(`✅ 构建完成: ${outputFile}`);
console.log(`📊 文件大小: ${(fs.statSync(outputFile).size / 1024).toFixed(2)} KB`);
