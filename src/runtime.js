import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BROWSER_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check'
];

export const DEFAULT_BROWSER_CONTEXT_OPTIONS = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 960 }
};

export function resolveDesktopDir({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync
} = {}) {
  const pathImpl = platform === 'win32' ? path.win32 : path;
  const override = normalizeNonEmpty(env.IMAGE_COLLECTOR_OUTPUT_DIR);
  if (override) {
    return override;
  }

  const candidates = platform === 'win32'
    ? [
        normalizeNonEmpty(env.OneDrive) ? pathImpl.join(env.OneDrive, 'Desktop') : '',
        normalizeNonEmpty(env.USERPROFILE) ? pathImpl.join(env.USERPROFILE, 'Desktop') : '',
        normalizeNonEmpty(env.HOMEDRIVE) && normalizeNonEmpty(env.HOMEPATH)
          ? pathImpl.join(`${env.HOMEDRIVE}${env.HOMEPATH}`, 'Desktop')
          : '',
        pathImpl.join(homedir, 'Desktop'),
        homedir
      ]
    : [
        pathImpl.join(homedir, 'Desktop'),
        homedir
      ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return homedir;
}

export function getBrowserLaunchCandidates({
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync
} = {}) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (candidate) => {
    const key = describeBrowserLaunchCandidate(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  };

  const overridePath = normalizeNonEmpty(env.IMAGE_COLLECTOR_BROWSER_PATH) || normalizeNonEmpty(env.BROWSER_PATH);
  if (overridePath) {
    addCandidate({ executablePath: overridePath });
  }

  for (const executablePath of getPlatformBrowserPaths({ platform, env })) {
    if (existsSync(executablePath)) {
      addCandidate({ executablePath });
    }
  }

  for (const channel of ['chrome', 'msedge']) {
    addCandidate({ channel });
  }

  addCandidate({});

  return candidates;
}

export function describeBrowserLaunchCandidate(candidate) {
  if (candidate.executablePath) {
    return `path:${candidate.executablePath}`;
  }

  if (candidate.channel) {
    return `channel:${candidate.channel}`;
  }

  return 'playwright-default';
}

export async function launchFallbackBrowser(chromium, options = {}) {
  const attempted = [];
  let lastError;

  for (const launchOptions of getBrowserLaunchCandidates(options)) {
    try {
      return await chromium.launch({
        ...launchOptions,
        headless: true,
        args: BROWSER_LAUNCH_ARGS
      });
    } catch (error) {
      attempted.push(describeBrowserLaunchCandidate(launchOptions));
      lastError = error;
    }
  }

  const attemptSummary = attempted.length > 0 ? ` Attempted ${attempted.join(', ')}.` : '';
  const lastErrorSummary = lastError?.message ? ` Last error: ${lastError.message}` : '';

  throw new Error(
    `No supported Chromium browser was found for the Image Collector 2 fallback. Install Google Chrome or Microsoft Edge, or set IMAGE_COLLECTOR_BROWSER_PATH.${attemptSummary}${lastErrorSummary}`
  );
}

function getPlatformBrowserPaths({ platform, env }) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
  }

  if (platform === 'win32') {
    return compact([
      normalizeNonEmpty(env.PROGRAMFILES) ? path.win32.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      normalizeNonEmpty(env['PROGRAMFILES(X86)']) ? path.win32.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      normalizeNonEmpty(env.LOCALAPPDATA) ? path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      normalizeNonEmpty(env.PROGRAMFILES) ? path.win32.join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
      normalizeNonEmpty(env['PROGRAMFILES(X86)']) ? path.win32.join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
      normalizeNonEmpty(env.LOCALAPPDATA) ? path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : ''
    ]);
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium'
  ];
}

function normalizeNonEmpty(value) {
  const normalized = String(value ?? '').trim();
  return normalized || '';
}

function compact(values) {
  return values.filter(Boolean);
}
