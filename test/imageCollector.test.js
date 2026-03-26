import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import {
  collectImages,
  DEFAULT_MAX_URLS,
  extractImageCandidates,
  formatTimestamp,
  LOGO_MAX_URLS,
  normalizeImageUrlForDownload,
  normalizeRawImageValue,
  shouldUseBrowserFallback,
  validateRunInputs
} from '../src/imageCollector.js';

let fixtureServer;
let fixtureBaseUrl;

before(async () => {
  fixtureServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/page-one') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <head>
            <meta property="og:image" content="/images/cover.webp" />
          </head>
          <body>
            <img src="/images/one.jpg" />
            <picture>
              <source srcset="/images/two.png 1x, /images/ignored.png 2x" />
            </picture>
            <img src="/images/one.jpg" />
            <img src="data:image/png;base64,abc123" />
            <img src="/not-image" />
          </body>
        </html>
      `);
      return;
    }

    if (url.pathname === '/page-two') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const imageTags = Array.from({ length: 90 }, (_, index) => {
        return `<img src="/bulk/image-${index + 1}.jpg" />`;
      }).join('');
      res.end(`<html><body>${imageTags}</body></html>`);
      return;
    }

    if (url.pathname === '/page-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/404') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('missing');
      return;
    }

    if (url.pathname === '/not-image') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not an image');
      return;
    }

    if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/bulk/')) {
      const extension = path.extname(url.pathname).toLowerCase();
      const contentType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'content-type': contentType });
      res.end(Buffer.from(`binary:${url.pathname}`));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });

  await new Promise((resolve) => {
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });

  const address = fixtureServer.address();
  fixtureBaseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    fixtureServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

describe('validateRunInputs', () => {
  test('accepts same root domain and normalizes URLs', () => {
    const result = validateRunInputs([
      'www.example.com',
      'https://blog.example.com/path'
    ]);

    assert.equal(result.domain, 'example.com');
    assert.deepEqual(result.normalizedUrls, [
      'https://www.example.com/',
      'https://blog.example.com/path'
    ]);
    assert.deepEqual(result.sourceDomains, ['example.com']);
  });

  test('accepts mixed root domains and uses a mixed-domains folder label', () => {
    const result = validateRunInputs(['https://example.com', 'https://other.com/path']);

    assert.equal(result.domain, 'mixed-domains');
    assert.deepEqual(result.sourceDomains, ['example.com', 'other.com']);
  });

  test('supports a higher URL limit when requested', () => {
    const result = validateRunInputs(
      [
        'https://one.example.com',
        'https://two.example.com',
        'https://three.example.com',
        'https://four.example.com',
        'https://five.example.com'
      ],
      { maxUrls: LOGO_MAX_URLS }
    );

    assert.equal(result.normalizedUrls.length, 5);
  });

  test('accepts six urls in default image mode', () => {
    const result = validateRunInputs([
      'https://one.example.com',
      'https://two.example.com',
      'https://three.example.com',
      'https://four.example.com',
      'https://five.example.com',
      'https://six.example.com'
    ]);

    assert.equal(result.normalizedUrls.length, DEFAULT_MAX_URLS);
  });

  test('rejects requests over the default image-mode URL limit', () => {
    assert.throws(
      () =>
        validateRunInputs(
          [
            'https://one.example.com',
            'https://two.example.com',
            'https://three.example.com',
            'https://four.example.com',
            'https://five.example.com',
            'https://six.example.com',
            'https://seven.example.com'
          ],
          { maxUrls: DEFAULT_MAX_URLS }
        ),
      /maximum of 6 URLs/
    );
  });
});

describe('extractImageCandidates', () => {
  test('resolves relative URLs and takes the first srcset candidate', () => {
    const { candidates, skippedInvalid } = extractImageCandidates(
      `
        <html>
          <head>
            <meta property="og:image" content="/meta.jpg" />
          </head>
          <body>
            <img src="./hero.png" srcset="./hero-2x.png 2x, ./hero-3x.png 3x" />
            <picture>
              <source srcset="/gallery/first.webp 1x, /gallery/second.webp 2x" />
            </picture>
            <img src="blob:https://example.com/abc" />
          </body>
        </html>
      `,
      'https://www.example.com/products/widget'
    );

    assert.deepEqual(candidates, [
      'https://www.example.com/meta.jpg',
      'https://www.example.com/products/hero.png',
      'https://www.example.com/products/hero-2x.png',
      'https://www.example.com/gallery/first.webp'
    ]);
    assert.equal(skippedInvalid, 1);
  });

  test('uses lazy-load attributes and repairs embedded absolute URLs', () => {
    const { candidates, skippedInvalid } = extractImageCandidates(
      `
        <html>
          <head>
            <meta property="og:image" content="https://example.com/assets/https://cdn.example.com/logo.jpg" />
          </head>
          <body>
            <img src="" data-src="/gallery/actual-image.png" />
            <img data-original="/gallery/original-image.webp" />
            <picture>
              <source data-srcset="/gallery/first-choice.avif 1x, /gallery/second-choice.avif 2x" />
            </picture>
          </body>
        </html>
      `,
      'https://www.example.com/products/widget'
    );

    assert.deepEqual(candidates, [
      'https://cdn.example.com/logo.jpg',
      'https://www.example.com/gallery/actual-image.png',
      'https://www.example.com/gallery/original-image.webp',
      'https://www.example.com/gallery/first-choice.avif'
    ]);
    assert.equal(skippedInvalid, 0);
  });
});

describe('normalizeRawImageValue', () => {
  test('keeps normal URLs intact and repairs embedded absolute URLs in the path', () => {
    assert.equal(
      normalizeRawImageValue('https://example.com/images/photo.jpg'),
      'https://example.com/images/photo.jpg'
    );
    assert.equal(
      normalizeRawImageValue('https://outer.example.com/a/https://inner.example.com/image.jpg'),
      'https://inner.example.com/image.jpg'
    );
    assert.equal(
      normalizeRawImageValue('/images/example.jpg'),
      '/images/example.jpg'
    );
  });
});

describe('normalizeImageUrlForDownload', () => {
  test('upgrades googleusercontent thumbnails to original-size urls and skips encrypted search thumbs', () => {
    assert.equal(
      normalizeImageUrlForDownload('https://lh4.googleusercontent.com/-veHEVPyDnzk/AAAAAAAAAAI/AAAAAAAAAAA/y3dOS0m1Uik/s40-c-k-mo/photo.jpg'),
      'https://lh4.googleusercontent.com/-veHEVPyDnzk/AAAAAAAAAAI/AAAAAAAAAAA/y3dOS0m1Uik/s0/photo.jpg'
    );
    assert.equal(
      normalizeImageUrlForDownload('https://lh3.googleusercontent.com/gps-cs-s/AHVAweoVRBoHZU2DopX96rXv5KkdRxHX5rAeUNjwJKLZGu8_TlgWG5ng9uVbk3ILiKHJ6lq_ikHipqN-9NDCmWbXYDopxB0Pav86seJ8SPFlnRzpSxj4hE5BFOlSWvp-ildkbIBEFNOp=s192-w192-h144-n-k-no'),
      'https://lh3.googleusercontent.com/gps-cs-s/AHVAweoVRBoHZU2DopX96rXv5KkdRxHX5rAeUNjwJKLZGu8_TlgWG5ng9uVbk3ILiKHJ6lq_ikHipqN-9NDCmWbXYDopxB0Pav86seJ8SPFlnRzpSxj4hE5BFOlSWvp-ildkbIBEFNOp=s0'
    );
    assert.equal(
      normalizeImageUrlForDownload('https://lh3.googleusercontent.com/gps-cs-s/AHVAweqQMUR6BPomsyvMOnpWXOukvhw9ZCujXpIDCCh8LO3R5wgmXObJfkPybPjVo1z_G7gQRZjGTmHu39csqZklaxQcQj6MMdGF1rPxcMOskTpkMXiDxBxoRql06ppQD9S03DHUH10=w408-h274-k-no'),
      'https://lh3.googleusercontent.com/gps-cs-s/AHVAweqQMUR6BPomsyvMOnpWXOukvhw9ZCujXpIDCCh8LO3R5wgmXObJfkPybPjVo1z_G7gQRZjGTmHu39csqZklaxQcQj6MMdGF1rPxcMOskTpkMXiDxBxoRql06ppQD9S03DHUH10=s0'
    );
    assert.equal(
      normalizeImageUrlForDownload('https://encrypted-tbn3.gstatic.com/images?q=tbn:ANd9GcRg-awUEaAmeOZBuku1nMyIK7WnThH8kG8btkjBmdp0bUjNOAvGglQk5FqW4TLTveUMwOxegw'),
      null
    );
  });
});

describe('shouldUseBrowserFallback', () => {
  test('enables browser rendering for google pages and challenge html', () => {
    assert.equal(
      shouldUseBrowserFallback('https://www.google.com/search?q=test', '<html></html>', []),
      true
    );
    assert.equal(
      shouldUseBrowserFallback('https://example.com', '<div>Please click here /httpservice/retry/enablejs</div>', []),
      true
    );
    assert.equal(
      shouldUseBrowserFallback('https://example.com', '<html></html>', ['https://example.com/image.jpg']),
      false
    );
  });
});

describe('collectImages', () => {
  test('downloads images, deduplicates, and preserves deterministic names', async () => {
    const desktopDir = await mkdtemp(path.join(os.tmpdir(), 'image-collector-'));
    const result = await collectImages({
      urls: [`${fixtureBaseUrl}/page-one`],
      desktopDir,
      now: new Date('2026-03-06T15:04:05Z')
    });

    assert.equal(result.domain, '127.0.0.1');
    assert.equal(result.pagesScanned, 1);
    assert.equal(result.imagesSaved, 3);
    assert.equal(result.skippedDuplicates, 1);
    assert.equal(result.skippedInvalid, 2);
    assert.match(result.outputPath, new RegExp(`127\\.0\\.0\\.1[\\/]${formatTimestamp('2026-03-06T15:04:05Z')}$`));

    const files = await readdir(result.outputPath);
    assert.deepEqual(files.sort(), ['001.webp', '002.jpg', '003.png']);

    const firstFileContents = await readFile(path.join(result.outputPath, '001.webp'), 'utf8');
    assert.equal(firstFileContents, 'binary:/images/cover.webp');
  });

  test('stops after 75 saved images across multiple pages', async () => {
    const desktopDir = await mkdtemp(path.join(os.tmpdir(), 'image-collector-'));
    const result = await collectImages({
      urls: [`${fixtureBaseUrl}/page-two`, `${fixtureBaseUrl}/page-one`],
      desktopDir
    });

    assert.equal(result.pagesScanned, 1);
    assert.equal(result.imagesSaved, 75);
    assert.equal(result.skippedDuplicates, 0);

    const files = await readdir(result.outputPath);
    assert.equal(files.length, 75);
    const sortedFiles = files.sort();
    assert.equal(sortedFiles[0], '001.jpg');
    assert.equal(sortedFiles.at(-1), '075.jpg');
  });

  test('uses the browser extractor for google-style pages and saves mixed-domain files with host labels', async () => {
    const desktopDir = await mkdtemp(path.join(os.tmpdir(), 'image-collector-'));
    let browserExtractorCalls = 0;

    const result = await collectImages({
      urls: ['https://www.google.com/search?q=bmb+dental+clinic'],
      desktopDir,
      fetchImpl: async (input) => {
        const url = String(input);

        if (url.startsWith('https://www.google.com/search')) {
          return new Response('<html><head><title>Google Search</title></head><body>Please click here /httpservice/retry/enablejs</body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' }
          });
        }

        if (url === 'https://lh3.googleusercontent.com/test-photo=s0') {
          return new Response(Buffer.from('browser-image'), {
            headers: { 'content-type': 'image/jpeg' }
          });
        }

        throw new Error(`Unexpected URL in test fetch: ${url}`);
      },
      browserExtractor: async () => {
        browserExtractorCalls += 1;
        return ['https://lh3.googleusercontent.com/test-photo=s192-w192-h144'];
      }
    });

    assert.equal(browserExtractorCalls, 1);
    assert.equal(result.imagesSaved, 1);
    assert.equal(result.domain, 'google.com');

    const files = await readdir(result.outputPath);
    assert.deepEqual(files, ['001.jpg']);
  });
});

describe('api', () => {
  test('allows mixed domains through the API', async () => {
    const app = createApp({
      collector: async () => ({
        domain: 'mixed-domains',
        sourceDomains: ['example.com', 'other.com'],
        outputPath: '/tmp/mixed-domains/2026-03-06T00-00-00',
        pagesScanned: 2,
        imagesSaved: 4,
        skippedDuplicates: 0,
        skippedInvalid: 0,
        errors: [],
        successfulPages: 1
      })
    });
    const server = await listen(app);
    const address = server.address();

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/download`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          urls: ['https://example.com', 'https://other.com']
        })
      });

      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.domain, 'mixed-domains');
      assert.deepEqual(payload.sourceDomains, ['example.com', 'other.com']);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  test('returns 502 when every page fails', async () => {
    const app = createApp({
      collector: async () => ({
        domain: 'example.com',
        outputPath: '/tmp/example.com/2026-03-06T00-00-00',
        pagesScanned: 2,
        imagesSaved: 0,
        skippedDuplicates: 0,
        skippedInvalid: 0,
        errors: ['Page fetch failed for https://example.com/a: HTTP 404'],
        successfulPages: 0
      })
    });
    const server = await listen(app);
    const address = server.address();

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/download`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          urls: ['https://example.com/a']
        })
      });

      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.match(payload.error, /failed to load as HTML/);
      assert.equal(payload.details.imagesSaved, 0);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  test('routes logo mode through the logo collector', async () => {
    const app = createApp({
      logoCollector: async () => ({
        domain: 'example.com',
        sourceDomains: ['example.com'],
        outputPath: '/tmp/client-logos/2026-03-12T00-00-00',
        pagesScanned: 1,
        logosSaved: 1,
        skippedInvalid: 0,
        errors: [],
        successfulPages: 1,
        items: [
          {
            inputUrl: 'https://example.com/',
            sourceUrl: 'https://example.com/logo.png',
            fileName: 'example.com-logo.png',
            backgroundRemoved: true
          }
        ]
      })
    });
    const server = await listen(app);
    const address = server.address();

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/download`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          urls: ['https://example.com'],
          mode: 'logos'
        })
      });

      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.mode, 'logos');
      assert.equal(payload.logosSaved, 1);
      assert.equal(payload.items[0].fileName, 'example.com-logo.png');
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  test('allows up to eight urls in logo mode', async () => {
    let receivedUrls = [];
    const app = createApp({
      logoCollector: async ({ urls }) => {
        receivedUrls = urls;

        return {
          domain: 'mixed-domains',
          sourceDomains: ['one.com', 'two.com'],
          outputPath: '/tmp/client-logos/2026-03-12T00-00-00',
          pagesScanned: urls.length,
          logosSaved: urls.length,
          skippedInvalid: 0,
          errors: [],
          successfulPages: urls.length,
          items: urls.map((url, index) => ({
            inputUrl: url,
            sourceUrl: `${url}/logo.png`,
            fileName: `logo-${index + 1}.png`,
            backgroundRemoved: true
          }))
        };
      }
    });
    const server = await listen(app);
    const address = server.address();
    const urls = Array.from({ length: LOGO_MAX_URLS }, (_, index) => `https://client${index + 1}.example.com`);

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/download`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          urls,
          mode: 'logos'
        })
      });

      assert.equal(response.status, 200);
      assert.equal(receivedUrls.length, LOGO_MAX_URLS);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  test('keeps image mode capped at six urls', async () => {
    const app = createApp();
    const server = await listen(app);
    const address = server.address();

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/download`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          urls: [
            'https://one.example.com',
            'https://two.example.com',
            'https://three.example.com',
            'https://four.example.com',
            'https://five.example.com',
            'https://six.example.com',
            'https://seven.example.com'
          ]
        })
      });

      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.match(payload.error, /maximum of 6 URLs/i);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
