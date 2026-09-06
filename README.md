# BiliVolume

网页视频实时响度均衡扩展，默认目标 -21 LUFS。适用于 B 站等视频响度差异较大的播放场景：边播边估计每个视频的响段平均响度，以较稳定的整段增益拉近视频之间的音量，保留对白、音乐与爆点的相对动态。

默认实时模式不下载、预分析完整音轨。面板的“响段均值”指当前视频已播放有效窗口中，最响 40% 的线性能量均值；“积分响度”是另一项测量，不要求两者同时等于目标。

开始播放时保守校准，稳定后只在固定宽度不超过 0.5x 的区间内微调。静音不升压、切换标签不重置、换视频不继承前一个视频的放大倍率。末端保留约 15 ms 峰值削波保护，不再以瞬时 LUFS 上限压平正常动态。准确规则与限制见 [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md)，模块关系见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装与开发

```powershell
npm ci
npm run build
```

在 chrome://extensions 开启开发者模式，加载已解压的 `dist/` 目录。更新后重新加载扩展并刷新视频页。不要加载仓库根目录或 public。

可选完整音轨模式保留为独立功能；流媒体默认使用实时模式。处理器尚未就绪或失败时受控媒体静音，关闭扩展可恢复原始音频。绑定被站点自身 Web Audio 占用时会明确提示；未成功绑定的媒体无法均衡。

## 验证

```powershell
npx tsc --noEmit
npm run test:unit
npm run test:audio:download
npm run test:audio:enforce
npm run test:browser
```

基准实际渲染音频，直接验收输出响段均值距目标不超过 ±1.5 LU、首次稳定后中间 99% 有效倍率跨度不超过 0.5x，并报告削波比例。人工放大的极端峰值素材单列诊断，不冒充通过。数据口径与复现方式见 [tests/AUDIO_BENCHMARK.md](tests/AUDIO_BENCHMARK.md)。

## 打包

保持 package、锁文件与 public/manifest.json 版本一致，运行 `npm run pack` 生成本地 ZIP。解压后加载其中目录。本地构建不等于 GitHub 发布；确认发布时再推送对应 tag，由 Actions 创建 Release。

## License

MIT
