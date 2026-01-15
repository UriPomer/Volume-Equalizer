# B站音量均衡器

Chrome 扩展插件，自动将所有视频的响度标准化到 -15 LUFS（YouTube 标准）。

## 🎯 功能特性

- ✅ **自动响度均衡**：将所有视频标准化到 -15 LUFS
- ✅ **PID 控制器**：平滑调整，无震荡
- ✅ **积分响度测量**：10秒滑动窗口，符合 ITU-R BS.1770 标准
- ✅ **音质优先**：使用 DynamicsCompressor 防止失真
- ✅ **实时监控**：显示原始和输出响度
- ✅ **可调参数**：目标响度、增益范围、低频 EQ

## 📁 项目结构

```
BiliVolume/
├── manifest.json          # Chrome 扩展配置
├── content.js            # 打包后的文件（由 build.js 生成）
├── build.js              # 构建脚本
├── package.json          # npm 配置
├── README.md             # 本文档
└── src/                  # 源代码（模块化）
    ├── main.js           # 入口文件
    ├── config.js         # 配置和常量
    ├── settings.js       # 设置管理
    ├── audio-context.js  # AudioContext 管理
    ├── pid-controller.js # PID 算法
    ├── controller.js     # 音频控制器
    ├── media-scanner.js  # 媒体元素扫描
    ├── ui-panel.js       # UI 面板
    └── lufs-calculator.js # LUFS/RMS 转换工具
```

## 🔧 开发

### 安装依赖

```bash
npm install
```

### 构建

```bash
npm run build
```

这会将 `src/` 目录下的所有模块打包成单个 `content.js` 文件。

### 监听模式（开发时使用）

```bash
npm run watch
```

修改 `src/` 目录下的任何文件后会自动重新构建。

### 在 Chrome 中加载

1. 打开 Chrome 扩展页面: `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择本项目目录

## 📚 技术栈

- **Web Audio API**: createDynamicsCompressor, createGain, createBiquadFilter, createAnalyser
- **PID 控制器**: Kp=0.15, Ki=0.005, Kd=0.08
- **积分响度**: 600样本滑动窗口（约10秒@60fps）
- **LUFS 计算**: 简化版 ITU-R BS.1770（未使用 K-weighting）

## 🎛️ 信号链

```
原始音频
  ↓
DynamicsCompressor (防止削波)
  ↓
OriginalAnalyser (测量压缩后响度)
  ↓
GainNode (PID 控制的增益)
  ↓
BiquadFilter (低频 EQ)
  ↓
OutputAnalyser (测量最终输出)
  ↓
扬声器
```

## 📖 模块说明

### config.js
定义所有常量和默认设置：
- 目标响度：-15 LUFS
- 增益范围：0.5x ~ 2.0x
- PID 参数：Kp, Ki, Kd
- 积分窗口：600 样本

### lufs-calculator.js
RMS ↔ LUFS 转换工具：
- `rmsToLufs(rms)`: RMS 转 LUFS
- `lufsToRms(lufs)`: LUFS 转 RMS
- `clamp(value, min, max)`: 限制范围

### settings.js
Chrome Storage 管理：
- `loadSettings()`: 从 storage 加载设置
- `persistSettings(settings)`: 保存设置到 storage

### audio-context.js
AudioContext 生命周期管理：
- `ensureAudioContext()`: 获取或创建 AudioContext
- `installGlobalResumeHandlers()`: 自动恢复 suspended 状态

### pid-controller.js
PID 控制器实现：
- `compute(error)`: 计算 PID 输出
- `reset()`: 重置 PID 状态

### controller.js
核心音频控制器：
- 管理 Web Audio 节点
- 测量原始和输出响度
- PID 增益调整
- 积分响度计算

### media-scanner.js
媒体元素检测：
- `scanForMedia()`: 扫描页面上的 video/audio
- `observeMutations()`: 监听 DOM 变化
- `scheduleScan()`: 防抖扫描

### ui-panel.js
设置面板 UI：
- 创建 Shadow DOM 面板
- 滑块控制
- 实时响度显示
- 开关按钮

### main.js
主入口：
- 协调各模块
- 管理全局状态
- 处理设置变更

## 🚀 发布

1. 运行 `npm run build` 生成 `content.js`
2. 确保 `manifest.json` 版本号正确
3. 打包整个目录（不包括 `node_modules/` 和 `src/`）
4. 上传到 Chrome Web Store

## 📝 License

MIT
