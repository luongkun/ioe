/**
 * test_bug22_reentry.js — E2E test BUG#22 (v3.5): chống giải lồng nhau (re-entry)
 *
 * Tái hiện đúng tình huống user: "nó giải lâu quá nên tôi ấn nút tự làm hơi nhiều,
 * khiến nó bị lồng nhau gây lỗi".
 *
 * Mock fillword (5 câu EditBox Cocos) có hậu kỳ gõ từ kéo dài vài giây —
 * window.MOCK_GAME_STATE.typedEvents ghi lại MỌI lần gõ (MAIN world, đếm được).
 *
 * T1 (bug gốc — bấm Tự Làm giữa lúc đang gõ): bấm Tự Làm lần 1 → đang trong
 *     phase gõ từ → bấm thêm 3 lần nữa → mock phải nhận ĐÚNG 5 từ, mỗi từ
 *     đúng 1 lần (bản lỗi: 2 luồng gõ chồng → từ bị lặp / sai thứ tự).
 * T2 (spam đồng loạt): bấm Tự Làm 6 lần trong 1 tick → chỉ 1 luồng chạy.
 * T3 (F2 trong lúc bận): đang giải → nhấn F2 → bị bỏ qua, không luồng thứ 2.
 * T4 (khóa nhả đúng lúc): sau khi xong, data-ema-busy=0, nút re-enable,
 *     bấm Tự Làm lần mới chạy bình thường (không kẹt vĩnh viễn).
 * T5 (MCQ đơn: spam F2): 6 lần F2 đồng loạt → 1 đáp án được click 1 lần.
 */
