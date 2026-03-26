import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { removeBackground } from '@imgly/background-removal-node';
import * as cheerio from 'cheerio';
import sharp from 'sharp';

import {
  formatTimestamp,
  LOGO_MAX_URLS,
  normalizeImageUrlForDownload,
  resolveImageUrl,
  validateRunInputs
} from './imageCollector.js';
import {
  DEFAULT_BROWSER_CONTEXT_OPTIONS,
  launchFallbackBrowser,
  resolveDesktopDir
} from './runtime.js';

const LOGO_SQUARE_LIMIT = 1024;
const LOGO_SOURCE_MAX = 8;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const LOGO_HINT_PATTERN = /logo|brand|wordmark|site-logo|navbar-brand/i;

export async function extractLogos({
  urls,
  desktopDir = resolveDesktopDir(),
  fetchImpl = globalThis.fetch,
  now = new Date(),
  backgroundRemover = defaultBackgroundRemover,
  browserExtractor = extractBrowserLogoCandidates
}) {
  const { parsedUrls, normalizedUrls, sourceDomains } = validateRunInputs(urls, {
    maxUrls: LOGO_MAX_URLS
  });
  const outputPath = path.join(desktopDir, 'client-logos', formatTimestamp(now));

  await mkdir(outputPath, { recursive: true });

  const result = {
    domain: sourceDomains.length === 1 ? sourceDomains[0] : 'mixed-domains',
    sourceDomains,
    outputPath,
    pagesScanned: 0,
    logosSaved: 0,
    skippedInvalid: 0,
    errors: [],
    successfulPages: 0,
    items: []
  };

  const usedFileNames = new Set();

  for (const [index, pageUrl] of parsedUrls.entries()) {
    result.pagesScanned += 1;

    let html;
    try {
      const pageResponse = await fetchImpl(pageUrl, {
        headers: {
          'user-agent': 'ImageCollector/1.0',
          accept: 'text/html,application/xhtml+xml'
        },
        signal: AbortSignal.timeout(15_000)
      });

      if (!pageResponse.ok) {
        result.errors.push(`Page fetch failed for ${pageUrl}: HTTP ${pageResponse.status}`);
        continue;
      }

      const contentType = String(pageResponse.headers.get('content-type') ?? '').toLowerCase();
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        result.errors.push(`Skipped ${pageUrl}: response was ${contentType.split(';', 1)[0]}`);
        continue;
      }

      html = await pageResponse.text();
      result.successfulPages += 1;
    } catch (error) {
      result.errors.push(`Page fetch failed for ${pageUrl}: ${error.message}`);
      continue;
    }

    let candidates = extractLogoCandidates(html, pageUrl);
    if (candidates.length === 0 || candidates[0].score < 90) {
      try {
        const browserCandidates = await browserExtractor(pageUrl);
        candidates = mergeLogoCandidates(candidates, browserCandidates);
      } catch (error) {
        result.errors.push(`Browser logo scan failed for ${pageUrl}: ${error.message}`);
      }
    }

    if (candidates.length === 0) {
      result.errors.push(`No logo candidate found for ${pageUrl}`);
      continue;
    }

    const selectedLogo = await chooseBestLogoCandidate({
      candidates,
      fetchImpl,
      pageUrl
    });

    if (!selectedLogo) {
      result.errors.push(`No usable logo image found for ${pageUrl}`);
      continue;
    }

    try {
      const processed = await buildTransparentSquareLogo({
        inputBuffer: selectedLogo.buffer,
        backgroundRemover
      });
      const fileName = buildLogoFileName({
        pageUrl: normalizedUrls[index],
        usedFileNames
      });

      await writeFile(path.join(outputPath, fileName), processed.buffer);

      result.logosSaved += 1;
      result.items.push({
        inputUrl: normalizedUrls[index],
        sourceUrl: selectedLogo.url,
        fileName,
        backgroundRemoved: processed.backgroundRemoved
      });
    } catch (error) {
      result.errors.push(`Logo processing failed for ${pageUrl}: ${error.message}`);
    }
  }

  return result;
}

