import {createRequire} from 'node:module';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';

// Keep the decoders, CMaps and fallback fonts in the same release as the worker.
// Emit from the installed, locked dependency so Web, Go/Docker and Tauri all ship
// the assets without checking vendor files into the repository or requiring a CDN.
export function pdfAssetsPlugin() {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('pdfjs-dist/package.json');
  const {version} = JSON.parse(readFileSync(packagePath, 'utf8'));
  const directory = path.dirname(packagePath);
  const assets = new Map();
  for (const group of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const entry of readdirSync(path.join(directory, group), {withFileTypes: true})) {
      if (entry.isFile()) assets.set(`pdfjs/${version}/${group}/${entry.name}`, readFileSync(path.join(directory, group, entry.name)));
    }
  }
  let base = '/';
  return {
    name: 'nasreader:pdf-assets',
    configResolved(config) {base = config.base;},
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const asset = assets.get(pathname.slice(base.length));
        if (!asset) {next(); return;}
        res.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.end(asset);
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({type: 'asset', fileName, source});
    },
  };
}
