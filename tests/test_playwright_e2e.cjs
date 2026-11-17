// End-to-end Playwright tests: Mode A (file://) and Mode B (local server).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function resolvePlaywright() {
  for (const c of [
    'playwright',
    '/home/jiyoung/.local/lib/node_modules/@playwright/mcp/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
  ]) {
    try { return require(c); } catch (_) {}
  }
  throw new Error('Could not resolve playwright');
}

const { chromium } = resolvePlaywright();

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LegendOfMortalSaveEditor-v1.0.html');
const CLI = path.join(ROOT, 'lom_editor.py');

const HANZI = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const KANA = /[\u3040-\u30FF]/;

const errors = [];
function fail(msg) { errors.push(msg); console.error('FAIL: ' + msg); }
function ok(msg) { console.log('OK: ' + msg); }

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, env) {
  const r = spawnSync('python3', [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf8',
    timeout: 60000,
  });
  return r;
}

function validateFile(filePath) {
  const r = runCli(['validate', filePath]);
  return r.status === 0;
}

async function waitForServerUrl(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server url timeout: ' + buf)), timeoutMs);
    const check = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited early code=' + code + ' out=' + buf));
    });
  });
}

// ---------- Mode A ----------
async function modeA(browser) {
  console.log('\n=== MODE A: file:// ===');
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const external = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('file://') || u.startsWith('data:') || u.startsWith('blob:')) return;
    external.push(u);
  });

  await page.goto('file://' + DIST, { waitUntil: 'load' });
  await page.waitForTimeout(500);

  if (pageErrors.length) fail('A: pageerror: ' + pageErrors.join(' | ')); else ok('A: no pageerror');
  if (consoleErrors.length) fail('A: console errors: ' + consoleErrors.join(' | ')); else ok('A: no console errors');
  if (external.length) fail('A: external requests: ' + external.join(', ')); else ok('A: no external requests');

  await page.click('#btn-load-demo');
  await page.waitForFunction(() => {
    const k = document.querySelector('#kind-badge');
    const s = document.querySelector('#status-badge');
    return k && k.textContent.includes('일반 세이브') && s && s.textContent.includes('불러옴');
  }, { timeout: 8000 }).catch((e) => fail('A: demo load timeout: ' + e.message));
  ok('A: demo loaded');

  const bodyText = await page.evaluate(() => document.body.innerText);
  const hanziHits = bodyText.match(HANZI) || [];
  const kanaHits = bodyText.match(KANA) || [];
  if (hanziHits.length) fail('A: ' + hanziHits.length + ' Hanzi in body: ' + hanziHits.slice(0, 5).join(''));
  else ok('A: zero Hanzi');
  if (kanaHits.length) fail('A: ' + kanaHits.length + ' Kana in body: ' + kanaHits.slice(0, 5).join(''));
  else ok('A: zero Kana');

  const tabs = [
    ['#tab-stats', '#panel-stats'],
    ['#tab-relationships', '#panel-relationships'],
    ['#tab-books', '#panel-books'],
    ['#tab-inventory', '#panel-inventory'],
    ['#tab-flags', '#panel-flags'],
    ['#tab-library', '#panel-library'],
    ['#tab-diff', '#panel-diff'],
  ];
  for (const [tab, panel] of tabs) {
    await page.click(tab);
    const active = await page.$eval(panel, (el) => el.classList.contains('active'))
      .catch(() => false);
    if (!active) fail('A: panel ' + panel + ' not active after clicking ' + tab);
    else ok('A: tab ' + tab + ' active');
  }

  // preset
  await page.click('#tab-summary');
  await page.click('[data-preset="rich_start"]');
  await page.waitForTimeout(200);
  await page.click('#tab-diff');
  const dirtyHidden = await page.$eval('#dirty-badge', (el) => el.classList.contains('hidden'))
    .catch(() => true);
  if (dirtyHidden) fail('A: #dirty-badge still hidden after preset'); else ok('A: #dirty-badge visible');

  const diffCount = await page.$eval('#diff-count', (el) => parseInt(el.textContent || '0', 10))
    .catch(() => 0);
  if (!(diffCount > 0)) fail('A: #diff-count not > 0 (got ' + diffCount + ')'); else ok('A: diff-count=' + diffCount);

  const validationOk = await page.$eval('#validation-box', (el) => el.classList.contains('ok'))
    .catch(() => false);
  if (!validationOk) fail('A: #validation-box not .ok'); else ok('A: validation ok');

  // download on save
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.click('#btn-save');
  const download = await downloadPromise;
  if (!download) {
    fail('A: no download event on save');
  } else {
    const tmp = mkTmp('lomdl_');
    const out = path.join(tmp, 'Save_dl.dat');
    await download.saveAs(out);
    ok('A: download saved to ' + out);
    const r = runCli(['inspect', out, '--json']);
    if (r.status !== 0) {
      fail('A: inspect failed on downloaded file: ' + r.stderr);
    } else {
      try {
        const j = JSON.parse(r.stdout);
        const money = (function find(d) {
          if (Array.isArray(d)) { for (const v of d) { const m = find(v); if (m !== undefined) return m; } }
          else if (d && typeof d === 'object') {
            if (typeof d.money === 'number') return d.money;
            for (const k of Object.keys(d)) { const m = find(d[k]); if (m !== undefined) return m; }
          }
          return undefined;
        })(j);
        if (money !== 99999) fail('A: money expected 99999, got ' + money);
        else ok('A: downloaded save money=99999');
      } catch (e) {
        fail('A: inspect JSON parse error: ' + e.message);
      }
    }
    if (!validateFile(out)) fail('A: validate rejected downloaded save');
    else ok('A: downloaded save validates');
  }

  // universe + unlock-all
  await page.click('#btn-load-demo-univ');
  await page.waitForTimeout(400);
  await page.click('#tab-library');
  await page.click('#btn-unlock-all-lib');
  await page.waitForTimeout(300);
  const endingText = await page.$eval('[data-lib-cat="ending"]', (el) => el.textContent || '').catch(() => '0 / 0');
  const unlocked = parseInt((endingText.split('/')[0] || '0').trim(), 10);
  if (!(unlocked > 0)) fail('A: ending library unlocked count not > 0 (' + endingText + ')');
  else ok('A: ending library unlocked=' + endingText);

  await ctx.close();
}

