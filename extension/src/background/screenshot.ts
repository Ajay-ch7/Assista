// Screenshots for the Vision specialist: the visible part of the tab, or one element
// cropped out of it, scaled down and encoded as base64 JPEG.

import type { CaptureFrame, Rect, ScreenshotReply } from '../shared/messages';

/** Longest side of the image sent to the model. Larger images cost time and add little. */
export const MAX_SIDE = 1280;
/** Crops smaller than this, in CSS pixels, show too little to describe. */
const MIN_CROP = 4;
const JPEG_QUALITY = 0.85;

export interface Crop {
  /** Source box in image pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output size. */
  width: number;
  height: number;
}

/**
 * Maps a CSS-pixel `rect` in a viewport onto the captured image, which may be larger
 * because of the device pixel ratio or zoom. Without a rect the whole image is used.
 * Returns null when the element is not on screen.
 */
export function cropFor(
  frame: CaptureFrame,
  image: { width: number; height: number },
  maxSide = MAX_SIDE,
): Crop | null {
  const scale = image.width / frame.viewport.width;
  let box: Rect = { x: 0, y: 0, width: frame.viewport.width, height: frame.viewport.height };
  if (frame.rect) {
    const left = Math.max(frame.rect.x, 0);
    const top = Math.max(frame.rect.y, 0);
    const right = Math.min(frame.rect.x + frame.rect.width, frame.viewport.width);
    const bottom = Math.min(frame.rect.y + frame.rect.height, frame.viewport.height);
    if (right - left < MIN_CROP || bottom - top < MIN_CROP) return null;
    box = { x: left, y: top, width: right - left, height: bottom - top };
  }
  const sx = Math.round(box.x * scale);
  const sy = Math.round(box.y * scale);
  const sw = Math.min(Math.round(box.width * scale), image.width - sx);
  const sh = Math.min(Math.round(box.height * scale), image.height - sy);
  const shrink = Math.min(1, maxSide / Math.max(sw, sh));
  return {
    sx,
    sy,
    sw,
    sh,
    width: Math.max(1, Math.round(sw * shrink)),
    height: Math.max(1, Math.round(sh * shrink)),
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Crops and scales a captured PNG data URL. Runs in the service worker. */
export async function cropImage(dataUrl: string, frame: CaptureFrame): Promise<ScreenshotReply> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const crop = cropFor(frame, bitmap);
    if (!crop) return { ok: false, error: 'not_visible' };
    const canvas = new OffscreenCanvas(crop.width, crop.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const image = bytesToBase64(new Uint8Array(await jpeg.arrayBuffer()));
    return { ok: true, image, mime: 'image/jpeg' };
  } finally {
    bitmap.close();
  }
}
