// Phone photos are often 3-8 MB; the hosted server accepts about 4 MB per upload.
// Large photos are redrawn at most 2000 px on the long side as JPEG, which keeps
// receipts readable at a fraction of the size. PDFs and small images are sent as they are.
const MAX_SIDE = 2000;
const SHRINK_ABOVE = 1.5 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= SHRINK_ABOVE) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNG areas become white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file; // the browser could not read it; let the server decide
  }
}
