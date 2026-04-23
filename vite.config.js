import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/main.js',
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
