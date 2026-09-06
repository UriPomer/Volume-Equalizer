# BiliVolume

Chrome 音量均衡扩展，目标响度默认 `-21 LUFS`。

## 工作模式

- 实时：前 10 秒校准节目增益，随后缓慢调节；静音不升压，seek 和切换标签不会重新快速校准。
- 完整音轨：播放后拉取完整音轨，分析成功后以固定节目增益为目标。
- 输出保护：两种模式均在低频增强和峰值限幅后执行响度保护，前台与后台持续生效。缓冲 100 ms 音频并用后续 100 ms 分摊计算，限制最终输出的 400 ms 瞬时响度不超过目标 `+2 LU`；另有约 15 ms 峰值预读，总音频延迟约 215 ms。
- 多声道：保护前按浏览器输出布局混音（默认立体声），保留左右差异；避免保护后声道复制再次增加响度。

完整音轨分析失败或长度不完整时，面板会明确显示状态并继续实时算法。页面 Console 可用 `[Universal Volume EQ]` 过滤诊断信息。
扩展开启但 Worklet 尚未就绪或运行失败时，受控媒体静音，面板显示保护不可用；关闭扩展可恢复原始音频。修改目标时会重新缓冲，已经播放的旧窗口不能追溯改变，新目标在旧的 400 ms 输出窗口退出后验收。
媒体元素已被站点自身 Web Audio 占用时（如 YouTube），面板会显示“媒体被页面占用”，并在该元素播放时自动重试绑定。

行为契约见 [`PRODUCT_BEHAVIOR.md`](PRODUCT_BEHAVIOR.md)，系统流程见
[`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 开发

```powershell
npm ci
npm run build
```

在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，加载 `dist/` 目录。

不要加载仓库根目录；`public/` 是静态资源源目录，`dist/` 是唯一可运行构建产物。

## 验证

```powershell
npm run test:unit
npm run test:audio:download
npm run test:audio:benchmark
npm run test:audio:enforce
npm run test:browser
```

音频基准使用 FFmpeg 离线参考，按真实“先输出、后测量”顺序执行。验收包含实际输出最大瞬时响度、节目响度与增益稳定性，以及完整音轨测量误差。安全衰减不受普通增益下限和稳定走廊限制。

硬响度上限优先，节目平均响度可能低于目标。基准保留原目标偏差，节目校准精度与经过相同保护的固定增益参考比较。浏览器测试使用独立临时配置运行 Chrome，覆盖单声道、立体声及 5.1 到播放布局的混音；找不到 Chrome 时可设置 `CHROME_PATH`。

详细说明见 [`tests/AUDIO_BENCHMARK.md`](tests/AUDIO_BENCHMARK.md)。

## 发布

保持 `public/manifest.json`、`package.json` 与锁文件版本一致，完成验证后生成本地 ZIP：

```powershell
npm run pack
```

安装时解压 ZIP，在扩展管理页加载该目录。已有安装需要重新加载扩展并刷新媒体页面。发布到 GitHub 时使用与版本一致的 tag，Actions 构建 ZIP 并创建 Release。

## License

MIT
