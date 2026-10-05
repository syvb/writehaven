// Shrinks and re-encodes images off the main thread (see images.js).
import { processImage } from './images.js';

self.onmessage = async (e) => {
  const { id, file } = e.data || {};
  try {
    const r = await processImage(file);
    self.postMessage({ id, ok: true, result: r });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message, code: (err && err.code) || 'decode' });
  }
};
