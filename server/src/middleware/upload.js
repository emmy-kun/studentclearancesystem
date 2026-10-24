// Document uploads (spec section 11): JPEG, PNG, WebP or PDF only, size limit,
// random file names, kept in storage (services/storage.js), never served statically.
//
// The browser-supplied MIME type is only a first filter; the file's first bytes
// are checked so a renamed file of another type is refused.
import crypto from 'node:crypto';
import multer from 'multer';
import env from '../config/env.js';
import httpError from '../utils/httpError.js';
import { saveFile } from '../services/storage.js';

export const DOCUMENTS_SUBDIR = 'documents';

const ALLOWED = {
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: '.png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: '.webp', magic: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  'application/pdf': { ext: '.pdf', magic: (b) => b.toString('ascii', 0, 5) === '%PDF-' },
};

const multerSingle = multer({
  storage: multer.memoryStorage(), // at most a few MB, then saved through storage.js
  limits: { fileSize: env.uploads.maxBytes, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(httpError(400, 'Only JPG, PNG, WebP or PDF files can be uploaded'));
  },
}).single('file');

/**
 * Accepts one file in the `file` field. Sets req.file.relativePath
 * ('documents/<random>.<ext>'), relative to the uploads folder.
 */
export function uploadDocument(req, res, next) {
  multerSingle(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(httpError(413, `File is too large (max ${Math.round(env.uploads.maxBytes / 1024 / 1024)} MB)`));
      if (err instanceof multer.MulterError) return next(httpError(400, `Upload error: ${err.message}`));
      return next(err);
    }
    if (!req.file) return next(httpError(400, 'Choose a file to upload'));
    if (!ALLOWED[req.file.mimetype].magic(req.file.buffer)) {
      return next(httpError(400, 'The file content does not match its type. Upload a real photo or PDF.'));
    }
    req.file.relativePath = `${DOCUMENTS_SUBDIR}/${crypto.randomBytes(16).toString('hex')}${ALLOWED[req.file.mimetype].ext}`;
    saveFile(req.file.relativePath, req.file.buffer, req.file.mimetype).then(() => next(), next);
  });
}
