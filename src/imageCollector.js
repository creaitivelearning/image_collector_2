import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as cheerio from 'cheerio';
import { getDomain } from 'tldts';

import {
  DEFAULT_BROWSER_CONTEXT_OPTIONS,
  launchFallbackBrowser,
  resolveDesktopDir
} from './runtime.js';

export const MAX_IMAGES = 75;
export const DEFAULT_MAX_URLS = 6;
export const LOGO_MAX_URLS = 8;

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];
const GOOGLE_HOST_PATTERN = /(^|\.)google\./i;
const IMAGE_EXTENSION_BY_TYPE = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/svg+xml', '.svg'],
  ['image/avif', '.avif'],
  ['image/bmp', '.bmp'],
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
  ['image/tiff', '.tiff'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif']
]);
const KNOWN_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
  '.heic',
  '.heif'
]);

export function validateRunInputs(urls, { maxUrls = DEFAULT_MAX_URLS } = {}) {
  if (!Array.isArray(urls)) {
    throw new Error(`Provide up to ${maxUrls} URLs.`);
  }

  const normalizedUrls = urls
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  if (normalizedUrls.length === 0) {
    throw new Error('Enter at least one URL.');
  }

  if (normalizedUrls.length > maxUrls) {
    throw new Error(`A maximum of ${maxUrls} URLs is supported.`);
  }

  const parsedUrls = normalizedUrls.map((value) => {
    const normalizedValue = normalizeUserUrl(value);
    let parsed;

    try {
      parsed = new URL(normalizedValue);
    } catch {
      throw new Error(`Invalid URL: ${value}`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Only http and https URLs are supported: ${value}`);
    }

    return parsed;
  });

  const sourceDomains = Array.from(new Set(parsedUrls.map((parsed) => getRegistrableDomain(parsed))));

  return {
    domain: sourceDomains.length === 1 ? sourceDomains[0] : 'mixed-domains',
    parsedUrls,
    normalizedUrls: parsedUrls.map((parsed) => parsed.toString()),
    sourceDomains
  };
}

export function normalizeUserUrl(value) {
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) {
    return value;
  }

  return `https://${value}`;
}

export function getRegistrableDomain(inputUrl) {
  const hostname = inputUrl instanceof URL ? inputUrl.hostname : new URL(inputUrl).hostname;
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

export function extractImageCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const candidates = [];
  let skippedInvalid = 0;

  $('meta[property="og:image"], img, picture source').each((_, element) => {
    const tagName = (element.tagName ?? element.name ?? '').toLowerCase();
    const wrapped = $(element);

    if (tagName === 'meta') {
      const value = wrapped.attr('content');
      if (value) {
        const resolved = resolveImageUrl(value, pageUrl);
        if (resolved) {
          candidates.push(resolved);
        } else {
          skippedInvalid += 1;
        }
      }
      return;
    }

    if (tagName === 'img') {
      const imageSources = [
        wrapped.attr('data-src'),
        wrapped.attr('data-original'),
        wrapped.attr('data-lazy-src'),
        wrapped.attr('src'),
        firstSrcsetCandidate(wrapped.attr('data-srcset')),
        firstSrcsetCandidate(wrapped.attr('srcset'))
      ];

      for (const imageSource of imageSources) {
        if (!imageSource) {
          continue;
        }

        const resolved = resolveImageUrl(imageSource, pageUrl);
        if (resolved) {
          candidates.push(resolved);
        } else {
          skippedInvalid += 1;
        }
      }
      return;
    }

    if (tagName === 'source' && wrapped.closest('picture').length > 0) {
      const sourceCandidate = firstSrcsetCandidate(wrapped.attr('data-srcset')) ?? firstSrcsetCandidate(wrapped.attr('srcset'));
      if (sourceCandidate) {
        const resolved = resolveImageUrl(sourceCandidate, pageUrl);
        if (resolved) {
          candidates.push(resolved);
        } else {
          skippedInvalid += 1;
        }
      }
    }
  });

  return { candidates, skippedInvalid };
}

export function firstSrcsetCandidate(srcset) {
  if (!srcset) {
    return null;
  }

  for (const candidate of srcset.split(',')) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }

    const [url] = trimmed.split(/\s+/, 1);
    if (url) {
      return url;
    }
  }

  return null;
}

export function resolveImageUrl(rawValue, pageUrl) {
  const trimmed = normalizeRawImageValue(rawValue);
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    return null;
  }

  try {
    const resolved = new URL(trimmed, pageUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) {
      return null;
    }

    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

export function normalizeRawImageValue(rawValue) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const pathLikePortion = trimmed.split(/[?#]/, 1)[0];
  const schemeMatches = [...pathLikePortion.matchAll(/https?:\/\//g)];
  if (schemeMatches.length >= 2) {
    return trimmed.slice(schemeMatches.at(-1).index);
  }

  return trimmed;
}

export function shouldUseBrowserFallback(pageUrl, html, candidates = []) {
  const targetUrl = pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
  if (GOOGLE_HOST_PATTERN.test(targetUrl.hostname)) {
    return true;
  }

  if (candidates.length > 0) {
    return false;
  }

  const normalizedHtml = String(html ?? '').toLowerCase();
  return normalizedHtml.includes('/httpservice/retry/enablejs')
    || normalizedHtml.includes("if you're having trouble accessing google search");
}

export function normalizeImageUrlForDownload(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname.startsWith('encrypted-tbn')) {
      return null;
    }

    if (hostname.endsWith('googleusercontent.com')) {
      return rewriteGoogleusercontentImageUrl(parsed);
    }

    return parsed.toString();
  } catch {
    return imageUrl;
  }
}

function rewriteGoogleusercontentImageUrl(parsedUrl) {
  const rewritten = new URL(parsedUrl.toString());

  if (rewritten.pathname.includes('/s')) {
    rewritten.pathname = rewritten.pathname.replace(/\/s[^/]+(?=\/[^/]+$)/, '/s0');
  }

  if (/=[^/?#=]+$/i.test(rewritten.pathname)) {
    rewritten.pathname = rewritten.pathname.replace(/=[^/?#=]+$/i, '=s0');
  }

  return rewritten.toString();
}

export async function collectImages({
  urls,
  desktopDir = resolveDesktopDir(),
  fetchImpl = globalThis.fetch,
  maxImages = MAX_IMAGES,
  now = new Date(),
  browserExtractor = extractBrowserImageCandidates
}) {
  const { parsedUrls, domain, sourceDomains } = validateRunInputs(urls);
  const timestamp = formatTimestamp(now);
  const outputPath = path.join(desktopDir, domain, timestamp);
  const multipleDomains = sourceDomains.length > 1;

  await mkdir(outputPath, { recursive: true });

  const result = {
    domain,
    sourceDomains,
    outputPath,
    pagesScanned: 0,
    imagesSaved: 0,
    skippedDuplicates: 0,
    skippedInvalid: 0,
    errors: [],
    successfulPages: 0
  };

  const seenImageUrls = new Set();

  for (const pageUrl of parsedUrls) {
    if (result.imagesSaved >= maxImages) {
      break;
    }

    result.pagesScanned += 1;

    let pageResponse;
    try {
      pageResponse = await fetchImpl(pageUrl, {
        headers: {
          'user-agent': 'ImageCollector/1.0',
          accept: 'text/html,application/xhtml+xml'
        },
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      result.errors.push(`Page fetch failed for ${pageUrl}: ${error.message}`);
      continue;
    }

    if (!pageResponse.ok) {
      result.errors.push(`Page fetch failed for ${pageUrl}: HTTP ${pageResponse.status}`);
      continue;
    }

    const pageContentType = getMimeType(pageResponse.headers.get('content-type'));
    if (pageContentType && !HTML_CONTENT_TYPES.includes(pageContentType)) {
      result.errors.push(`Skipped ${pageUrl}: response was ${pageContentType}`);
      continue;
    }

    const html = await pageResponse.text();
    result.successfulPages += 1;

    const { candidates: initialCandidates, skippedInvalid } = extractImageCandidates(html, pageUrl);
    result.skippedInvalid += skippedInvalid;
    let candidates = initialCandidates;

    if (shouldUseBrowserFallback(pageUrl, html, initialCandidates)) {
      try {
        const browserCandidates = await browserExtractor(pageUrl);
        if (browserCandidates.length > 0) {
          candidates = [...browserCandidates, ...initialCandidates];
        }
      } catch (error) {
        result.errors.push(`Browser rendering failed for ${pageUrl}: ${error.message}`);
      }
    }

    for (const imageUrl of candidates) {
      if (result.imagesSaved >= maxImages) {
        break;
      }

      const normalizedDownloadUrl = normalizeImageUrlForDownload(imageUrl);
      if (!normalizedDownloadUrl) {
        result.skippedInvalid += 1;
        continue;
      }

      if (seenImageUrls.has(normalizedDownloadUrl)) {
        result.skippedDuplicates += 1;
        continue;
      }

      seenImageUrls.add(normalizedDownloadUrl);

      const downloadResult = await downloadImage({
        imageUrl: normalizedDownloadUrl,
        fetchImpl,
        outputPath,
        fileIndex: result.imagesSaved + 1,
        pageUrl,
        multipleDomains
      });

      if (downloadResult.ok) {
        result.imagesSaved += 1;
        continue;
      }

      if (downloadResult.reason === 'invalid') {
        result.skippedInvalid += 1;
      } else {
        result.errors.push(downloadResult.error);
      }
    }
  }

  return result;
}

export function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
}

export function getMimeType(contentTypeHeader) {
  return String(contentTypeHeader ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

export function inferExtension(imageUrl, contentTypeHeader) {
  const contentType = getMimeType(contentTypeHeader);
  if (IMAGE_EXTENSION_BY_TYPE.has(contentType)) {
    return IMAGE_EXTENSION_BY_TYPE.get(contentType);
  }

  try {
    const extension = path.extname(new URL(imageUrl).pathname).toLowerCase();
    if (KNOWN_IMAGE_EXTENSIONS.has(extension)) {
      return extension === '.jpeg' ? '.jpg' : extension;
    }
  } catch {
    return '.jpg';
  }

  return '.jpg';
}

export async function extractBrowserImageCandidates(pageUrl) {
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

    await page.waitForTimeout(3_000);
    await maybePivotGoogleSearchToMapsPlace(page);
    await maybeOpenGoogleMapsPhotoView(page);
    await page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight * 0.5, behavior: 'auto' });
    });
    await page.waitForTimeout(1_500);

    const rawCandidates = await collectBrowserRawCandidates(page);

    await context.close();

    return Array.from(new Set(
      rawCandidates
        .map((candidate) => resolveImageUrl(candidate, pageUrlString))
        .filter(Boolean)
        .filter((candidate) => !isBrowserUiAsset(candidate))
    ));
  } finally {
    await browser.close();
  }
}

async function maybePivotGoogleSearchToMapsPlace(page) {
  const currentUrl = page.url();
  if (!isGoogleSearchUrl(currentUrl)) {
    return;
  }

  const mapsPlaceUrl = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a'));
    const preferred = anchors.find((anchor) => /https:\/\/www\.google\.com\/maps\/place\//i.test(anchor.href));
    return preferred?.href || '';
  });

  if (!mapsPlaceUrl) {
    return;
  }

  await page.goto(mapsPlaceUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000
  });
  await page.waitForTimeout(5_000);
}

async function maybeOpenGoogleMapsPhotoView(page) {
  if (!isGoogleMapsUrl(page.url())) {
    return;
  }

  const clicked = await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll('button, a, div[role="button"]')).find((element) => {
      const text = (element.innerText || element.textContent || '').trim();
      return /see photos/i.test(text);
    });

    if (!target) {
      return false;
    }

    target.click();
    return true;
  });

  if (clicked) {
    await page.waitForTimeout(5_000);
  }
}

