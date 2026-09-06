import { defineConfig } from 'vite';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let outputDirectory = 'dist';

export default defineConfig({
  plugins: [{
    name: 'bundle-audio-worklet',
    configResolved(config) { outputDirectory = config.build.outDir; },
    buildStart() {
      this.addWatchFile(resolve('public/limiter-worklet.js'));
    },
    async writeBundle() {
      await build({
        entryPoints: ['public/limiter-worklet.js'],
        outfile: resolve(outputDirectory, 'limiter-worklet.js'),
        bundle: true, format: 'iife', target: 'es2020', minify: true
      });
    }
  }],
  build: {
    lib: {
      entry: 'src/main.ts',
      name: 'BiliVolume',
      formats: ['iife'],
      fileName: () => 'content.js'
    },
    outDir: 'dist',
    emptyOutDir: true,
    // 不生成 source map（如需调试可改为 true）
    sourcemap: false,
    // 压缩代码
    minify: 'esbuild'
  },
  // public 目录下的文件会被原样复制到 dist
  publicDir: 'public'
});
