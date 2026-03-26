import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import sharp from 'sharp';

import {
  buildTransparentSquareLogo,
  extractLogoCandidates,
  extractLogos
} from '../src/logoExtractor.js';

describe('extractLogoCandidates', () => {
  test('prefers logo-like markup over generic page images', () => {
    const candidates = extractLogoCandidates(
      `
        <html>
          <head>
            <meta property="og:image" content="/images/hero.jpg" />
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                "logo": "/assets/logo-primary.svg"
              }
            </script>
          </head>
          <body>
            <header>
              <a href="/">
                <img src="/assets/logo-primary.svg" alt="Acme logo" class="site-logo" />
              </a>
            </header>
            <img src="/images/hero.jpg" alt="Smiling patients" />
          </body>
        </html>
      `,
      'https://www.acme-dental.com/services'
    );

    assert.equal(candidates[0].url, 'https://www.acme-dental.com/assets/logo-primary.svg');
    assert.match(candidates[0].reasons.join(' '), /structured-logo|img-logo/);
  });
});

describe('buildTransparentSquareLogo', () => {
  test('returns a square transparent PNG buffer', async () => {
    const inputBuffer = await sharp({
      create: {
        width: 360,
        height: 120,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    })
      .png()
      .toBuffer();

    const transparentForeground = await sharp({
      create: {
        width: 220,
        height: 80,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 180,
              height: 60,
              channels: 4,
              background: { r: 22, g: 82, b: 45, alpha: 1 }
            }
          })
            .png()
            .toBuffer(),
          top: 10,
          left: 20
        }
      ])
      .png()
      .toBuffer();

    const result = await buildTransparentSquareLogo({
      inputBuffer,
      backgroundRemover: async () => new Blob([transparentForeground], { type: 'image/png' })
    });

    const metadata = await sharp(result.buffer).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, metadata.height);
    assert.equal(result.backgroundRemoved, true);
  });

  test('passes a typed PNG blob into background removal', async () => {
    const inputBuffer = await sharp({
      create: {
        width: 280,
        height: 100,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    })
      .png()
      .toBuffer();

    const transparentForeground = await sharp({
      create: {
        width: 180,
        height: 60,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 140,
              height: 40,
              channels: 4,
              background: { r: 12, g: 89, b: 156, alpha: 1 }
            }
          })
            .png()
            .toBuffer(),
          top: 10,
          left: 20
        }
      ])
      .png()
      .toBuffer();

    let removerInput;
    const result = await buildTransparentSquareLogo({
      inputBuffer,
      backgroundRemover: async (inputImage) => {
        removerInput = inputImage;
        return new Blob([transparentForeground], { type: 'image/png' });
      }
    });

    assert.ok(removerInput instanceof Blob);
    assert.equal(removerInput.type, 'image/png');
    assert.equal(result.backgroundRemoved, true);
  });
});

describe('extractLogos', () => {
  test('finds, processes, and saves one logo per URL', async () => {
    const desktopDir = await mkdtemp(path.join(os.tmpdir(), 'logo-extractor-'));
    const logoInput = await sharp({
      create: {
        width: 320,
        height: 120,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    })
      .png()
      .toBuffer();
    const transparentForeground = await sharp({
      create: {
        width: 200,
        height: 70,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 160,
              height: 50,
              channels: 4,
              background: { r: 20, g: 83, b: 45, alpha: 1 }
            }
          })
            .png()
            .toBuffer(),
          top: 10,
          left: 20
        }
      ])
      .png()
      .toBuffer();

    const result = await extractLogos({
      urls: ['acme-dental.com'],
      desktopDir,
      fetchImpl: async (input) => {
        const url = String(input);

        if (url === 'https://acme-dental.com/') {
          return new Response(
            `
              <html>
                <body>
                  <header>
                    <a href="/"><img src="/images/logo.png" alt="Acme Dental logo" class="site-logo" /></a>
                  </header>
                  <img src="/images/hero.jpg" alt="hero" />
                </body>
              </html>
            `,
            {
              headers: { 'content-type': 'text/html; charset=utf-8' }
            }
          );
        }

        if (url === 'https://acme-dental.com/images/logo.png') {
          return new Response(logoInput, {
            headers: { 'content-type': 'image/png' }
          });
        }

        if (url === 'https://acme-dental.com/images/hero.jpg') {
          return new Response(Buffer.from('not-used'), {
            headers: { 'content-type': 'image/jpeg' }
          });
        }

        throw new Error(`Unexpected URL in logo test: ${url}`);
      },
      backgroundRemover: async () => new Blob([transparentForeground], { type: 'image/png' }),
      browserExtractor: async () => []
    });

    assert.equal(result.logosSaved, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].fileName, 'acme-dental.com-logo.png');
    assert.equal(result.items[0].sourceUrl, 'https://acme-dental.com/images/logo.png');

    const files = await readdir(result.outputPath);
    assert.deepEqual(files, ['acme-dental.com-logo.png']);
  });

  test('supports more than four URLs in logo mode', async () => {
    const desktopDir = await mkdtemp(path.join(os.tmpdir(), 'logo-extractor-many-'));
    const logoInput = await sharp({
      create: {
        width: 320,
        height: 120,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    })
      .png()
      .toBuffer();
    const transparentForeground = await sharp({
      create: {
        width: 200,
        height: 70,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 160,
              height: 50,
              channels: 4,
              background: { r: 20, g: 83, b: 45, alpha: 1 }
            }
          })
            .png()
            .toBuffer(),
          top: 10,
          left: 20
        }
      ])
      .png()
      .toBuffer();
    const urls = [
      'one.acme-dental.com',
      'two.acme-dental.com',
      'three.acme-dental.com',
      'four.acme-dental.com',
      'five.acme-dental.com'
    ];

    const result = await extractLogos({
      urls,
      desktopDir,
      fetchImpl: async (input) => {
        const url = String(input);
        const parsed = new URL(url);

        if (parsed.pathname === '/') {
          return new Response(
            `
              <html>
                <body>
                  <header>
                    <a href="/"><img src="/images/logo.png" alt="Acme Dental logo" class="site-logo" /></a>
                  </header>
                </body>
              </html>
            `,
            {
              headers: { 'content-type': 'text/html; charset=utf-8' }
            }
          );
        }

        if (parsed.pathname === '/images/logo.png') {
          return new Response(logoInput, {
            headers: { 'content-type': 'image/png' }
          });
        }

        throw new Error(`Unexpected URL in many-logo test: ${url}`);
      },
      backgroundRemover: async () => new Blob([transparentForeground], { type: 'image/png' }),
      browserExtractor: async () => []
    });

    assert.equal(result.logosSaved, 5);
    assert.equal(result.items.length, 5);

    const files = await readdir(result.outputPath);
    assert.equal(files.length, 5);
  });
});
