# 实时节目响度基准

本基准验收边播边算的算法，不为控制器提供完整音轨。FFmpeg 只负责解码和独立测量输入积分响度；实时增益仅看已经播放的 PCM。

## 素材

源清单在 [fixtures/audio-videos.json](fixtures/audio-videos.json)，媒体下载到被忽略的 fixtures/videos。

- Sintel 原始预告片。
- Big Buck Bunny 预告片降低 12 dB。
- WAI clear layout、video captions 对白和音乐。
- clear layout 额外降低/提高 6 dB 作为电平变体，独立运行状态机。
- W3C movie_300 提高 6 dB：沿用清单中的极高峰值诊断分类，始终输出全部结果，不纳入普通素材通过率；未满足响度和稳定性也不得宣称通过。

## 运行

```powershell
npm run test:audio:download
npm run test:audio:enforce
npm run test:browser
```

普通报告模式 `npm run test:audio:benchmark` 不因指标失败返回非零；CI 使用 enforce。设置 CHROME_PATH 可指定浏览器。详细 100 ms 轨迹由 `npm run test:audio:trace` 生成；单素材诊断使用 `node scripts/audio-benchmark.mjs --fixture video-captions --trace`。

结果写入 test-results/audio-benchmark.json 和 .md。单素材运行会覆盖报告，正式验收必须重新运行无 fixture 过滤的 enforce。

## 时序与指标

每块 100 ms PCM 使用上一块决定的倍率渲染，经生产峰值 Worklet 后测量实际输出，再更新下一块倍率。尾部补 0.5 秒静音排空延迟，仅算入输出测量。

独立排序全部有效 400 ms 窗口（步长 100 ms、> -60 LUFS），按时间取最高 40%，在线性能量域求均值，再转回 LUFS。整个校准期包括在实际输出响段均值中。此指标不同于 BS.1770 积分响度，报告同时保留两者。

每个普通素材必须满足：

- 输入积分与 FFmpeg 偏差 ≤0.5 LU。
- 实际输出上 40% 均值距 -21 LUFS ≤1.5 LU。
- 进入稳定态；首次稳定后的有效倍率 P99.5−P0.5 ≤0.5x。
- 首次稳定后峰值保护介入的实际音频帧比例 ≤1%。

普通素材输出均值最大差额不得超过 3 LU。有效倍率按每个 100 ms 消息的节目倍率乘最小峰值保护倍率估算，保守反映块内削波；报告另列完整跨度、首次稳定时间和重校准次数，重校准不会重置统计起点。固定区间主要约束节目倍率，无法将削波变化隐藏在区间之外。

测试结果只证明这些输入与默认设置；不能外推成所有视频的 99% 成功概率。用户设置限幅、短片、长期无代表性片头及高峰均比音轨都需要单独解释。浏览器 PCM 渲染测试不等于已完成 B 站线上长期试听。
