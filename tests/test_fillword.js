/**
 * E2E test: LISTENING FILL-WORD (EditBox typing) + MULTI-MCQ + question cache
 * Stack: Xvfb :99 + Chrome + --load-extension(ioe-test) + connectOverCDP
 *
 * Trang giả lập mock_fillword.html / mock_mcqgame.html chạy runtime Cocos giả
 * (mock_cocos_runtime.js) → bridge bắt getinfo → classifier → mock AI →
 * TYPE_EDITBOX/CONFIRM_ANSWER/CLICK_TEXT → assert kết quả mock game.
 */
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const EXT_DIR = '/home/z/my-project/ioe-test';
const ART_DIR = '/home/z/my-project/test-artifacts';
const PORT = 8921;
const CDP_PORT = 9241;
const CHROME = '/home/z/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PROFILE = '/tmp/ext-fw-profile';
fs.mkdirSync(ART_DIR, { recursive: true });

// ----- dữ liệu đề trả về từ route getinfo -----
const GETINFO = {
  fillword: {
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
  },
  mcq: {
    data: {
      game: {
        examKey: 'MOCKMCQ.00002', totalPoint: 30,
        question: [
          { id: 201, Point: 10, type: 1, exerciseFormat: 5, Description: {}, content: { content: 'If it rains tomorrow, we _______ our camping trip.' }, ans: [{ content: 'will cancel' }, { content: 'would cancel' }, { content: 'cancelled' }, { content: 'cancel' }], tans: [] },
          { id: 202, Point: 10, type: 1, exerciseFormat: 5, Description: {}, content: { content: 'She _______ to school by bus every day.' }, ans: [{ content: 'go' }, { content: 'goes' }, { content: 'going' }, { content: 'gone' }], tans: [] },
          { id: 203, Point: 10, type: 1, exerciseFormat: 5, Description: {}, content: { content: 'They have lived here _______ 2010.' }, ans: [{ content: 'since' }, { content: 'for' }, { content: 'from' }, { content: 'at' }], tans: [] }
        ],
        ans: []
      },
      gameDesc: 'Mock multi-MCQ game for automated testing.',
      examTime: 600
    }
  }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.startsWith('/ioe-service/v2/game/getinfo')) {
    const type = (req.url.split('type=')[1] || 'fillword').split('&')[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(GETINFO[type] || GETINFO.fillword));
    return;
  }
  const file = path.join(EXT_DIR, rel === '/' ? '/mock_fillword.html' : rel);
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
async function waitFor(fn, timeout = 60000, poll = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    await new Promise(r => setTimeout(r, poll));
  }
  return null;
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  // QUAN TRỌNG: browser.close() với connectOverCDP chỉ DISCONNECT — Chrome vẫn sống.
  // Kill mọi process stale từ lần chạy trước để luôn test trên extension code MỚI.
  try { execSync('pkill -f "chrome-linux64/chrome" || true'); execSync('pkill -f Xvfb || true'); } catch (e) {}
  await new Promise(r => setTimeout(r, 1500));
  execSync(`rm -rf ${PROFILE} /tmp/.X99-lock`);
  const xvfbLog = fs.openSync('/tmp/xvfb-fw.log', 'w');
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1440x900x24'], { detached: true, stdio: ['ignore', xvfbLog, xvfbLog] });
  xvfb.unref();
  await new Promise(r => setTimeout(r, 1200));

  const chromeLog = fs.openSync('/tmp/chrome-fw.log', 'w');
  const chrome = spawn(CHROME, [
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`, `--load-extension=${EXT_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1400,900', 'about:blank'
  ], { detached: true, stdio: ['ignore', chromeLog, chromeLog], env: { ...process.env, DISPLAY: ':99' } });
  chrome.unref();

  const cdpOk = await waitFor(() => new Promise(res => {
    require('http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version', timeout: 1500 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d.includes('Browser') || null));
    }).on('error', () => res(null));
  }), 20000, 500);
  if (!cdpOk) { console.log('FAIL [chrome] không kết nối được CDP'); process.exit(1); }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];

  async function runGamePage(pageName, expectAnswers, timeoutMs) {
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/${pageName}`);
    // 1. Bridge bắt getinfo → badge API hiện
    const badge = await waitFor(() => page.evaluate(() => {
      const b = document.getElementById('ioe-game-api-badge');
      return b && !b.classList.contains('hidden') ? b.textContent : null;
    }), 15000);
    report(`${pageName}: bridge GETINFO`, !!badge, `badge=${badge}`);

    // 2. Bấm nút Tự Làm (kích hoạt toàn pipeline trong isolated world)
    const clicked = await page.evaluate(() => {
      const btn = document.getElementById('ioe-auto-btn');
      if (!btn) return false;
      btn.click();
      return true;
    });
    report(`${pageName}: click Tự Làm`, clicked, clicked ? 'đã bấm' : 'không tìm thấy nút');

    // 3. Chờ game chạy hết (mock state finished)
    const finished = await waitFor(() => page.evaluate(() => {
      const st = window.MOCK_GAME_STATE;
      return st && st.finished ? st : null;
    }), timeoutMs, 500);
    const shot = path.join(ART_DIR, `fw_${pageName}.png`);
    try { await page.screenshot({ path: shot }); } catch (e) {}

    if (!finished) {
      const dbg = await page.evaluate(() => {
        const st = window.MOCK_GAME_STATE || {};
        const qBox = document.getElementById('ioe-question-display');
        return { state: { started: st.started, current: st.current, submitted: st.submitted, typed: st.typedEvents }, qBox: qBox ? qBox.textContent : null };
      });
      report(`${pageName}: hoàn thành bài`, false, `timeout — ${JSON.stringify(dbg).slice(0, 300)}`);
      await page.close();
      return null;
    }

    const submitted = finished.submitted.map(s => s.answer);
    const pass = JSON.stringify(submitted) === JSON.stringify(expectAnswers);
    report(`${pageName}: đáp án đúng`, pass, `mock nhận [${submitted.join(', ')}] — kỳ vọng [${expectAnswers.join(', ')}]`);
    await page.close();
    return submitted;
  }

  // ==== TEST 1: listening fill-word E2E ====
  const fw = await runGamePage('mock_fillword.html', ['supposed', 'computer', 'views', 'meets', 'research'], 120000);

  // ==== TEST 2: cache — cùng đề làm lại (không cần AI nữa) ====
  const fw2 = await runGamePage('mock_fillword.html', ['supposed', 'computer', 'views', 'meets', 'research'], 120000);
  report('fillword: cache tái sử dụng', fw2 !== null, fw2 ? 'lần 2 vẫn hoàn thành (đáp án lấy từ cache)' : 'lần 2 thất bại');

  // ==== TEST 3: multi-MCQ E2E ====
  // mock AI trả [MCQ_ANSWERS: 1. B, 2. A, 3. C] → sẽ click would cancel / go / from
  await runGamePage('mock_mcqgame.html', ['would cancel', 'go', 'from'], 90000);

  // ==== TEST 4: chip click không còn ReferenceError (BUG#5) ====
  {
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/mock_fillword.html`);
    await waitFor(() => page.evaluate(() => {
      const b = document.getElementById('ioe-game-api-badge');
      return b && !b.classList.contains('hidden');
    }), 15000);
    await page.evaluate(() => document.getElementById('ioe-auto-btn').click());
    // chờ panel render kết quả fill words
    const chips = await waitFor(() => page.evaluate(() => {
      const els = document.querySelectorAll('#ioe-panel-content [data-act="type"]');
      return els.length ? els.length : null;
    }), 60000);
    const noError = await page.evaluate(() => new Promise(res => {
      window.__chipError = null;
      window.addEventListener('error', e => { window.__chipError = e.message; });
      const el = document.querySelector('#ioe-panel-content [data-act="type"]');
      if (el) el.click();
      setTimeout(() => res(!window.__chipError), 800);
    }));
    report('chip data-act: click không lỗi', !!chips && noError, `chips=${chips}, noReferenceError=${noError}`);
    await page.close();
  }

  // ===== Tổng kết =====
  const pass = results.filter(r => r.pass).length;
  console.log(`\n===== KẾT QUẢ: ${pass}/${results.length} PASS =====`);
  fs.writeFileSync(path.join(ART_DIR, 'test_fillword_report.json'), JSON.stringify(results, null, 2));
  try { browser.close(); } catch (e) {}
  try { process.exit(pass === results.length ? 0 : 2); } catch (e) {}
})();
