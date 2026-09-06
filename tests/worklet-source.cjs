const { buildSync } = require('esbuild');
const path = require('node:path');

module.exports = () => buildSync({
  entryPoints: [path.join(__dirname, '..', 'public', 'limiter-worklet.js')],
  bundle: true, write: false, format: 'iife', target: 'es2020'
}).outputFiles[0].text;
