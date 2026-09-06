# Volume Equalizer 架构

权威行为定义见 [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md)。

## 音频与控制链

媒体源经节目 GainNode、低频 BiquadFilter 后进入 AudioWorklet。
Worklet 的输入/输出显式匹配 destination 声道数，浏览器先按 speakers 布局混音再保护，
防止保护之后的单声道复制增加响度。
Worklet 先执行关联峰值限幅，再执行 LoudnessSafety，最后把实际输出送到 destination。
原始信号通过 Worklet 的第二输入独立采集，用于节目响度测量。
原始及实际输出 PCM 每 100 ms 以带 epoch 的消息送回控制器。

节目 AGC 在新的音频消息到达时更新；requestAnimationFrame 只负责面板刷新。
页面隐藏时冻结节目增益，但 Worklet 的输出安全保护持续执行。
处理器不可用时控制器静音受控音频，用户主动关闭扩展才旁路到原始信号。

## 职责与状态所有权

- main.ts：扫描和控制器集合、当前媒体、全局设置。
- controller.ts：生命周期、消息 epoch、音轨分析协调、节目 gain 唯一写入边界。
- gain-control.ts：纯节目增益状态机；噪声门只使用当前音频证据。
- k-weighting.ts：共享滤波系数、可复制的滤波状态和声道布局权重。
- loudness-meter.ts：400 ms 瞬时、精确 3 秒短时与门限积分测量。
- loudness-safety.ts：音频线程中的预读、最终输出滑动窗口预算和安全倍率。
- public/limiter-worklet.js：处理量子块、关联限峰、调用输出保护并发送实际 PCM。
- settings.ts/ui-panel.ts：设置规范化及单向呈现，UI 不实现响度规则。

## 构建与验证

Vite 构建内容脚本，并用 esbuild 把 Worklet 与共享 TypeScript DSP 打包为独立 IIFE。
dist 是唯一运行产物。测试和音频基准使用相同的 Worklet 源码打包方式，
按先播放当前块、再以该块测量改变未来 gain 的顺序验证输出。
