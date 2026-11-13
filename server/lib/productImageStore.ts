import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

// Product and box photos live in Neon Object Storage (bucket PRODUCT_IMAGE_BUCKET), not on the
// server's disk. Every picture is re-encoded small before upload, and the bytes served are kept in
// memory by content hash, so a photo leaves the bucket once per server start rather than once per
// scan, and leaves the server only when the browser's ETag no longer matches.

const BUCKET = (process.env.PRODUCT_IMAGE_BUCKET ?? 'product-images').trim();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

export const PRODUCT_IMAGE_CONTENT_TYPE = 'image/webp';

// Thumbnails are shown at card/dialog size, and the lightbox tops out around 75vh on a phone, so
// 480px is plenty. WebP at q70 is roughly a third the size of the old 600px JPEG q82.
// Most source PNGs have a transparent background; flatten onto white so they blend into the white
// cards they're shown on (and keep WebP from carrying an alpha channel it doesn't need).
export async function compressProductImage(original: Buffer): Promise<Buffer> {
  return sharp(original)
    .rotate()
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 70, effort: 6 })
    .toBuffer();
}

// List rows show photos at 32-72 CSS px, so a 144px copy covers a 2x phone screen at a fraction of
// the bytes. Stored next to the full photo as "<id>.thumb.webp" / "<id>-box.thumb.webp".
export type ProductImageSize = 'full' | 'thumb';
export const thumbKeyOf = (key: string) => key.replace(/\.webp$/, '.thumb.webp');

export async function compressProductThumb(full: Buffer): Promise<Buffer> {
  return sharp(full)
    .resize({ width: 144, height: 144, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 60, effort: 6 })
    .toBuffer();
}

export async function putProductImage(key: string, body: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: PRODUCT_IMAGE_CONTENT_TYPE,
  }));
}

export async function deleteProductImage(key: string): Promise<void> {
  for (const k of [key, thumbKeyOf(key)]) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })); } catch { /* already gone */ }
    for (const [id, entry] of cache) {
      if (entry.key === k) { cache.delete(id); cacheBytes -= entry.body.length; }
    }
  }
}

// Keyed by content hash, so a re-synced picture never serves stale bytes: its hash changes.
// Compressed photos are ~10-30 KB, so a few hundred products fit comfortably.
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { key: string; body: Buffer }>();
let cacheBytes = 0;

function remember(id: string, key: string, body: Buffer) {
  cache.set(id, { key, body });
  cacheBytes += body.length;
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 1) {
    const [oldest, entry] = cache.entries().next().value!;
    cache.delete(oldest);
    cacheBytes -= entry.body.length;
  }
}

async function fetchObject(key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!res.Body) return null;
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// A thumbnail that isn't in the bucket yet (photos stored before thumbnails existed, or a photo
// replaced since) is made from the full photo on first request and saved, so it's made once.
export async function getProductImage(key: string, hash: string, size: ProductImageSize = 'full'): Promise<Buffer | null> {
  const objectKey = size === 'thumb' ? thumbKeyOf(key) : key;
  const id = `${hash}:${size}`;
  const hit = cache.get(id);
  if (hit && hit.key === objectKey) {
    cache.delete(id);
    cache.set(id, hit); // most recently used goes last
    return hit.body;
  }

  let body = await fetchObject(objectKey);
  if (!body && size === 'thumb') {
    const full = await getProductImage(key, hash, 'full');
    if (!full) return null;
    body = await compressProductThumb(full);
    await putProductImage(objectKey, body);
  }
  if (!body) return null;
  remember(id, objectKey, body);
  return body;
}
