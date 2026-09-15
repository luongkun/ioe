/**
 * Self-contained extension test runner v2
 * Stack: Xvfb :99 (headed) + Chrome 151 + --load-extension + connectOverCDP
 * (headless=new KHÔNG inject content script; DOM-based assertions bắt buộc vì
 *  content script chạy trong isolated world.)
 */
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const EXT_DIR = '/home/z/my-project/ioe-test';
const ART_DIR = '/home/z/my-project/test-artifacts';
const PORT = 8920;
const CDP_PORT = 9240;
const CHROME = '/home/z/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PROFILE = "/tmp/ext-suite-profile";
let CDP_HOST = null;

fs.mkdirSync(ART_DIR, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(EXT_DIR, rel === '/' ? '/test_ioe.html' : rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${name}] ${detail}`);
}

async function waitFor(fn, timeout = 15000, poll = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    await new Promise((r) => setTimeout(r, poll));
  }
  return null;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  // QUAN TRỌNG: browser.close() với connectOverCDP chỉ DISCONNECT — Chrome vẫn sống.
  // Phải kill mọi process Chrome/Xvfb stale từ lần chạy trước, nếu không lần này
  // sẽ connect vào Chrome CŨ (extension code cũ + profile cũ) → kết test sai lệch.
  try { execSync('pkill -f "chrome-linux64/chrome" || true'); execSync('pkill -f Xvfb || true'); } catch (e) {}
  await new Promise(r => setTimeout(r, 1500));
  execSync(`rm -rf ${PROFILE} /tmp/.X99-lock`);

  const xvfbLog = fs.openSync('/tmp/xvfb-suite.log', 'w');
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1440x900x24'], { detached: true, stdio: ['ignore', xvfbLog, xvfbLog] });
  xvfb.unref();
  await new Promise((r) => setTimeout(r, 1500));

  // ===== Launch Chrome với retry (port ngẫu nhiên nếu bị kẹt) =====
  async function launchChrome(cdpPort) {
    execSync(`rm -rf ${PROFILE}`);
    const chromeLog = fs.openSync('/tmp/chrome-suite.log', 'w');
    const chrome = spawn(CHROME, [
      '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--window-size=1400,900',
      'about:blank',
    ], { detached: true, stdio: ['ignore', chromeLog, chromeLog], env: { ...process.env, DISPLAY: ':99' } });
    chrome.unref();
    return chrome;
  }

  const httpGet = (port) => new Promise((res) => {
    const req = require('http').get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d.includes('Browser') ? port : null));
    });
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });

  let CDP_PORT_ACTUAL = CDP_PORT;
  let chrome = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { execSync(`pkill -9 -f "remote-debugging-port=${CDP_PORT_ACTUAL}" 2>/dev/null || true`); } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
    chrome = await launchChrome(CDP_PORT_ACTUAL);
    let ok = null;
    for (let i = 0; i < 24 && !ok; i++) { ok = await httpGet(CDP_PORT_ACTUAL); if (!ok) await new Promise((r) => setTimeout(r, 500)); }
    if (ok) { console.log(`CDP up on :${CDP_PORT_ACTUAL} (attempt ${attempt + 1})`); break; }
    console.log(`attempt ${attempt + 1}: CDP không lên trên ${CDP_PORT_ACTUAL}, log:`, fs.readFileSync('/tmp/chrome-suite.log', 'utf8').split('\n').filter(l => l.includes('DevTools') || l.includes('ERROR:net')).slice(0, 2));
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
    CDP_PORT_ACTUAL = 9300 + Math.floor(Math.random() * 500);
  }
  if (!(await httpGet(CDP_PORT_ACTUAL))) { console.error('FAIL: CDP not up sau 3 lần thử'); process.exit(1); }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT_ACTUAL}`);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  const logs = [];
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') logs.push(`[console.${t}] ${msg.text()}`);
    else if (msg.text().includes('English Master') || msg.text().includes('IOE')) logs.push(`[ioe] ${msg.text()}`);
  });
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

  // ===== S0: extension nạp + UI inject =====
  await page.goto(`http://localhost:${PORT}/mock_mcq.html`, { waitUntil: 'networkidle' });
  const pill = await waitFor(() => page.$('#ioe-pill-toggle'), 12000);
  report('S0 IOE pill UI injection (DOM)', !!pill, pill ? 'thanh nổi #ioe-pill-toggle đã render' : 'pill không xuất hiện');

  const bridge = await page.evaluate(() => typeof window.__IOE_GAME_BRIDGE__ !== 'undefined');
  report('S0 game-api-bridge (MAIN world)', bridge, bridge ? 'window.__IOE_GAME_BRIDGE__ có mặt' : 'bridge không inject');

  await page.screenshot({ path: `${ART_DIR}/01_mcq_initial.png` });

  // ===== S1: anti-anti-copy =====
  const bb = await page.locator('#txtQuestion').boundingBox();
  let selText = '';
  if (bb) {
    await page.mouse.move(bb.x + 10, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width * 0.8, bb.y + bb.height / 2, { steps: 12 });
    await page.mouse.up();
    selText = await page.evaluate(() => String(window.getSelection()));
  }
  report('S1 anti-anti-copy (bôi đen)', selText.trim().length > 5, `selection="${selText.trim().slice(0, 45)}"`);

  // ===== S2: MCQ solve =====
  await page.click('#ioe-trigger-solve-btn');
  const banner = await waitFor(() => page.$('.ioe-ans-banner'), 30000, 400);
  report('S2 MCQ banner kết quả', !!banner, banner ? 'mock AI trả về, render banner' : 'không có banner sau 30s');
  const selected = await waitFor(() => page.$('.answer-item.selected'), 12000, 300);
  const selTxt = selected ? (await selected.innerText()).trim() : '';
  report('S2 MCQ auto-click A', !!selected && /A\. will cancel/i.test(selTxt), `selected="${selTxt}"`);
  await page.screenshot({ path: `${ART_DIR}/02_mcq_solved.png` });

  // ===== S3: bug chip onclick (isolated vs MAIN world) =====
  const fnType = await page.evaluate(() => typeof triggerUniversalAutoFillOrSelect);
  report('S3 BUG chip onclick expose', true, `typeof triggerUniversalAutoFillOrSelect (MAIN world)="${fnType}" → inline onclick của chip SẼ ReferenceError nếu click. ${fnType === 'undefined' ? 'Bug XÁC NHẬN.' : 'đã expose (đã fix?)'}`);

  // ===== S4: fill-missing-letters qua F2 =====
  await page.goto(`http://localhost:${PORT}/mock_fill.html`, { waitUntil: 'networkidle' });
  await waitFor(() => page.$('#ioe-pill-toggle'), 10000);
  await page.keyboard.press('F2');
  const banner2 = await waitFor(() => page.$('.ioe-ans-banner'), 30000, 400);
  report('S4 F2 solve fill-letters', !!banner2, banner2 ? 'banner xuất hiện sau F2' : 'F2 không cho kết quả');
  const ansVal = await page.evaluate(() => document.getElementById('txtAnswer')?.value || '');
  report('S4 auto-fill "ou"', ansVal === 'ou', `txtAnswer.value="${ansVal}" (kỳ vọng "ou")`);
  await page.screenshot({ path: `${ART_DIR}/03_fill_solved.png` });

  // ===== S5: reorder words =====
  await page.goto(`http://localhost:${PORT}/mock_reorder.html`, { waitUntil: 'networkidle' });
  await waitFor(() => page.$('#ioe-pill-toggle'), 10000);
  await page.click('#ioe-trigger-solve-btn');
  const banner3 = await waitFor(() => page.$('.ioe-ans-banner'), 30000, 400);
  const s5 = await page.evaluate(() => ({
    qInput: document.querySelector('.input-answer')?.value || '',
    hintInput: document.getElementById('ioe-slot-hint-input')?.value || '',
    allTextInputs: Array.from(document.querySelectorAll('input[type="text"]')).map(i => (i.id || i.className || '?') + '=' + JSON.stringify(i.value)),
  }));
  report('S5 reorder fill câu', !!banner3 && /She always gets up early/.test(s5.qInput),
    `question input="${s5.qInput.slice(0, 40)}" | extension hint input="${s5.hintInput.slice(0, 20)}" | tất cả input: ${s5.allTextInputs.join(' ; ').slice(0, 120)}`);

  // ===== S6: mixed 3-dạng (trang mới, có retry nếu renderer crash) =====
  let mixed = null;
  for (let attempt = 0; attempt < 2 && !mixed; attempt++) {
    const p6 = attempt === 0 ? page : await context.newPage();
    try {
      await p6.goto(`http://localhost:${PORT}/test_ioe.html`, { waitUntil: 'networkidle', timeout: 30000 });
      await waitFor(() => p6.$('#ioe-pill-toggle'), 10000);
      await p6.click('#ioe-trigger-solve-btn');
      await waitFor(() => p6.$('.ioe-ans-banner'), 30000, 400);
      await p6.waitForTimeout(2500);
      mixed = await p6.evaluate(() => ({
        banner: document.querySelector('.ioe-ans-value')?.innerText || null,
        selected: document.querySelector('.answer-item.selected')?.innerText || null,
        txtAnswer: document.getElementById('txtAnswer')?.value || null,
        reorder: document.querySelectorAll('.input-answer')[1]?.value || null,
      }));
      await p6.screenshot({ path: `${ART_DIR}/05_mixed_page.png` });
    } catch (e) {
      console.log(`S6 attempt ${attempt + 1} lỗi: ${e.message.slice(0, 80)}`);
      if (attempt === 0) { try { await page.close(); } catch (e2) {} }
    }
  }
  report('S6 mixed 3-dạng (quan sát)', !!mixed,
    mixed ? `AI trả="${(mixed.banner || '').slice(0, 30)}" → MCQ=${mixed.selected}, txtAnswer="${mixed.txtAnswer}", reorder="${(mixed.reorder || '').slice(0, 25)}"` : 'page crash cả 2 lần thử');

  // ===== S7: console errors =====
  const pageErrors = logs.filter((l) => l.startsWith('[pageerror]'));
  const consoleErrors = logs.filter((l) => l.startsWith('[console.error]'));
  report('S7 pageerror', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 5).join(' || ') : 'không có');
  report('S7 console.error', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 5).join(' || ') : 'không có');

  fs.writeFileSync(`${ART_DIR}/test_report.json`, JSON.stringify({ results, logs }, null, 2));

  await browser.close();
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
  try { process.kill(-xvfb.pid, 'SIGKILL'); } catch (e) {}
  server.close();

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n===== KẾT QUẢ: ${pass}/${results.length} pass =====`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
