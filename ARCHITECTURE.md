# Volume Equalizer 架构

权威行为与参数见 [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md)。

## 数据流与职责

每个媒体独立持有源、低频滤波、GainNode 和透明输入测量 Worklet。滤波输出一路经过 GainNode 再传向公共输出，另一路进入测量节点供增益前积分。每 100 ms 回传带 epoch 的原始 PCM；控制器测量输入、调用纯节目状态机，将倍率应用于未来声音。

同一 AudioContext 只有一个 `SharedAudioOutput`。它汇总所有媒体的节目 PCM，按 destination 布局执行峰值与响度保护，再连接 destination。公共 Worklet 回传最终输出 PCM 和保护倍率；输出测量、目标切换代际与生命周期由公共输出持有，避免逐媒体限幅后再次叠加超限。总延迟约 15 ms。

- `main.ts`：媒体扫描、控制器集合、活动媒体和全局设置。
- `controller.ts`：单个媒体的身份、生命周期、输入测量代际、音频图和 GainNode 写入；协调完整音轨分析。
- `audio-context.ts`：共享上下文、媒体源缓存、按上下文加载 Worklet 和节点工厂。
- `audio-output.ts`：公共总输出、保护状态、输出积分与历史最大值、目标代际；以媒体订阅数量决定释放。
- `gain-control.ts`：积分目标、保守校准、固定锚点与修正证据；不访问页面或网络。
- `loudness-meter.ts` / `k-weighting.ts`：400 ms、3 秒及门限积分测量、声道权重与滤波。
- `loudness-ceiling.ts`：音频线程最终 PCM 的滑动窗口响度预算，独立于普通增益。
- `public/limiter-worklet.js`：公共关联峰值保护、响度保护、有限 PCM 遥测，以及不带限幅的逐媒体输入测量节点。
- `settings.ts` / `ui-panel.ts`：设置规范化和呈现；输出明确标识为页面混音。

后台音频消息持续推进测量与普通增益；requestAnimationFrame 只更新 UI。任一媒体的换源或 seek 不清空其他媒体的总输出历史；全局目标变更统一清空输出统计，并把新的消息 epoch 与音频参数生效时点关联，避免旧目标样本进入新的历史最大值。公共处理器失败时所有订阅媒体静音；最后一个媒体移除时释放公共连接和消息处理。

## 构建与验证

Vite 构建内容脚本，esbuild 构建独立 Worklet，`dist` 为可安装产物。离线基准使用生产状态机和 Worklet，独立计算可行固定增益，报告实际输出积分与保护比例。浏览器渲染验证声道布局、连续窗口上限、峰值和尾部。

真实媒体 E2E 使用构建产物、原生 HTMLAudioElement 和 AudioContext。测试适配扩展存储与资源 URL，旁路观察原生 GainNode 调度，并向原生 destination 的源节点添加并行录音分支，生产音频连接保持原样。录音块携带顺序号，按序保存 WAV 后用 FFmpeg 独立测量总输出，并补充生产测量器的 1 ms 密集滑窗检查；原生 WebAudio 事件用于检查连接释放。