export function extractLogoCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const candidateMap = new Map();

  const addCandidate = (rawValue, score, reason) => {
    const normalizedUrl = normalizeLogoCandidateUrl(rawValue, pageUrl);
    if (!normalizedUrl) {
      return;
    }

    const existing = candidateMap.get(normalizedUrl) ?? {
      url: normalizedUrl,
      score: 0,
      reasons: []
    };

    if (!existing.reasons.includes(reason)) {
      existing.score += score;
      existing.reasons.push(reason);
    }

    candidateMap.set(normalizedUrl, existing);
  };

  $('meta[property="og:logo"], meta[name="og:logo"], meta[itemprop="logo"]').each((_, element) => {
    addCandidate($(element).attr('content'), 150, 'meta-logo');
  });

  $('meta[property="og:image"], meta[name="twitter:image"]').each((_, element) => {
    addCandidate($(element).attr('content'), 30, 'meta-image');
  });

  $('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]').each((_, element) => {
    addCandidate($(element).attr('href'), 15, 'icon-link');
  });

  $('script[type="application/ld+json"]').each((_, element) => {
    const jsonText = $(element).contents().text();
    for (const logoUrl of extractStructuredLogoUrls(jsonText)) {
      addCandidate(logoUrl, 170, 'structured-logo');
    }
  });

  $('img').each((_, element) => {
    const wrapped = $(element);
    const contextText = [
      wrapped.attr('alt'),
      wrapped.attr('class'),
      wrapped.attr('id'),
      wrapped.attr('aria-label'),
      wrapped.attr('itemprop')
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const inHeader = wrapped.parents('header, nav, [role="banner"]').length > 0;
    const inHomeLink = wrapped.parents('a').toArray().some((anchor) => {
      const href = $(anchor).attr('href');
      return isHomeLikeHref(href, pageUrl);
    });
    let score = 0;

    if (wrapped.attr('itemprop')?.toLowerCase() === 'logo') {
      score += 180;
    }
    if (LOGO_HINT_PATTERN.test(contextText)) {
      score += 140;
    }
    if (inHeader) {
      score += 30;
    }
    if (inHomeLink) {
      score += 20;
    }

    if (score === 0) {
      return;
    }

    for (const rawValue of [
      wrapped.attr('data-src'),
      wrapped.attr('data-lazy-src'),
      wrapped.attr('data-original'),
      wrapped.attr('src'),
      firstSrcsetCandidate(wrapped.attr('srcset'))
    ]) {
      addCandidate(rawValue, score, 'img-logo');
    }
  });

  $('[class*="logo"], [id*="logo"], [aria-label*="logo"], [class*="brand"]').each((_, element) => {
    const wrapped = $(element);
    const tagName = (element.tagName ?? element.name ?? '').toLowerCase();

    addCandidate(extractFirstCssUrl(wrapped.attr('style')), 140, 'style-logo');

    if (tagName !== 'img') {
      wrapped.find('img').each((__, nestedImg) => {
        const nested = $(nestedImg);
        for (const rawValue of [
          nested.attr('data-src'),
          nested.attr('data-lazy-src'),
          nested.attr('src'),
          firstSrcsetCandidate(nested.attr('srcset'))
        ]) {
          addCandidate(rawValue, 135, 'nested-logo');
        }
      });
    }
  });

  return Array.from(candidateMap.values()).sort((left, right) => right.score - left.score);
}

