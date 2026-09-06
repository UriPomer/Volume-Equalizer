# Volume Equalizer 架构

权威行为与参数见 [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md)。

## 数据流

媒体源先经过低频 BiquadFilter。滤波输出一支经 GainNode 进入 Worklet 输入 0，另一支进入 Worklet 输入 1 供增益前测量。浏览器按 destination 布局混音后，Worklet 在音频线程执行关联峰值保护并输出，每 100 ms 回传输入/实际输出 PCM、epoch、最小峰值保护倍率与受限帧数。

控制器处理新的音频消息，测量输入和输出，调用纯节目状态机，再把新倍率应用于未来声音。requestAnimationFrame 只刷新面板；后台照常消费音频。原有 200 ms LUFS 预算保护已移除，峰值延迟约 15 ms。

## 状态所有权

- main.ts：媒体扫描、控制器集合、当前面板绑定、全局设置。
- controller.ts：媒体身份、生命周期、消息代际、音频图及 GainNode 唯一写入边界；协调可选完整音轨分析。
- gain-control.ts：累计节目估计、启动校准、固定锚点、修正证据、一次向下重校准。输入只有实时测量和设置，不访问页面或网络。
- program-loudness.ts：固定空间、按时长加权的上 40% 线性能量直方图；输入估计与输出诊断各持有独立实例。
- loudness-meter.ts / k-weighting.ts：400 ms、3 秒及门限积分测量，共享声道权重与滤波；非法样本污染当前窗口但不清空既有合法积分。
- public/limiter-worklet.js：关联峰值保护、有限 PCM 输出和连续遥测；不决定节目目标。
- settings.ts / ui-panel.ts：设置规范化与呈现，UI 不实现音频规则。

## 构建与验证

Vite 构建内容脚本，esbuild 构建独立 Worklet IIFE，dist 是可安装产物。单元测试及离线 PCM 基准使用同一 Worklet 源码；浏览器测试使用真实 OfflineAudioContext 和生产节点工厂验证声道布局、有限输出、延迟与动态差。基准用独立排序算法算最终输出上 40% 均值，不复用在线直方图作为自身正确性的证明。
