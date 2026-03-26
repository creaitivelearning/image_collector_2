import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeBrowserLaunchCandidate,
  getBrowserLaunchCandidates,
  resolveDesktopDir
} from '../src/runtime.js';

describe('resolveDesktopDir', () => {
  test('uses IMAGE_COLLECTOR_OUTPUT_DIR when provided', () => {
    assert.equal(
      resolveDesktopDir({
        env: {
          IMAGE_COLLECTOR_OUTPUT_DIR: '/tmp/image-collector-output'
        },
        homedir: '/Users/example',
        existsSync: () => false
      }),
      '/tmp/image-collector-output'
    );
  });

  test('prefers OneDrive Desktop on Windows when it exists', () => {
    const desktopPath = path.win32.join('C:\\Users\\Casey\\OneDrive', 'Desktop');

    assert.equal(
      resolveDesktopDir({
        platform: 'win32',
        env: {
          OneDrive: 'C:\\Users\\Casey\\OneDrive',
          USERPROFILE: 'C:\\Users\\Casey'
        },
        homedir: 'C:\\Users\\Casey',
        existsSync: (candidate) => candidate === desktopPath
      }),
      desktopPath
    );
  });

  test('falls back to the home directory when no Desktop folder exists', () => {
    assert.equal(
      resolveDesktopDir({
        platform: 'linux',
        homedir: '/home/casey',
        existsSync: () => false
      }),
      '/home/casey'
    );
  });
});

describe('getBrowserLaunchCandidates', () => {
  test('prefers an explicit browser override path first', () => {
    const candidates = getBrowserLaunchCandidates({
      platform: 'win32',
      env: {
        IMAGE_COLLECTOR_BROWSER_PATH: 'D:\\Apps\\Chrome\\chrome.exe'
      },
      existsSync: () => false
    });

    assert.deepEqual(candidates.slice(0, 3), [
      { executablePath: 'D:\\Apps\\Chrome\\chrome.exe' },
      { channel: 'chrome' },
      { channel: 'msedge' }
    ]);
  });

  test('includes detected Windows Chrome and Edge executables', () => {
    const chromePath = path.win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
    const edgePath = path.win32.join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const candidates = getBrowserLaunchCandidates({
      platform: 'win32',
      env: {
        PROGRAMFILES: 'C:\\Program Files',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\Casey\\AppData\\Local'
      },
      existsSync: (candidate) => candidate === chromePath || candidate === edgePath
    });

    assert.deepEqual(candidates.slice(0, 4), [
      { executablePath: chromePath },
      { executablePath: edgePath },
      { channel: 'chrome' },
      { channel: 'msedge' }
    ]);
  });

  test('describes launch candidates clearly', () => {
    assert.equal(
      describeBrowserLaunchCandidate({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }),
      'path:/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    );
    assert.equal(describeBrowserLaunchCandidate({ channel: 'chrome' }), 'channel:chrome');
    assert.equal(describeBrowserLaunchCandidate({}), 'playwright-default');
  });
});
