// WebKit can fail a single read of a large Blob with an I/O error even though
// its smaller slices are readable. Keep each temporary read bounded; PDF.js then
// transfers the assembled buffer to its worker without a second full-size copy.
export async function pdfBlobBytes(file: Blob): Promise<Uint8Array> {
  const chunkSize = 4 * 1024 * 1024;
  if (file.size <= chunkSize) return new Uint8Array(await file.arrayBuffer());
  const bytes = new Uint8Array(file.size);
  for (let start = 0; start < file.size; start += chunkSize) {
    bytes.set(new Uint8Array(await file.slice(start, start + chunkSize).arrayBuffer()), start);
  }
  return bytes;
}
