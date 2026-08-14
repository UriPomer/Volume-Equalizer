# BiliVolume

Chrome 音量均衡扩展，目标响度默认 `-21 LUFS`。

## 工作模式

- 实时：前 10 秒校准，之后限制在校准 gain 的 `±0.2x` 与 `±0.75 dB` 交集内，且任意方向变化不超过 `0.1x/分钟`；seek 与切换标签页不会触发重新校准，播放中 gain 几乎恒定。
- 完整音轨：可选拉取并分析整段音轨（仅在媒体开始播放后拉取），成功后全程使用一个固定 gain。
- 峰值保护：末端 true-peak lookahead limiter；不会在 gain 前压缩节目动态。5.1/7.1 多声道按原声道数独立限峰，不降混为立体声。

完整音轨分析失败或长度不完整时，面板会明确显示状态并继续实时算法。页面 Console 可用 `[Universal Volume EQ]` 过滤诊断信息。
Worklet 尚未就绪或运行失败时，扩展会保持安全 gain，不使用不连续快照继续抬升音量。
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
npm run build
```

音频基准以 FFmpeg whole-program `loudnorm` 测量为离线参考，目标为 `-21 LUFS`。正式素材必须满足：实际输出在目标 `±1.5 LU` 内（稳定优先：稳态 gain 变化 ≤ 0.1x/分钟），且第 10 秒后 gain 的 `P95–P5 ≤ 1.5 dB`、最大跨度 `≤ 3 dB`。

详细说明见 [`tests/AUDIO_BENCHMARK.md`](tests/AUDIO_BENCHMARK.md)。

## 发布

更新 `public/manifest.json` 与 `package.json` 版本，完成全部验证后推送同名 tag：

```powershell
git tag v0.6.0
git push origin main v0.6.0
```

GitHub Actions 会构建 ZIP 并创建 Release。

## License

MIT