const { chromium } = require('/home/z/.npm-global/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const EXT_DIR = '/home/z/my-project/ioe-test';
const ART_DIR = '/home/z/my-project/test-artifacts';
const PORT = 8920;
const CHROME = '/home/z/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PROFILE = '/tmp/bug22-profile';

fs.mkdirSync(ART_DIR, { recursive: true });

// GETINFO data — mock game fetch /ioe-service/v2/game/getinfo → game-api-bridge
// bắt XHR → có questions → solver đi đúng data path (giống test_fillword.js)
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
  }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.startsWith('/ioe-service/v2/game/getinfo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(GETINFO.fillword));
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
async function waitFor(fn, timeout = 60000, poll = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    await new Promise((r) => setTimeout(r, poll));
  }
  return null;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  try { execSync('pkill -f "chrome-linux64/chrome" || true'); execSync('pkill -f Xvfb || true'); } catch (e) {}
  await new Promise(r => setTimeout(r, 1500));
  execSync(`rm -rf ${PROFILE} /tmp/.X99-lock /tmp/.X11-unix/X99`);
  const xvfbLog = fs.openSync('/tmp/xvfb-bug22.log', 'w');
  spawn('Xvfb', [':99', '-screen', '0', '1440x900x24'], { detached: true, stdio: ['ignore', xvfbLog, xvfbLog] }).unref();
  await new Promise(r => setTimeout(r, 2200));

  const chromeLog = fs.openSync('/tmp/chrome-bug22.log', 'w');
  spawn(CHROME, [
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9240',
    `--user-data-dir=${PROFILE}`, `--load-extension=${EXT_DIR}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--window-size=1400,900', 'about:blank'
  ], { detached: true, stdio: ['ignore', chromeLog, chromeLog], env: { ...process.env, DISPLAY: ':99' } }).unref();

  let up = null;
  for (let i = 0; i < 24 && !up; i++) {
    up = await new Promise(res => {
      const req = http.get({ host: '127.0.0.1', port: 9240, path: '/json/version', timeout: 1200 }, (r) => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d.includes('Browser') ? 1 : null));
      });
      req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); });
    });
    if (!up) await new Promise(r => setTimeout(r, 500));
  }
  if (!up) { console.error('FAIL: CDP not up'); process.exit(1); }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9240');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // ===== T1+T2: fillword — bấm Tự Làm giữa lúc đang gõ + spam =====
  await page.goto(`http://localhost:${PORT}/mock_fillword.html`, { waitUntil: 'networkidle' });
  await waitFor(() => page.$('#ioe-pill-toggle'), 15000);
  // mở panel để thấy nút Tự Làm
  await page.click('#ioe-pill-toggle');
  await waitFor(() => page.$('#ioe-auto-btn'), 8000);

  const EXPECT = ['supposed', 'computer', 'views', 'meets', 'research']; // mock ANSWERS trong gameDesc

  // Bấm Tự Làm lần 1
  await page.evaluate(() => document.getElementById('ioe-auto-btn').click());
  // Chờ lock bắt đầu (data-ema-busy=1) — chứng tỏ pipeline đang chạy
  const busyOn = await waitFor(() => page.evaluate(() => document.documentElement.getAttribute('data-ema-busy') === '1'), 10000, 100);
  report('T1: khóa bận bật khi bắt đầu giải (data-ema-busy=1)', !!busyOn, busyOn ? 'khóa đã giữ' : 'không thấy khóa bật');

  // Trong lúc đang giải/gõ: spam Tự Làm 3 lần + F2 2 lần (đúng hành vi user).
  // F2 qua keyboard thật — handler chạy trong isolated world, evaluate() không thấy.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.getElementById('ioe-auto-btn').click());
    await page.keyboard.press('F2');
    await page.waitForTimeout(250);
  }
  // Snapshot số event gõ NGAY sau spam — phải không tăng đột biến (luồng 2 bị chặn)
  const duringSpam = await page.evaluate(() => (window.MOCK_GAME_STATE || {}).typedEvents ? [...window.MOCK_GAME_STATE.typedEvents] : []);

  // Chờ bài hoàn tất
  const finished = await waitFor(() => page.evaluate(() => {
    const st = window.MOCK_GAME_STATE || {};
    return st.finished ? st : null;
  }), 90000, 400);
  report('T1: bài hoàn thành sau spam', !!finished, finished ? `submitted=${JSON.stringify(finished.submitted)}` : 'timeout');

  if (finished) {
    const submitted = (finished.submitted || []).map(s => (s && s.answer) !== undefined ? s.answer : s); // mock trả [{q, answer}]
    const ok5 = submitted.length === 5 && submitted.every((w, i) => w === EXPECT[i]);
    report('T1: ĐÚNG 5 từ, đúng thứ tự, KHÔNG lặp (không lồng nhau)', ok5,
      `submitted=[${submitted.join(', ')}] kỳ vọng=[${EXPECT.join(', ')}]`);
    const te = (finished.typedEvents || []);
    const dupCount = te.length - new Set(te).size;
    report('T1: không có event gõ trùng lặp', dupCount === 0, `typedEvents(${te.length})=[${te.join('|')}] trùng=${dupCount}`);
  }

  // ===== T3: sau khi xong — khóa nhả + nút hoạt động lại =====
  const busyOff = await waitFor(() => page.evaluate(() => document.documentElement.getAttribute('data-ema-busy') === '0'), 15000, 200);
  report('T3: khóa nhả sau khi xong (data-ema-busy=0)', !!busyOff, busyOff ? 'đã nhả' : 'khóa kẹt!');
  const btnEnabled = await page.evaluate(() => {
    const b = document.getElementById('ioe-auto-btn');
    return !!(b && !b.disabled);
  });
  report('T3: nút Tự Làm re-enable', btnEnabled, btnEnabled ? 'bấm được lại' : 'nút kẹt disabled');

  // Bấm lại lần 2 — reload trang cho mock game sạch hoàn toàn (tránh state current
  // kẹt ở câu cuối), dùng cache đáp án — phải chạy bình thường, không kẹt khóa
  await page.reload({ waitUntil: 'networkidle' });
  await waitFor(() => page.$('#ioe-pill-toggle'), 15000);
  await page.click('#ioe-pill-toggle');
  await waitFor(() => page.$('#ioe-auto-btn'), 8000);
  await page.evaluate(() => document.getElementById('ioe-auto-btn').click());
  const finished2 = await waitFor(() => page.evaluate(() => {
    const st = window.MOCK_GAME_STATE || {};
    return st.finished ? st : null;
  }), 60000, 400);
  report('T4: lượt giải MỚI sau khi khóa nhả chạy bình thường', !!finished2, finished2 ? 'lượt 2 hoàn thành' : 'kẹt sau lượt 1');

  // ===== T5: MCQ đơn — spam F2 đồng loạt 6 lần trong 1 tick =====
  await page.goto(`http://localhost:${PORT}/mock_mcq.html`, { waitUntil: 'networkidle' });
  await waitFor(() => page.$('#ioe-pill-toggle'), 15000);
  // đếm số lần click đáp án
  await page.evaluate(() => {
    window.__ANS_CLICKS__ = 0;
    document.querySelectorAll('.answer-item').forEach(el => {
      el.addEventListener('click', () => window.__ANS_CLICKS__++);
    });
  });
  // 6 lần click "Chụp & Giải" ĐỒNG BỘ trong 1 tick (đúng kiểu bấm liên tục khi
  // impatient — lần 1 giữ khóa sync tới await đầu, lần 2-6 chắc chắn bị chặn)
  await page.evaluate(() => {
    const btn = document.getElementById('ioe-trigger-solve-btn');
    if (!btn) throw new Error('không thấy nút Chụp & Giải');
    for (let i = 0; i < 6; i++) btn.click();
  });
  const ansBanner = await waitFor(() => page.$('.ioe-ans-banner'), 30000, 400);
  report('T5: F2 spam 6 lần — vẫn ra đáp án', !!ansBanner, ansBanner ? 'banner hiện' : 'không có banner');
  await page.waitForTimeout(2500); // chờ hậu kỳ click xong
  const clicks = await page.evaluate(() => window.__ANS_CLICKS__);
  // clickMultipleChoiceOption DOM path phát 2 event mỗi lựa chọn (el.click() +
  // dispatchEvent MouseEvent) → 1 pipeline = 2 click events. Nếu lồng nhau
  // (6 pipeline) sẽ là 12. Kỳ vọng: đúng 2.
  report('T5: chỉ 1 luồng chọn đáp án (2 events/luồng)', clicks === 2, `số click events = ${clicks}${clicks > 2 ? ' — CÓ LỒNG NHAU!' : ' (1 luồng × 2 events)'}`);

  const noPageErr = pageErrors.length === 0;
  report('T6: không có pageerror trong toàn bộ test', noPageErr, pageErrors.length ? pageErrors.slice(0, 2).join(' | ') : 'sạch');

  fs.writeFileSync(path.join(ART_DIR, 'test_bug22_report.json'), JSON.stringify(results, null, 2));
  const pass = results.filter(r => r.pass).length;
  console.log(`\n===== BUG#22: ${pass}/${results.length} PASS =====`);
  try { execSync('pkill -f "chrome-linux64/chrome" || true'); } catch (e) {}
  setTimeout(() => process.exit(pass === results.length ? 0 : 1), 800);
})().catch(e => { console.error('ERR:', e); process.exit(1); });
