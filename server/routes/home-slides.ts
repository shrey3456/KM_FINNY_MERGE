import { Router, Request, Response } from 'express';
import { getHomeSlides, getHomeSlideImage } from '../services/homeSlidesSync';

// Dashboard slider + Login welcome photo (see services/homeSlidesSync.ts). Public on purpose: the
// welcome photo is shown before anyone has logged in, and these are marketing pictures.
const router = Router();

const imageUrl = (key: string) => `/api/home-slides/image/${key}`;

// GET /api/home-slides → { welcome: url | null, ads: [{ title, url }] }
router.get('/home-slides', async (_req: Request, res: Response) => {
  try {
    const { welcome, ads } = await getHomeSlides();
    res.set('Cache-Control', 'no-cache');
    res.json({
      welcome: welcome ? imageUrl(welcome.key) : null,
      ads: ads.map((a) => ({ title: a.title, url: imageUrl(a.key) })),
    });
  } catch (error) {
    console.error('[Home slides] list failed:', error);
    res.status(500).json({ message: 'Could not load home slides' });
  }
});

// GET /api/home-slides/image/:key — keys contain a content hash, so each one never changes.
router.get('/home-slides/image/:key', async (req: Request, res: Response) => {
  const key = String(req.params.key ?? '');
  if (!/^(ad|welcome)-[0-9a-f]{32}-[0-9a-f]{12}\.webp$/.test(key)) return res.status(404).end();
  try {
    const body = await getHomeSlideImage(key);
    if (!body) return res.status(404).end();
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(body);
  } catch (error) {
    console.error('[Home slides] image failed:', error);
    res.status(500).end();
  }
});

export default router;