export async function extractBrowserLogoCandidates(pageUrl) {
  const pageUrlString = pageUrl instanceof URL ? pageUrl.toString() : String(pageUrl);
  const { chromium } = await import('playwright-core');
  const browser = await launchFallbackBrowser(chromium);

  try {
    const context = await browser.newContext(DEFAULT_BROWSER_CONTEXT_OPTIONS);
    const page = await context.newPage();

    await page.goto(pageUrlString, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000
    });

    await page.waitForTimeout(2_500);

    const htmlCandidates = extractLogoCandidates(await page.content(), page.url());
    const liveCandidates = await page.evaluate(() => {
      const candidates = [];
      const add = (rawValue, score, reason) => {
        if (typeof rawValue === 'string' && rawValue.trim()) {
          candidates.push({ rawValue: rawValue.trim(), score, reason });
        }
      };
      const addMatches = (rawValue, score, reason) => {
        if (!rawValue) {
          return;
        }

        const matches = String(rawValue).match(/https?:[^"')\s]+/g) || [];
        for (const match of matches) {
          add(match, score, reason);
        }
      };
      const firstSrcsetCandidate = (srcset) => {
        if (!srcset) {
          return '';
        }

        const firstEntry = srcset.split(',')[0]?.trim();
        return firstEntry ? firstEntry.split(/\s+/, 1)[0] : '';
      };

      document.querySelectorAll('img').forEach((element) => {
        const context = [
          element.getAttribute('alt'),
          element.getAttribute('class'),
          element.getAttribute('id'),
          element.getAttribute('aria-label'),
          element.getAttribute('itemprop')
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        const inHeader = Boolean(element.closest('header, nav, [role="banner"]'));
        const inHomeLink = Boolean(element.closest('a[href="/"], a[href="./"], a[href=""]'));
        let score = 0;

        if (element.getAttribute('itemprop')?.toLowerCase() === 'logo') {
          score += 180;
        }
        if (/logo|brand|wordmark|site-logo|navbar-brand/i.test(context)) {
          score += 140;
        }
        if (inHeader) {
          score += 30;
        }
        if (inHomeLink) {
          score += 20;
        }

        if (score === 0) {
          return;
        }

        add(element.currentSrc, score, 'browser-img');
        add(element.getAttribute('src'), score, 'browser-img');
        add(firstSrcsetCandidate(element.getAttribute('srcset')), score, 'browser-img');
      });

      document.querySelectorAll('[class*="logo"], [id*="logo"], [aria-label*="logo"], [class*="brand"]').forEach((element) => {
        addMatches(element.getAttribute('style'), 150, 'browser-style');
        const backgroundImage = getComputedStyle(element).backgroundImage;
        if (backgroundImage && backgroundImage !== 'none') {
          addMatches(backgroundImage, 150, 'browser-style');
        }
      });

      return candidates;
    });

    await context.close();

    return mergeLogoCandidates(
      htmlCandidates,
      liveCandidates
        .map((candidate) => ({
          url: normalizeLogoCandidateUrl(candidate.rawValue, page.url()),
          score: candidate.score,
          reasons: [candidate.reason]
        }))
        .filter((candidate) => candidate.url)
    );
  } finally {
    await browser.close();
  }
}

export function mergeLogoCandidates(primaryCandidates, extraCandidates) {
  const candidateMap = new Map();

  for (const candidate of [...primaryCandidates, ...extraCandidates]) {
    if (!candidate?.url) {
      continue;
    }

    const existing = candidateMap.get(candidate.url) ?? {
      url: candidate.url,
      score: 0,
      reasons: []
    };

    existing.score = Math.max(existing.score, candidate.score);
    for (const reason of candidate.reasons ?? []) {
      if (!existing.reasons.includes(reason)) {
        existing.reasons.push(reason);
      }
    }

    candidateMap.set(candidate.url, existing);
  }

  return Array.from(candidateMap.values()).sort((left, right) => right.score - left.score);
}

export async function chooseBestLogoCandidate({ candidates, fetchImpl, pageUrl }) {
  let best = null;

  for (const candidate of candidates.slice(0, LOGO_SOURCE_MAX)) {
    const fetched = await fetchAssetBuffer({
      assetUrl: candidate.url,
      fetchImpl,
      referer: pageUrl
    });

    if (!fetched) {
      continue;
    }

    const inspection = await inspectLogoBuffer({
      buffer: fetched.buffer,
      contentType: fetched.contentType,
      assetUrl: candidate.url
    });

    if (!inspection) {
      continue;
    }

    const totalScore = candidate.score + inspection.scoreBonus;
    if (!best || totalScore > best.totalScore) {
      best = {
        ...candidate,
        ...fetched,
        ...inspection,
        totalScore
      };
    }
  }

  return best;
}

async function fetchAssetBuffer({ assetUrl, fetchImpl, referer }) {
  try {
    const response = await fetchImpl(assetUrl, {
      headers: {
        'user-agent': 'ImageCollector/1.0',
        accept: 'image/*,*/*;q=0.8',
        referer: referer.toString()
      },
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      return null;
    }

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      return null;
    }

    return { buffer, contentType };
  } catch {
    return null;
  }
}

async function inspectLogoBuffer({ buffer, contentType, assetUrl }) {
  try {
    const metadata = await sharp(buffer, { density: 300 }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (width < 24 || height < 24) {
      return null;
    }

    let scoreBonus = Math.min(Math.round((width * height) / 12000), 90);
    if (width < 96 || height < 96) {
      scoreBonus -= 35;
    }
    if (/favicon|apple-touch-icon|mask-icon|\.ico$/i.test(assetUrl)) {
      scoreBonus -= 45;
    }
    if (Math.max(width, height) > 1500) {
      scoreBonus += 15;
    }

    return {
      width,
      height,
      hasAlpha: Boolean(metadata.hasAlpha),
      contentType,
      scoreBonus
    };
  } catch {
    return null;
  }
}

export async function buildTransparentSquareLogo({ inputBuffer, backgroundRemover }) {
  const rasterBuffer = await sharp(inputBuffer, { density: 300 }).png().toBuffer();
  const rasterMetadata = await sharp(rasterBuffer).metadata();
  let workingBuffer = rasterBuffer;
  let backgroundRemoved = Boolean(rasterMetadata.hasAlpha);

  if (!backgroundRemoved) {
    const rasterBlob = new Blob([rasterBuffer], { type: 'image/png' });
    const blob = await backgroundRemover(rasterBlob);
    workingBuffer = Buffer.from(await blob.arrayBuffer());
    backgroundRemoved = true;
  }

  const trimmedBuffer = await sharp(workingBuffer)
    .trim({ background: TRANSPARENT })
    .png()
    .toBuffer();

  const trimmedMetadata = await sharp(trimmedBuffer).metadata();
  const currentWidth = trimmedMetadata.width ?? 1;
  const currentHeight = trimmedMetadata.height ?? 1;
  const resizeTarget = Math.min(Math.max(currentWidth, currentHeight), LOGO_SQUARE_LIMIT);
  const resizedBuffer = await sharp(trimmedBuffer)
    .resize({
      width: resizeTarget,
      height: resizeTarget,
      fit: 'inside',
      withoutEnlargement: true
    })
    .png()
    .toBuffer();

  const resizedMetadata = await sharp(resizedBuffer).metadata();
  const width = resizedMetadata.width ?? 1;
  const height = resizedMetadata.height ?? 1;
  const side = Math.max(width, height);

  return {
    buffer: await sharp(resizedBuffer)
      .extend({
        top: Math.floor((side - height) / 2),
        bottom: Math.ceil((side - height) / 2),
        left: Math.floor((side - width) / 2),
        right: Math.ceil((side - width) / 2),
        background: TRANSPARENT
      })
      .png()
      .toBuffer(),
    backgroundRemoved
  };
}

async function defaultBackgroundRemover(inputImage) {
  return removeBackground(inputImage, {
    model: 'small',
    output: {
      format: 'image/png',
      type: 'foreground'
    }
  });
}

function buildLogoFileName({ pageUrl, usedFileNames }) {
  const hostname = sanitizeFileComponent(new URL(pageUrl).hostname.replace(/^www\./i, ''));
  let candidate = `${hostname}-logo.png`;
  let suffix = 2;

  while (usedFileNames.has(candidate)) {
    candidate = `${hostname}-logo-${suffix}.png`;
    suffix += 1;
  }

  usedFileNames.add(candidate);
  return candidate;
}

function sanitizeFileComponent(value) {
  return String(value ?? 'logo')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'logo';
}

function normalizeLogoCandidateUrl(rawValue, pageUrl) {
  const resolved = resolveImageUrl(rawValue, pageUrl);
  if (!resolved) {
    return null;
  }

  return normalizeImageUrlForDownload(resolved);
}

function firstSrcsetCandidate(srcset) {
  if (!srcset) {
    return '';
  }

  const firstEntry = srcset.split(',')[0]?.trim();
  return firstEntry ? firstEntry.split(/\s+/, 1)[0] : '';
}

function extractFirstCssUrl(styleValue) {
  if (!styleValue) {
    return '';
  }

  const match = String(styleValue).match(/url\((['"]?)(.*?)\1\)/i);
  return match?.[2] ?? '';
}

function extractStructuredLogoUrls(jsonText) {
  if (!jsonText?.trim()) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const found = [];

  const walk = (value) => {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (key.toLowerCase() === 'logo') {
        if (typeof nestedValue === 'string') {
          found.push(nestedValue);
          continue;
        }

        if (nestedValue && typeof nestedValue === 'object') {
          for (const nestedKey of ['url', 'contentUrl', 'image']) {
            if (typeof nestedValue[nestedKey] === 'string') {
              found.push(nestedValue[nestedKey]);
            }
          }
        }
      }

      walk(nestedValue);
    }
  };

  walk(parsed);
  return found;
}

function isHomeLikeHref(href, pageUrl) {
  if (!href) {
    return false;
  }

  if (href === '/' || href === './' || href === '#') {
    return true;
  }

  try {
    const resolved = new URL(href, pageUrl);
    return resolved.pathname === '/' || resolved.pathname === '';
  } catch {
    return false;
  }
}
