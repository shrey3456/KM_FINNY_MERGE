import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Client } from '@notionhq/client';
import crypto from 'crypto';
import sharp from 'sharp';
import { extractText } from '../lib/notionProperties';

// Home slides — the Dashboard slider ("Product Ad" rows) and the Login welcome photo ("Welcome
// Screen" row) come from the Notion attachment database (NOTION_ATTACHMENT_STORAGE_PATH). Notion is
// the source; the bucket (HOME_SLIDES_BUCKET) only holds compressed copies, because Notion file
// URLs expire after ~1 hour. Every other Category in that database is ignored.
//
// A sync reads the whole database (it's small), copies files that are new or replaced, and deletes
// copies whose row or file is gone. What's in the bucket is described by manifest.json there, so a
// restart doesn't re-download anything. Object keys include a content hash, so a replaced picture
// gets a new URL and browsers can cache each one forever.

const BUCKET = (process.env.HOME_SLIDES_BUCKET ?? 'home-slides').trim();
const DATABASE_ID = (process.env.NOTION_ATTACHMENT_STORAGE_PATH ?? '').trim();
const MANIFEST_KEY = 'manifest.json';

const CATEGORY_AD = 'Product Ad';
const CATEGORY_WELCOME = 'Welcome Screen';

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

const notion = new Client({
  auth: (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim(),
});

export type HomeSlide = { pageId: string; title: string; ref: string; key: string };
type Manifest = { welcome: HomeSlide | null; ads: HomeSlide[] };

let manifest: Manifest | null = null;
const imageCache = new Map<string, Buffer>();

export const homeSlidesDatabaseId = () => DATABASE_ID.replace(/-/g, '').toLowerCase();

// Notion file URLs carry a fresh signature on every read; the part before "?" only changes when
// the file itself is replaced (same trick as product photos in notionInventorySync).
const refOf = (url: string) => String(url ?? '').split('?')[0];

async function getObject(key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function loadManifest(): Promise<Manifest> {
  if (manifest) return manifest;
  const body = await getObject(MANIFEST_KEY);
  manifest = body ? JSON.parse(body.toString('utf8')) : { welcome: null, ads: [] };
  return manifest!;
}

// Slides fill the phone width (~h-48); the welcome photo covers 55% of a desktop screen.
// Only compressed when needed: a WebP that's already within size and under MAX_KEEP_BYTES is
// stored untouched, so a file prepared by hand doesn't lose quality to a second encode.
const MAX_KEEP_BYTES = 300 * 1024;

async function compress(original: Buffer, kind: 'ad' | 'welcome'): Promise<Buffer> {
  const width = kind === 'welcome' ? 1600 : 1080;
  const meta = await sharp(original).metadata();
  const fits = (meta.width ?? Infinity) <= width && (meta.height ?? Infinity) <= width;
  if (meta.format === 'webp' && fits && original.length <= MAX_KEEP_BYTES) return original;
  return sharp(original)
    .rotate()
    .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 78, effort: 6 })
    .toBuffer();
}

type Row = { pageId: string; title: string; url: string };

async function readRows(): Promise<{ welcome: Row | null; ads: Row[] }> {
  const rows: { category: string; row: Row }[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.databases.query({ database_id: DATABASE_ID, start_cursor: cursor, page_size: 100 });
    for (const page of res.results) {
      const props = page.properties ?? {};
      const category = props['Category']?.select?.name ?? '';
      if (category !== CATEGORY_AD && category !== CATEGORY_WELCOME) continue;
      const file = (props['Files & media']?.files ?? [])[0];
      const url = file?.file?.url ?? file?.external?.url;
      if (!url) continue; // a row with no picture yet is simply not shown
      rows.push({ category, row: { pageId: page.id.replace(/-/g, ''), title: extractText(props['Title']).trim(), url } });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const ads = rows.filter((r) => r.category === CATEGORY_AD).map((r) => r.row)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })); // AD1, AD2 … AD10
  const welcome = rows.filter((r) => r.category === CATEGORY_WELCOME).map((r) => r.row)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))[0] ?? null;
  return { welcome, ads };
}

// Reuses the stored copy when the Notion file is unchanged; otherwise downloads and stores it.
// Returns null when the file can't be read as a picture (e.g. a link to a web page).
async function resolve(row: Row, kind: 'ad' | 'welcome', previous: HomeSlide[]): Promise<HomeSlide | null> {
  const ref = refOf(row.url);
  const same = previous.find((p) => p.pageId === row.pageId && p.ref === ref);
  if (same) return { ...same, title: row.title };

  try {
    const res = await fetch(row.url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const body = await compress(Buffer.from(await res.arrayBuffer()), kind);
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
    const key = `${kind}-${row.pageId}-${hash}.webp`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'image/webp' }));
    imageCache.set(key, body);
    return { pageId: row.pageId, title: row.title, ref, key };
  } catch (error) {
    console.warn(`[Home slides] skipped "${row.title}": ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

let running: Promise<string> | null = null;

export function syncHomeSlides(): Promise<string> {
  if (!DATABASE_ID) return Promise.resolve('skipped (NOTION_ATTACHMENT_STORAGE_PATH is not set)');
  if (!running) running = run().finally(() => { running = null; });
  return running;
}

async function run(): Promise<string> {
  try {
    const old = await loadManifest();
    const previous = [...old.ads, ...(old.welcome ? [old.welcome] : [])];
    const rows = await readRows();

    const ads: HomeSlide[] = [];
    for (const row of rows.ads) {
      const slide = await resolve(row, 'ad', previous);
      if (slide) ads.push(slide);
    }
    const welcome = rows.welcome ? await resolve(rows.welcome, 'welcome', previous) : null;
    const next: Manifest = { welcome, ads };

    const kept = new Set([...ads, ...(welcome ? [welcome] : [])].map((s) => s.key));
    const removed = previous.filter((p) => !kept.has(p.key));
    const added = [...kept].filter((k) => !previous.some((p) => p.key === k));

    if (JSON.stringify(next) !== JSON.stringify(old)) {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: MANIFEST_KEY, Body: JSON.stringify(next), ContentType: 'application/json' }));
      manifest = next;
    }
    for (const p of removed) {
      try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: p.key })); } catch { /* already gone */ }
      imageCache.delete(p.key);
    }

    const result = `${ads.length} ad(s), welcome ${welcome ? 'set' : 'none'} — ${added.length} copied, ${removed.length} removed`;
    console.log(`[Home slides] ${result}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Home slides] sync failed: ${message}`);
    return `error (${message})`;
  }
}

export async function getHomeSlides(): Promise<Manifest> {
  return loadManifest();
}

export async function getHomeSlideImage(key: string): Promise<Buffer | null> {
  const hit = imageCache.get(key);
  if (hit) return hit;
  const body = await getObject(key);
  if (body) imageCache.set(key, body);
  return body;
}
