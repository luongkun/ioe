/**
 * E2E test BUG#16/#17 — đường AI GEMINI THẬT (MOCK_GEMINI=false), không có key hợp lệ
 *
 * Tái hiện đúng 2 triệu chứng user báo:
 *   (1) "Tất cả các model AI đang quá tải: API key not valid. Please pass a valid API key."
 *   (2) Panel vẫn render "1.? 2.? 3.? ..." (10 câu không có đáp án) rồi không làm gì
 *
 * 3 kịch bản (mỗi kịch bản 1 trang mock_mcqgame 10 câu như thanh-pho-xanh):
 *   A: chưa nhập key (user mới cài, storage rỗng)
 *   B: key sai dạng AIza-fake (Google thật trả 400 "API key not valid...")
 *   C: key = placeholder YOUR_API_KEY_HERE (default cũ của extension)
 *
 * Chạy trước fix để chứng minh chẩn đoán, chạy sau fix để verify.
 * USAGE: node /home/z/my-project/scripts/bug16_repro.js [before|after]
 */
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const MODE = process.argv[2] || 'before'; // before = kỳ vọng tái hiện lỗi, after = kỳ vọng đã fix
const EXT_DIR = '/home/z/my-project/ioe-bugtest';
const ART_DIR = '/home/z/my-project/test-artifacts';
const PORT = 8933;
const CDP_PORT = 9245;
const CHROME = '/home/z/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PROFILE = '/tmp/ext-bug16-profile';
fs.mkdirSync(ART_DIR, { recursive: true });

// Đề MCQ 10 câu — mô phỏng thanh-pho-xanh (Vòng 6) mà user gặp
const QUESTIONS = [
  ['What is the main idea of the passage?', ['Recycling benefits', 'Ocean pollution', 'City growth', 'Green energy']],
  ['She _______ to school by bus every day.', ['go', 'goes', 'going', 'gone']],
  ['They have lived here _______ 2010.', ['since', 'for', 'from', 'at']],
  ['The movie was so _______ that we left early.', ['bored', 'boring', 'bore', 'boringly']],
  ['He asked me _______ I needed help.', ['that', 'what', 'if', 'which']],
  ['We _______ dinner when the phone rang.', ['had', 'were having', 'have', 'have had']],
  ['This is the _______ book I have ever read.', ['good', 'better', 'best', 'most good']],
  ['If I _______ you, I would apologise.', ['am', 'was', 'were', 'be']],
  ['The children played _______ in the garden.', ['happy', 'happily', 'happiness', 'happier']],
  ['She speaks English _______ than her brother.', ['fluent', 'fluently', 'more fluently', 'most fluently']],
].map((q, i) => ({
  id: 300 + i, Point: 10, type: 1, exerciseFormat: 5, Description: {},
  content: { content: q[0] }, ans: q[1].map(a => ({ content: a })), tans: []
}));

