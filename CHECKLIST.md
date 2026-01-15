# ✅ 重构验证清单

## 📦 文件完整性检查

- [x] `manifest.json` - Chrome 扩展配置
- [x] `content.js` - 打包后的文件（29.08 KB）
- [x] `build.js` - 构建脚本
- [x] `package.json` - npm 配置
- [x] `.gitignore` - Git 忽略文件
- [x] `README.md` - 项目说明
- [x] `DEVELOPMENT.md` - 开发指南
- [x] `REFACTOR_SUMMARY.md` - 重构总结
- [x] `src/` 目录
  - [x] `main.js` - 入口文件
  - [x] `config.js` - 配置
  - [x] `settings.js` - 设置管理
  - [x] `audio-context.js` - AudioContext 管理
  - [x] `pid-controller.js` - PID 算法
  - [x] `controller.js` - 音频控制器
  - [x] `media-scanner.js` - 媒体扫描
  - [x] `ui-panel.js` - UI 面板
  - [x] `lufs-calculator.js` - LUFS 计算

## 🔧 功能验证

### 1. 构建测试
```bash
cd e:/BiliVolume
node build.js
```
- [x] 构建成功
- [x] 生成 `content.js`
- [x] 文件大小正常（约 29 KB）

### 2. Chrome 扩展加载
- [ ] 打开 `chrome://extensions/`
- [ ] 启用"开发者模式"
- [ ] 点击"加载已解压的扩展程序"
- [ ] 选择 `e:/BiliVolume` 目录
- [ ] 扩展加载成功，无错误

### 3. 功能测试

#### 基础功能
- [ ] 打开 B站视频页面
- [ ] 右下角显示"音量均衡"面板
- [ ] 面板显示原始响度和输出响度
- [ ] 开关按钮可以切换"已开启"/"已关闭"

#### 响度控制
- [ ] 播放安静的视频，增益 > 1.0x
- [ ] 播放吵闹的视频，增益 < 1.0x
- [ ] 积分响度在 10 秒内收敛
- [ ] 输出响度稳定在 -15 LUFS ±1 dB

#### 设置调整
- [ ] 调整"目标响度"滑块，积分历史重置
- [ ] 调整"增益上限"，增益被限制
- [ ] 调整"增益下限"，增益被限制
- [ ] 调整"低频增益"，低频变化

#### 边界情况
- [ ] 视频跳转（seek），积分历史重置
- [ ] 切换视频，新视频正确处理
- [ ] 关闭功能，增益恢复 1.0x
- [ ] 重新开启，增益重新调整

## 🐛 问题排查

如果出现问题，按以下步骤排查：

### 问题 1：扩展加载失败
```bash
# 检查 manifest.json 语法
cat manifest.json | jq .

# 检查 content.js 是否生成
ls -lh content.js
```

### 问题 2：面板不显示
- 打开浏览器控制台（F12）
- 查看是否有 JavaScript 错误
- 检查是否有 video/audio 元素

### 问题 3：响度不正常
- 在控制台输入：
```javascript
// 检查设置
chrome.storage.local.get(null, console.log);

// 检查控制器
document.querySelectorAll('video, audio').forEach(el => 
  console.log(el, el.dataset.universalVolumeEqAttached)
);
```

## 📝 开发测试

### 修改并测试
```bash
# 1. 启动 watch 模式
npm run watch

# 2. 修改 src/config.js
# 改变 PID 参数或目标响度

# 3. 观察终端，确认自动构建

# 4. 在 Chrome 扩展页面点击"重新加载"

# 5. 刷新测试页面，验证修改生效
```

## 🎯 性能测试

### 内存占用
- [ ] 打开任务管理器
- [ ] 查看扩展内存占用 < 50 MB
- [ ] 长时间运行（30分钟）无内存泄漏

### CPU 占用
- [ ] 播放视频时 CPU 占用 < 5%
- [ ] 多个视频同时播放，性能正常

## ✅ 最终验证

- [ ] 所有功能与重构前一致
- [ ] 无性能下降
- [ ] 代码结构清晰
- [ ] 文档完整
- [ ] 可以正常开发和维护

---

## 🎉 完成！

如果所有项目都已勾选，说明重构成功！

**接下来可以：**
1. 提交到 Git
2. 发布新版本
3. 开始模块化开发