async function collectBrowserRawCandidates(page) {
  return page.evaluate(() => {
    const values = [];
    const add = (value) => {
      if (typeof value === 'string' && value.trim()) {
        values.push(value.trim());
      }
    };
    const addMatches = (value) => {
      if (!value) {
        return;
      }

      const matches = String(value).match(/https?:[^"')\s]+/g) || [];
      for (const match of matches) {
        add(match);
      }
    };
    const firstSrcsetCandidate = (srcset) => {
      if (!srcset) {
        return '';
      }

      const firstEntry = srcset.split(',')[0]?.trim();
      return firstEntry ? firstEntry.split(/\s+/, 1)[0] : '';
    };

    document.querySelectorAll('meta[property="og:image"], img, picture source').forEach((element) => {
      const tagName = element.tagName.toLowerCase();

      if (tagName === 'meta') {
        add(element.getAttribute('content'));
        return;
      }

      if (tagName === 'img') {
        add(element.currentSrc);
        add(element.getAttribute('data-src'));
        add(element.getAttribute('data-original'));
        add(element.getAttribute('data-lazy-src'));
        add(element.getAttribute('src'));
        add(firstSrcsetCandidate(element.getAttribute('data-srcset')));
        add(firstSrcsetCandidate(element.getAttribute('srcset')));
        return;
      }

      add(firstSrcsetCandidate(element.getAttribute('data-srcset')));
      add(firstSrcsetCandidate(element.getAttribute('srcset')));
    });

    document.querySelectorAll('*').forEach((element) => {
      add(element.getAttribute?.('data-src'));
      add(element.getAttribute?.('data-url'));
      addMatches(element.getAttribute?.('style'));

      const backgroundImage = getComputedStyle(element).backgroundImage;
      if (backgroundImage && backgroundImage !== 'none') {
        addMatches(backgroundImage);
      }
    });

    return values;
  });
}

function isGoogleSearchUrl(value) {
  try {
    const parsed = new URL(value);
    return GOOGLE_HOST_PATTERN.test(parsed.hostname) && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

function isGoogleMapsUrl(value) {
  try {
    const parsed = new URL(value);
    return GOOGLE_HOST_PATTERN.test(parsed.hostname) && parsed.pathname.startsWith('/maps');
  } catch {
    return false;
  }
}

function isBrowserUiAsset(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (hostname.startsWith('encrypted-tbn')) {
      return true;
    }

    if (hostname === 'maps.gstatic.com') {
      return true;
    }

    if (pathname.includes('favicon')) {
      return true;
    }

    if ((hostname === 'www.google.com' || hostname === 'google.com') && pathname.startsWith('/images/branding/mapslogo')) {
      return true;
    }

    if (hostname.endsWith('gstatic.com') && (pathname.includes('/images/icons/') || pathname.includes('/kpui/social/'))) {
      return true;
    }

    if ((hostname === 'www.google.com' || hostname === 'google.com') && pathname.startsWith('/maps/vt')) {
      return true;
    }

    if (hostname.endsWith('googleusercontent.com') && pathname.startsWith('/a-/')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function buildFileName({ fileIndex, imageUrl, contentType, multipleDomains }) {
  const fileExtension = inferExtension(imageUrl, contentType);
  const domainLabel = multipleDomains ? `-${sanitizeFileComponent(getFilenameDomainLabel(imageUrl))}` : '';
  return `${String(fileIndex).padStart(3, '0')}${domainLabel}${fileExtension}`;
}

function getFilenameDomainLabel(imageUrl) {
  try {
    return new URL(imageUrl).hostname.replace(/^www\./i, '');
  } catch {
    return 'image';
  }
}

function sanitizeFileComponent(value) {
  return String(value ?? 'image')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'image';
}

async function downloadImage({ imageUrl, fetchImpl, outputPath, fileIndex, pageUrl, multipleDomains }) {
  let response;

  try {
    response = await fetchImpl(imageUrl, {
      headers: {
        'user-agent': 'ImageCollector/1.0',
        accept: 'image/*,*/*;q=0.8',
        referer: pageUrl.toString()
      },
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      error: `Image download failed for ${imageUrl}: ${error.message}`
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: 'error',
      error: `Image download failed for ${imageUrl}: HTTP ${response.status}`
    };
  }

  const contentType = getMimeType(response.headers.get('content-type'));
  if (contentType && !contentType.startsWith('image/')) {
    return {
      ok: false,
      reason: 'invalid',
      error: `Skipped ${imageUrl}: response was ${contentType}`
    };
  }

  const fileName = buildFileName({
    fileIndex,
    imageUrl,
    contentType,
    multipleDomains
  });
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.byteLength === 0) {
    return {
      ok: false,
      reason: 'invalid',
      error: `Skipped ${imageUrl}: empty response body`
    };
  }

  await writeFile(path.join(outputPath, fileName), buffer);

  return {
    ok: true,
    fileName
  };
}
