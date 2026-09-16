/**
 * Debug fillword: mở mock_fillword.html, bấm Tự Làm, dump:
 *  - console logs của page (phân loại, toast từng câu)
 *  - nội dung panel chips (answers[] mà extension tính được)
 *  - MOCK_GAME_STATE (submitted/typedEvents)
 *  - prompt thực tế gửi đến SW (hook qua fetch không được — SW log ra console riêng)
 * Mục tiêu: xác định mock AI trả về gì và answers[] là gì.
 */
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const EXT_DIR = '/home/z/my-project/ioe-test';
const PORT = 8923;
const CDP_PORT = 9243;
const CHROME = '/home/z/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PROFILE = '/tmp/ext-dbgfw-profile';

const GETINFO = {
  data: {
    game: {
      examKey: 'MOCKFW.00001', totalPoint: 50,
      question: [
        { id: 101, Point: 10, type: 2, exerciseFormat: 0, Description: { dataType: 2, content: 'http://localhost:' + PORT + '/a1.mp3' }, content: { content: "He's not sup***** to eat anything else right now." }, ans: [], tans: [] },
        { id: 102, Point: 10, type: 2, exerciseFormat: 0, Description: { dataType: 2, content: 'http://localhost:' + PORT + '/a2.mp3' }, content: { content: 'We will be using the ******** lab every other week on Thursday.' }, ans: [], tans: [] },
        { id: 103, Point: 10, type: 2, exerciseFormat: 18, Description: { dataType: 2, content: 'http://localhost:' + PORT + '/a3.mp3' }, content: { content: "My grandparents' ***** on marriage are still very traditional." }, ans: [], tans: [] },
        { id: 104, Point: 10, type: 2, exerciseFormat: 0, Description: { dataType: 2, content: 'http://localhost:' + PORT + '/a4.mp3' }, content: { content: 'This class ***** on Tuesdays and Thursdays from 3:15 to 4:50.' }, ans: [], tans: [] },
        { id: 105, Point: 10, type: 2, exerciseFormat: 0, Description: { dataType: 2, content: 'http://localhost:' + PORT + '/a5.mp3' }, content: { content: 'The team carried out important ******** on climate change.' }, ans: [], tans: [] }
      ],
      ans: [{ ans: 'research' }, { ans: 'meets' }]
    },
    gameDesc: 'Mock listening fill-word game for automated testing. ANSWERS: supposed, computer, views, meets, research',
    examTime: 600
  }
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.startsWith('/ioe-service/v2/game/getinfo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(GETINFO));
    return;
  }
  const file = path.join(EXT_DIR, rel === '/' ? '/mock_fillword.html' : rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  execSync(`rm -rf ${PROFILE} /tmp/.X99-lock`);
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1440x900x24'], { detached: true, stdio: 'ignore' });
  xvfb.unref();
  await new Promise(r => setTimeout(r, 1200));
  const chromeLog = fs.openSync('/tmp/chrome-dbgfw.log', 'w');
  const chrome = spawn(CHROME, [
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`, `--load-extension=${EXT_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1400,900', 'about:blank'
  ], { detached: true, stdio: ['ignore', chromeLog, chromeLog], env: { ...process.env, DISPLAY: ':99' } });
  chrome.unref();

  const cdpOk = await new Promise(res => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      require('http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: 1500 }, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => { if (d.includes('Browser')) { clearInterval(iv); res(true); } });
      }).on('error', () => { if (Date.now() - t0 > 20000) { clearInterval(iv); res(false); } });
    }, 500);
  });
  if (!cdpOk) { console.log('FAIL: no CDP'); process.exit(1); }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  // Capture ALL console messages from the page (content script world included)
  page.on('console', msg => {
    const t = msg.text();
    if (/English Master|IOE Bridge|MockGame|fillword|FILL_WORDS/i.test(t)) console.log('[console]', t.slice(0, 400));
  });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto(`http://localhost:${PORT}/mock_fillword.html`);

  // Wait for bridge GETINFO
  await new Promise(async (resolve) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const ok = await page.evaluate(() => {
        const b = document.getElementById('ioe-game-api-badge');
        return b && !b.classList.contains('hidden');
      }).catch(() => null);
      if (ok) return resolve();
      await new Promise(r => setTimeout(r, 300));
    }
    resolve();
  });
  console.log('--- bridge GETINFO captured ---');

  // Dump bridge state gameDesc (MAIN world)
  const gd = await page.evaluate(() => {
    const st = window.__IOE_GAME_BRIDGE__ && window.__IOE_GAME_BRIDGE__.state;
    return st ? { gameDesc: st.gameDesc, answerPool: st.answerPool, n: st.questions.length, q5: st.questions[4] && { prompt: st.questions[4].prompt, masked: st.questions[4].masked, maskPrefix: st.questions[4].maskPrefix, maskStars: st.questions[4].maskStars, audio: st.questions[4].audio } } : null;
  }).catch(e => ({ err: String(e) }));
  console.log('--- bridge state:', JSON.stringify(gd, null, 2));

  await page.evaluate(() => document.getElementById('ioe-auto-btn').click());
  console.log('--- clicked Tự Làm, waiting for finish...');

  // Wait finish (max 120s)
  const t0 = Date.now();
  let finished = null;
  while (Date.now() - t0 < 120000) {
    finished = await page.evaluate(() => {
      const st = window.MOCK_GAME_STATE;
      return st && st.finished ? st : null;
    }).catch(() => null);
    if (finished) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // Dump panel chips = answers[] the extension computed
  const panel = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#ioe-panel-content [data-act="type"]'));
    return chips.map(c => c.getAttribute('data-word'));
  }).catch(e => ['err:' + String(e)]);
  console.log('--- panel chips (answers[]):', JSON.stringify(panel));

  const st = await page.evaluate(() => {
    const s = window.MOCK_GAME_STATE || {};
    return { submitted: (s.submitted || []).map(x => x.answer), typedEvents: s.typedEvents, started: s.started, finished: s.finished, current: s.current };
  }).catch(e => ({ err: String(e) }));
  console.log('--- game state:', JSON.stringify(st, null, 2));

  try { await page.screenshot({ path: '/home/z/my-project/test-artifacts/dbg_fillword.png' }); } catch (e) {}
  try { browser.close(); } catch (e) {}
  try { process.exit(0); } catch (e) {}
})();
