# BiliVolume

Chrome 音量均衡扩展，目标响度默认 `-21 LUFS`。

## 工作模式

- 实时：前 10 秒校准，之后 gain 限制在固定 `0.2x` 走廊内。
- 完整音轨：可选拉取并分析整段音轨，成功后全程使用一个固定 gain。
- 峰值保护：末端 true-peak lookahead limiter；不会在 gain 前压缩节目动态。

完整音轨分析失败或长度不完整时，面板会明确显示状态并继续实时算法。页面 Console 可用 `[Universal Volume EQ]` 过滤诊断信息。

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
npm run build
```

音频基准以 FFmpeg whole-program `loudnorm` 测量为离线参考，目标为 `-21 LUFS`。主要通过标准：视频第 10 秒到结束，实时 gain 系数总范围不超过 `0.2x`。

详细说明见 [`tests/AUDIO_BENCHMARK.md`](tests/AUDIO_BENCHMARK.md)。

## 发布

更新 `public/manifest.json` 版本，提交后推送同名 tag：

```powershell
git tag v0.4.4
git push origin main v0.4.4
```

GitHub Actions 会构建 ZIP 并创建 Release。

## License

MIT