const GETINFO_MCQ = {
  data: {
    game: {
      examKey: 'BUG16.MCQ.0001', totalPoint: 100,
      question: QUESTIONS,
      ans: []
    },
    gameDesc: 'Mock multi-MCQ 10-question game (bug16 repro).',
    examTime: 600
  }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mp3': 'audio/mpeg' };
const PAGES_DIRS = [EXT_DIR, '/home/z/my-project/ioe/tests/mock-pages'];
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.startsWith('/ioe-service/v2/game/getinfo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(GETINFO_MCQ));
    return;
  }
  // trang /mock_mcqgame.html từ ioe-bugtest (kèm cocos runtime); /mock_mcq.html
  // (DOM thuần, KHÔNG getinfo → đường F2 screenshot+AI) từ repo tests
  for (const dir of PAGES_DIRS) {
    const file = path.join(dir, rel === '/' ? '/mock_mcqgame.html' : rel);
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
      return;
    }
  }
  res.writeHead(404); res.end('not found');
});

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${name}] ${detail}`);
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  try { execSync('pkill -f "chrome-linux64/chrome" || true'); execSync('pkill -f Xvfb || true'); } catch (e) {}
  await new Promise(r => setTimeout(r, 1500));
  execSync(`rm -rf ${PROFILE} /tmp/.X99-lock`);
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1440x900x24'], { detached: true, stdio: 'ignore' });
  xvfb.unref();
  await new Promise(r => setTimeout(r, 1200));
  const chromeLog = fs.openSync('/tmp/chrome-bug16.log', 'w');
  const chrome = spawn(CHROME, [
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`, `--load-extension=${EXT_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1400,900', 'about:blank'
  ], { detached: true, stdio: ['ignore', chromeLog, chromeLog], env: { ...process.env, DISPLAY: ':99' } });
  chrome.unref();
  await new Promise(r => setTimeout(r, 4000));

  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  const context = browser.contexts()[0];

  const scenarios = [
    { key: 'none', name: 'A: chưa nhập key (user mới cài)', set: null },
    { key: 'fake', name: 'B: key sai AIza-fake', set: 'AIza-this-key-is-fake-0000000000' },
    { key: 'placeholder', name: 'C: placeholder YOUR_API_KEY_HERE', set: 'YOUR_API_KEY_HERE' },
  ];

  for (const sc of scenarios) {
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/mock_mcqgame.html`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500);

    // đặt trạng thái API key trong chrome.storage của extension
    let sw = null;
    for (let i = 0; i < 10 && !sw; i++) {
      for (const ctx of browser.contexts()) for (const w of ctx.serviceWorkers()) sw = w;
      if (!sw) await new Promise(r => setTimeout(r, 800));
    }
    if (!sw) { report(`${sc.key}: service worker`, false, 'không tìm thấy SW'); continue; }
    await sw.evaluate(async (k) => {
      await chrome.storage.local.remove('geminiApiKey');
      if (k) await chrome.storage.local.set({ geminiApiKey: k });
    }, sc.set);

    // bấm "Tự Làm"
    const clicked = await page.evaluate(() => {
      const btn = document.getElementById('ioe-auto-btn');
      if (!btn) return false;
      btn.click();
      return true;
    });

    // đợi panel đổi trạng thái: hiện KẾT QUẢ/LỖI/hàng "n." — tối đa 90s (7 model fallback rất chậm)
    const t0 = Date.now();
    let panelText = '';
    while (Date.now() - t0 < 90000) {
      await page.waitForTimeout(2500);
      panelText = await page.evaluate(() => {
        const el = document.querySelector('#ioe-panel-content');
        return el ? (el.innerText || '') : '';
      }).catch(() => '');
      const f = panelText.replace(/\s+/g, ' ');
      if (/KẾT QUẢ|ĐÁP ÁN|Lỗi|Không giải được|\d+\s*\.\s*\?/.test(f)) break; // bỏ qua text intro mặc định
    }
    const elapsedS = +(((Date.now() - t0) / 1000).toFixed(1));
    const flat = panelText.replace(/\s+/g, ' ').trim();

    const hasQmarkRow = /\d+\s*\.\s*\?/.test(flat);                    // "1.? 2.? 3.?"
    const hasWrongOverloadMsg = /quá tải/i.test(flat) && /api key not valid/i.test(flat);
    const hasClearKeyGuidance = /api key/i.test(flat) && (/chưa nhập|không hợp lệ|aistudio/i.test(flat)) && !/quá tải/i.test(flat);

    if (MODE === 'before') {
      // kỳ vọng TÁI HIỆN đúng lỗi user: (A) nhãn sai "quá tải" kèm "API key not valid"
      // hoặc (B/C) render hàng "n.?" — mỗi kịch bản ít nhất 1 trong 2 triệu chứng
      const reproduced = hasWrongOverloadMsg || hasQmarkRow;
      report(`${sc.key}: tái hiện triệu chứng user`, reproduced,
        `elapsed=${elapsedS}s | wrongOverload=${hasWrongOverloadMsg} | qmarkRow=${hasQmarkRow} | panel="${flat.slice(0, 160)}"`);
    } else {
      // kỳ vọng SAU FIX: KHÔNG nhãn sai "quá tải", KHÔNG render "n.?",
      // CÓ hướng dẫn key rõ ràng, và phải NHANH (thoát ngay không thử 7 model)
      report(`${sc.key}: không còn "quá tải + API key not valid"`, !hasWrongOverloadMsg, `panel="${flat.slice(0, 160)}"`);
      report(`${sc.key}: không render hàng "1.? 2.? 3.?"`, !hasQmarkRow, `qmarkRow=${hasQmarkRow}`);
      report(`${sc.key}: có hướng dẫn API key rõ ràng`, hasClearKeyGuidance, `guidance=${hasClearKeyGuidance}`);
      report(`${sc.key}: thoát nhanh (<15s, không thử 7 model)`, elapsedS < 15, `elapsed=${elapsedS}s`);
    }
    await page.close();
  }

  // ==== Kịch bản D: đường F2 (Chụp & Giải) với key sai — nơi user thấy
  // "Tất cả các model AI đang quá tải: API key not valid..." ====
  {
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/mock_mcq.html`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    // đặt key giả AIza (Google trả 400 "API key not valid...")
    let swD = null;
    for (let i = 0; i < 10 && !swD; i++) {
      for (const ctx of browser.contexts()) for (const w of ctx.serviceWorkers()) swD = w;
      if (!swD) await new Promise(r => setTimeout(r, 800));
    }
    if (swD) {
      await swD.evaluate(async () => {
        await chrome.storage.local.remove('geminiApiKey');
        await chrome.storage.local.set({ geminiApiKey: 'AIza-this-key-is-fake-0000000000' });
      });
    }
    await page.evaluate(() => { const b = document.getElementById('ioe-trigger-solve-btn'); if (b) b.click(); });
    const t0 = Date.now();
    let panelText = '';
    while (Date.now() - t0 < 90000) {
      await page.waitForTimeout(2500);
      panelText = await page.evaluate(() => {
        const el = document.querySelector('#ioe-panel-content');
        return el ? (el.innerText || '') : '';
      }).catch(() => '');
      if (/Lỗi|Không giải được/.test(panelText)) break;
    }
    const elapsedS = +(((Date.now() - t0) / 1000).toFixed(1));
    const flat = panelText.replace(/\s+/g, ' ').trim();
    const hasWrongOverloadMsg = /quá tải/i.test(flat) && /api key not valid/i.test(flat);
    const hasClearKeyGuidance = /api key/i.test(flat) && (/không hợp lệ|chưa nhập|aistudio/i.test(flat)) && !/quá tải/i.test(flat);
    if (MODE === 'before') {
      report('F2-fakekey: tái hiện "quá tải + API key not valid"', hasWrongOverloadMsg, `elapsed=${elapsedS}s | panel="${flat.slice(0, 180)}"`);
    } else {
      report('F2-fakekey: thông báo lỗi rõ ràng (không gán nhãn quá tải)', hasClearKeyGuidance, `elapsed=${elapsedS}s | panel="${flat.slice(0, 180)}"`);
      report('F2-fakekey: thoát nhanh (<15s)', elapsedS < 15, `elapsed=${elapsedS}s`);
    }
    await page.close();
  }

  const passCount = results.filter(r => r.pass).length;
  console.log(`\n===== ${MODE === 'before' ? 'TÁI HIỆN LỖI (TRƯỚC FIX)' : 'VERIFY (SAU FIX)'}: ${passCount}/${results.length} =====`);
  fs.writeFileSync(path.join(ART_DIR, `bug16_${MODE}.json`), JSON.stringify({ mode: MODE, results }, null, 2));

  await browser.close();
  try { execSync('pkill -f "chrome-linux64/chrome" || true'); execSync('pkill -f Xvfb || true'); } catch (e) {}
  server.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
