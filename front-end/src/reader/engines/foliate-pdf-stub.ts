// foliate-js/pdf.js loads its vendored pdf.js copy through a template-literal
// `new URL('vendor/pdfjs/${path}', import.meta.url)` call. Vite rewrites that into
// `import.meta.glob('vendor/pdfjs/*')`, a bare relative pattern it then rejects, so
// importing `foliate-js/view.js` fails the production build.
//
// nasReader renders PDFs with pdfjs-dist directly (src/components/DocumentReader.vue),
// so foliate's own PDF engine is unreachable. Aliasing it to this inert module keeps
// the EPUB path (epub.js + view.js) buildable without a patched dependency.
export const makePDF = async (): Promise<never> => {
  throw new Error('nasReader 使用 pdf.js 直接渲染 PDF，foliate 的 PDF 引擎未启用');
};
