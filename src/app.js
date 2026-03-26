import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { collectImages, LOGO_MAX_URLS, validateRunInputs } from './imageCollector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

async function defaultLogoCollector(options) {
  const { extractLogos } = await import('./logoExtractor.js');
  return extractLogos(options);
}

export function createApp({ collector = collectImages, logoCollector = defaultLogoCollector, desktopDir } = {}) {
  const app = express();

  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(publicDir));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/download', async (req, res) => {
    const mode = req.body?.mode === 'logos' ? 'logos' : 'images';
    let prepared;

    try {
      prepared = validateRunInputs(req.body?.urls ?? [], {
        maxUrls: mode === 'logos' ? LOGO_MAX_URLS : undefined
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    try {
      const selectedCollector = mode === 'logos' ? logoCollector : collector;
      const result = await selectedCollector({
        urls: prepared.normalizedUrls,
        desktopDir
      });

      const publicResult = {
        mode,
        ...toPublicResult(result)
      };

      if (result.successfulPages === 0) {
        res.status(502).json({
          error: 'All provided pages failed to load as HTML.',
          details: publicResult
        });
        return;
      }

      res.json(publicResult);
    } catch (error) {
      res.status(500).json({ error: error.message || 'Unexpected server error.' });
    }
  });

  return app;
}

function toPublicResult(result) {
  const { successfulPages, ...publicResult } = result;
  return publicResult;
}