// ---------- Mode B ----------
async function modeB(browser) {
  console.log('\n=== MODE B: serve ===');
  const tmp = mkTmp('lomsrv_');
  const demoR = runCli(['demo', '--out-dir', tmp]);
  if (demoR.status !== 0) {
    fail('B: demo generation failed: ' + demoR.stderr);
    return;
  }
  const realSrc = '/tmp/lom_real_saves_ro/Save_001.dat';
  if (fs.existsSync(realSrc)) {
    try { fs.copyFileSync(realSrc, path.join(tmp, 'Save_002.dat')); ok('B: copied real save Save_002.dat'); }
    catch (e) { console.warn('B: could not copy real save: ' + e.message); }
  }

  const child = spawn('python3', [
    CLI, 'serve', '--port', '0', '--no-browser', '--root', tmp,
  ], { cwd: ROOT, env: { ...process.env } });

  let serverUrl;
  try {
    serverUrl = await waitForServerUrl(child);
    ok('B: server at ' + serverUrl);
  } catch (e) {
    fail('B: ' + e.message);
    try { child.kill('SIGKILL'); } catch (_) {}
    return;
  }

  const ctx = await browser.newContext({ acceptDownloads: false });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  try {
    await page.goto(serverUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const sel = document.querySelector('#slot-select');
      const badge = document.querySelector('#status-badge');
      return sel && sel.options && sel.options.length >= 2 &&
             badge && badge.textContent.includes('불러옴');
    }, { timeout: 12000 }).catch((e) => fail('B: slot load timeout: ' + e.message));
    const slotCount = await page.$eval('#slot-select', (el) => el.options.length).catch(() => 0);
    if (slotCount < 2) fail('B: expected >=2 slots, got ' + slotCount);
    else ok('B: slot options=' + slotCount);

    const beforeFiles = fs.readdirSync(tmp);
    const beforeBackups = beforeFiles.filter((n) => n.includes('.backup-') && n.endsWith('.bak')).length;
    const trackedFile = path.join(tmp, 'Save_001.dat');
    await page.selectOption('#slot-select', trackedFile);
    await page.waitForFunction(() => {
      const k = document.querySelector('#kind-badge');
      return k && k.textContent.includes('일반 세이브');
    }, { timeout: 8000 });
    const beforeBytes = fs.readFileSync(trackedFile);

    await page.click('[data-preset="rich_start"]');
    await page.waitForTimeout(200);

    const saveBtn = await page.$('#btn-save');
    if (!saveBtn) fail('B: #btn-save missing');
    else {
      await saveBtn.click();
      await page.waitForFunction(() => {
        const t = document.querySelector('.toast');
        const s = document.querySelector('#status-badge');
        const okText = (t && t.textContent && t.textContent.includes('저장 완료')) ||
                       (s && s.textContent && s.textContent.includes('저장 완료'));
        return okText;
      }, { timeout: 10000 }).catch((e) => fail('B: save confirmation timeout: ' + e.message));
      ok('B: save toast/status observed');

      const afterFiles = fs.readdirSync(tmp);
      const afterBackups = afterFiles.filter((n) => n.includes('.backup-') && n.endsWith('.bak')).length;
      if (afterBackups <= beforeBackups) fail('B: no new .backup-*.bak file');
      else ok('B: backup created (' + afterBackups + ')');

      const afterBytes = fs.readFileSync(trackedFile);
      if (Buffer.compare(beforeBytes, afterBytes) === 0) {
        fail('B: Save_001.dat did not change after save');
      } else {
        ok('B: Save_001.dat changed');
      }
      if (!validateFile(trackedFile)) fail("B: validate failed after save");
      else ok("B: saved file validated by lom_editor");
    }
  } finally {
    try { child.kill("SIGTERM"); } catch (_) {}
    await ctx.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async function main() {
  const { chromium } = resolvePlaywright();
  const exePath = [
    path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, executablePath: exePath });
  try {
    await modeA(browser);
    await modeB(browser);
  } finally {
    await browser.close();
  }
  console.log("\n[요약] 실패=" + errors.length);
  process.exit(errors.length > 0 ? 1 : 0);
})();
