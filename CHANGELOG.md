# 更新日志

## [2.0.0] - 2026-01-15

### 🎉 重构版本 - 模块化架构

#### ✨ 新增
- **模块化代码结构**：将单文件拆分为 9 个模块
- **构建系统**：添加 `build.js` 构建脚本
- **开发工具**：支持 `npm run watch` 监听模式
- **文档完善**：
  - `README.md` - 项目说明
  - `DEVELOPMENT.md` - 开发指南
  - `REFACTOR_SUMMARY.md` - 重构总结
  - `CHECKLIST.md` - 验证清单
  - `CHANGELOG.md` - 本文档

#### 🔄 重构
- **config.js**：统一管理所有配置常量
- **lufs-calculator.js**：LUFS/RMS 转换工具函数
- **settings.js**：Chrome Storage 管理
- **audio-context.js**：AudioContext 生命周期管理
- **pid-controller.js**：PID 算法独立封装
- **controller.js**：核心音频控制器（330行）
- **media-scanner.js**：媒体元素扫描和监听
- **ui-panel.js**：UI 面板渲染和事件处理
- **main.js**：主入口，协调各模块

#### 📈 改进
- **可维护性**：模块职责单一，易于定位和修改
- **可读性**：清晰的模块边界和命名
- **可测试性**：纯函数和类可以单独测试
- **可扩展性**：新功能可以独立模块开发
- **开发体验**：支持热重载，修改代码更快

#### 🔧 技术细节
- 所有功能保持不变
- 性能无下降
- Chrome Storage 格式兼容
- manifest.json 无变化

---

## [1.0.0] - 2026-01-10

### 🎯 初始版本

#### ✨ 功能
- **自动响度均衡**：将所有视频标准化到 -15 LUFS
- **PID 控制器**：平滑增益调整，无震荡
- **积分响度测量**：10秒滑动窗口
- **DynamicsCompressor**：防止削波失真
- **实时监控面板**：显示原始和输出响度
- **可调参数**：
  - 目标响度：-23 ~ -10 LUFS
  - 增益上限：1.0 ~ 3.0x
  - 增益下限：0.2 ~ 1.0x
  - 低频增益：-6 ~ +6 dB

#### 🔧 技术栈
- Web Audio API
  - createDynamicsCompressor
  - createGain
  - createBiquadFilter
  - createAnalyser
- PID 控制器（Kp=0.15, Ki=0.005, Kd=0.08）
- 积分响度（600样本滑动窗口）
- Shadow DOM（UI 隔离）

#### 📊 性能
- 内存占用：< 30 MB
- CPU 占用：< 5%
- 延迟：< 10ms

---

## 版本规范

遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)

- **主版本号**：不兼容的 API 修改
- **次版本号**：向下兼容的功能性新增
- **修订号**：向下兼容的问题修正

### 更新类型标签
- ✨ **新增** - 新功能
- 🔄 **重构** - 代码重构
- 🐛 **修复** - Bug 修复
- 📈 **改进** - 性能优化、体验提升
- 🔧 **技术** - 技术细节变更
- 📝 **文档** - 文档更新
- 🎨 **样式** - UI/UX 改进
- ⚠️ **破坏性变更** - 不兼容的修改
