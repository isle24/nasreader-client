import {version} from 'pdfjs-dist';

export function pdfAssetOptions() {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/${version}/`, document.baseURI);
  return {
    cMapUrl: new URL('cmaps/', base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
    wasmUrl: new URL('wasm/', base).href,
    iccUrl: new URL('iccs/', base).href,
  };
}
