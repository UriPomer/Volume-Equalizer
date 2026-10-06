# BiliVolume

网页视频实时响度均衡扩展，默认目标 -21 LUFS。边播边测量每个媒体的门限积分响度，以较稳定的节目增益拉近不同视频的音量。

默认实时模式不下载、预分析完整音轨。目标与面板输入积分使用同一测量口径；输入在低频滤波后、节目增益前测量。面板输出显示所有已绑定媒体的页面混音。

开始播放时保守校准；稳定后普通增益相对首次稳定锚点最多偏离 ±0.1x，全程跨度不超过 0.2x。静音不升压、切换标签不重置、换视频不继承前一个视频的倍率。所有媒体先混音，再经过唯一的峰值和响度保护，400 ms 与 3 秒输出窗口不超过目标 +2 LU。保护可进一步降低实际增益，因此高动态内容的输出积分可能低于目标。准确规则见 [PRODUCT_BEHAVIOR.md](PRODUCT_BEHAVIOR.md)，模块关系见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装与开发

```powershell
npm ci
npm run build
```

在 chrome://extensions 开启开发者模式，加载已解压的 `dist/` 目录。更新后重新加载扩展并刷新视频页。不要加载仓库根目录或 public。

可选完整音轨模式保留为独立功能；流媒体默认使用实时模式。处理器尚未就绪或失败时受控媒体静音，关闭扩展可恢复原始音频。绑定被站点自身 Web Audio 占用时会明确提示；未成功绑定的媒体无法均衡。

## 隐私与权限

扩展不包含遥测、广告或第三方分析，不向开发者服务器上传音频、浏览记录或设置。实时测量和音频处理均在浏览器本地完成，设置仅保存在 `chrome.storage.local`。

扩展请求所有 HTTP/HTTPS 页面的访问权限，是为了发现并处理网页中的 `video` 和 `audio` 元素。可选的完整音轨模式会在用户开始播放后获取当前媒体地址；仅当媒体与页面同源时携带该网站的现有凭据，跨域请求不携带凭据。下载的内容只在本地解码和测量，不转发给第三方。

## 验证

```powershell
npx tsc --noEmit
npm run test:unit
npm run test:audio:download
npm run test:audio:enforce
npm run test:browser
npm run test:realtime
```

基准验收实际输出积分、输出历史最大响度和普通增益完整跨度，并单列安全保护造成的变化。真实媒体 E2E 验证校准、seek、设置和双媒体混音，保存输出 WAV、独立测量、原生音频图与截图。极端峰值素材单列诊断。复现方式见 [tests/AUDIO_BENCHMARK.md](tests/AUDIO_BENCHMARK.md)。

## 打包

保持 package、锁文件与 public/manifest.json 版本一致，运行 `npm run pack` 生成本地 ZIP。解压后加载其中目录。本地构建不等于 GitHub 发布；确认发布时再推送对应 tag，由 Actions 创建 Release。

## License

[MIT](LICENSE)
