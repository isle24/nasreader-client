import { defineConfig } from 'vite'; import vue from '@vitejs/plugin-vue';
import {fileURLToPath} from 'node:url';
import {pdfAssetsPlugin} from './pdfAssets.mjs';
// foliate-js/pdf.js resolves its vendored pdf.js copy with a template-literal
// `new URL('vendor/pdfjs/${path}', import.meta.url)`. Vite rewrites that into
// `import.meta.glob('vendor/pdfjs/*')`, a bare pattern it rejects, so importing
// `foliate-js/view.js` aborts the production build. nasReader renders PDFs with
// pdfjs-dist directly (src/components/DocumentReader.vue) and only needs foliate for
// EPUB, so foliate's own PDF engine is resolved to an inert stub instead. Its vendor
// directory therefore never needs to exist, which also covers the glob pattern itself.
const foliatePDFStub = fileURLToPath(new URL('./src/reader/engines/foliate-pdf-stub.ts', import.meta.url));
const foliatePDFStubPlugin = {
  name: 'nasreader:foliate-pdf-stub',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    const fromFoliate = importer ? /\/foliate-js\/pdf\.js$/.test(importer) : false;
    const isFoliatePDF = source === 'foliate-js/pdf.js' || (fromFoliate && source === './pdf.js');
    return isFoliatePDF || source.startsWith('vendor/pdfjs/') ? foliatePDFStub : null;
  },
};
// Dev/preview API target. Defaults to the documented local service; override with
// NASREADER_API when testing against another instance (e.g. an isolated smoke-test
// server) without editing this file. Read through globalThis so the config does not
// need Node type definitions in tsconfig.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const apiTarget = env?.NASREADER_API ?? 'http://127.0.0.1:18080';
export default defineConfig({
  plugins: [foliatePDFStubPlugin, pdfAssetsPlugin(), vue()],
  server: { proxy: { '/api': apiTarget, '/health': apiTarget } },
  preview: { proxy: { '/api': apiTarget, '/health': apiTarget } },
  build: { target: 'es2022' },
});
