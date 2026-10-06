# 实时积分响度基准

实时算法只读取已播放 PCM，FFmpeg 用于解码及独立测量。素材清单见 [fixtures/audio-videos.json](fixtures/audio-videos.json)，下载内容位于被忽略的 `fixtures/videos`。普通素材包含 Sintel、降低 12 dB 的 Big Buck Bunny、WAI clear layout / video captions，以及 clear layout 的 ±6 dB 变体。movie_300 提高 6 dB 沿用极高峰值诊断分类，完整报告结果，不纳入普通素材通过率。

## 复现

```powershell
npm run test:audio:download
npm run test:audio:enforce
npm run test:browser
npm run test:realtime
```

CI 使用 enforce；普通 `test:audio:benchmark` 报告失败但不返回非零。`test:audio:trace` 生成 100 ms 轨迹。单素材使用 `node scripts/audio-benchmark.mjs --fixture video-captions --trace`，会覆盖报告；正式验收应重新运行无过滤的 enforce。基准报告位于 `test-results/audio-benchmark.json` 和 `.md`。

## 基准验收

每 100 ms 使用上一块决定的倍率，经生产峰值与响度 Worklet 渲染后测量，再更新下一块普通增益。输出尾部补 0.5 秒静音排空延迟，校准期包含在输出积分中。

- 输入门限积分与 FFmpeg 偏差 ≤0.5 LU。
- 所有素材的最终 400 ms / 3 秒历史最大响度 ≤目标 +2 LU。
- 普通素材进入稳定态；首次稳定后的普通增益完整跨度 ≤0.2x，相对首次锚点最大偏离 ≤0.1x。
- 首次稳定后的峰值保护帧比例 ≤1%；响度保护介入比例单独报告。
- 输出积分距目标 ≤1.5 LU；如果目标与响度硬上限冲突，输出需低于目标且不低于独立可行固定增益的输出积分 -1.5 LU。可行增益由独立输入积分、最大 400 ms / 3 秒窗口与用户倍率上限计算，不使用在线控制器的输出反推验收目标。

报告同时保留实际有效倍率的百分位与完整跨度。普通增益稳定约束不适用于安全保护造成的倍率变化。普通素材中未触发响度约束的输出积分差额不得超过 3 LU，全部普通素材的输出差额另行报告；素材动态差异可能使硬上限与统一积分目标无法同时满足。

## 浏览器 E2E 与产物

`test:browser` 使用真实 OfflineAudioContext，验证不同采样率和声道布局、响段、目标下降、峰值、非法 PCM、尾部和不受限时的动态差。

`test:realtime` 使用真实媒体、构建内容脚本、原生 Worklet、控制器和面板。覆盖固定锚点、seek、周期性高动态校准、低于目标输入放大、静音、用户倍率边界、目标变更，以及两个同时播放媒体的总输出。多个媒体时修改目标、移除其中一个后，仍需满足上限并保持发声；全部移除后原生音频图连接数为零。

产物默认保存到系统临时目录，可用 `VOLUME_EQ_ARTIFACT_ROOT` 指定位置、`CHROME_PATH` 指定浏览器。报告保存命令、提交、构建和输入 SHA-256、原生 GainNode 调度、音频图事件、检查点、独立 FFmpeg 测量与截图；双媒体及移除场景另存最终输出 WAV，便于重测和试听。

这些检查证明指定输入与设置的行为，不能外推为所有网页的成功概率；浏览器渲染通过不等于完成 B 站长期试听。
