/**
 * test_bug52_per_question_passage.js — BUG#52 (23/09/2026)
 * Game đọc hiểu "mỗi câu một đoạn văn" bị giải như thể cả bài chung một đoạn.
 *
 * Bối cảnh (live, giabao10a1 — Vòng 4 Bài 1 "don-rac-bai-bien", 10 câu × 10 điểm):
 *   Solver phân loại đúng "mcq_multi", đọc được đoạn văn 577 ký tự, gọi AI MỘT lượt
 *   cho cả 10 câu, rồi click 10 đáp án. Kết quả: **10/100** — chỉ câu 1 đúng. Game
 *   kết thúc sau 1 phút 20 giây.
 *
 *   Truy ra: game này đọc hiểu TỪNG CÂU, MỖI CÂU CÓ ĐOẠN VĂN RIÊNG. Node câu hỏi
 *   đang hiện là `nConversationQuest` (không phải `nTracNghiem`), và đoạn văn đổi
 *   thật giữa các câu — live-verified bằng cách trả lời câu 1 rồi đọc lại:
 *     câu 1 → "Generation Y, also known as Millennials, refers to those born…"
 *     câu 2 → "Fred Lorz, from New York, won the marathon at the St…"
 *   Solver đọc đoạn văn của câu 1 rồi trả lời cả 10 câu từ nó ⇒ 9 câu sau sai.
 *
 *   Đối chiếu: an-khe-tra-vang (Vòng 3 Bài 2) được 100/100 vì là game CHỌN CẶP TỪ
 *   ĐỒNG NGHĨA — không có đoạn văn nào (prompt toàn từ đơn: sorrow/polite/…), một
 *   lượt AI cho cả bài là đúng. Nên KHÔNG được bỏ chế độ gộp: phải phân biệt được
 *   hai chế độ. Tên game không dùng được (là dữ liệu, mỗi vòng một khác) → dùng
 *   node câu hỏi đang hiện.
 *
 * Khoá lại các bất biến:
 *   1. bridge: có RPC ACTIVE_QUESTION_MODE, nhận diện nConversationQuest và
 *      nTracNghiem, và CHỈ tính node đang active.
 *   2. content: trước khi hỏi AI cả loạt, solver hỏi chế độ; ở chế độ từng-câu thì
 *      KHÔNG gọi AI gộp.
 *   3. content: ở chế độ từng-câu, đáp án của mỗi câu được lấy TRONG vòng lặp click,
 *      và đoạn văn được đọc lại cho từng câu (có chờ scene dựng lại, và bỏ qua đoạn
 *      văn trùng câu trước — đúng cái bẫy BUG#44b đã gặp ở đường reading_tf).
 *   4. content: chế độ gộp (an-khe-tra-vang) KHÔNG bị ảnh hưởng — vẫn một lượt AI.
 *   5. gdNorm/passageIsGameDesc dùng chung một định nghĩa (không chép đôi), và
 *      chặn được gameDesc đóng giả đoạn văn (BUG#41).
 *
 * Chạy: node tests/test_bug52_per_question_passage.js
 * (không cần mạng, không cần key, không cần Playwright)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const BRIDGE_PATH = path.join(ROOT, "content", "ioe", "game-api-bridge.js");
const IOE_PATH = path.join(ROOT, "content", "ioe", "ioe.js");
const bridgeSrc = fs.readFileSync(BRIDGE_PATH, "utf8");
const ioeSrc = fs.readFileSync(IOE_PATH, "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "  → " + extra : "")); }
}

// ---- trích thân hàm (cùng kỹ thuật đã dùng ở test_bug50/51) ----
function skipParams(src, from) {
  let i = src.indexOf("(", from);
  let depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { if (ch === "\\") { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error("không tìm thấy hết tham số");
}

function fnBody(src, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = re.exec(src);
  if (!m) throw new Error("không tìm thấy hàm: " + name);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  let i = src.indexOf("{", skipParams(src, m.index));
  let depth = 0, inStr = null, inLine = false, inBlock = false, inRe = false, reCls = false, prevSig = "";
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && nx === "/") { inBlock = false; i++; } continue; }
    if (inRe) {
      if (ch === "\\") { i++; continue; }
      if (ch === "[") { reCls = true; continue; }
      if (ch === "]") { reCls = false; continue; }
      if (ch === "/" && !reCls) inRe = false;
      continue;
    }
    if (inStr) { if (ch === "\\") { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === "/" && nx === "/") { inLine = true; continue; }
    if (ch === "/" && nx === "*") { inBlock = true; i++; continue; }
    if (ch === "/" && !/[A-Za-z0-9_$)\]]$/.test(prevSig)) { inRe = true; reCls = false; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  throw new Error("hàm không đóng ngoặc: " + name);
}

// ================================================== A. bridge — nhận diện chế độ
console.log("\nA. bridge — RPC ACTIVE_QUESTION_MODE nhận diện đúng chế độ");

{
  let body = null;
  try { body = fnBody(bridgeSrc, "activeQuestionMode"); } catch (e) {}
  ok(!!body, "có hàm activeQuestionMode()");
  if (body) {
    ok(/nConversationQuest/.test(body), "nhận diện nConversationQuest (đọc hiểu từng câu)");
    ok(/nTracNghiem/.test(body), "nhận diện nTracNghiem (trắc nghiệm / chọn cặp)");
    ok(/activeInHierarchy/.test(body),
      "CHỈ tính node đang active (node ẩn cũng có tên đó ⇒ nếu không lọc, mọi game đều bị coi là từng-câu)");
  }
  ok(/case\s+"ACTIVE_QUESTION_MODE"/.test(bridgeSrc), "RPC ACTIVE_QUESTION_MODE có trong dispatch");
  ok(/ACTIVE_QUESTION_MODE_OK/.test(bridgeSrc), "RPC trả về ACTIVE_QUESTION_MODE_OK");
}

// Chạy activeQuestionMode() thật trong sandbox với scene giả.
// Bridge là script của content script nên cần vài stub DOM tối thiểu để nạp.
//
// Đi qua CHÍNH RPC dispatch, không gọi thẳng tên hàm: bridge là một IIFE nên
// activeQuestionMode KHÔNG phải global, và production cũng không gọi thẳng —
// content script gửi {__ioeBridgeRequest, type:"ACTIVE_QUESTION_MODE"} rồi đọc
// reply. Test đi đúng đường đó thì mới khoá được thứ đang chạy thật.
function runActiveQuestionMode(sceneSpec) {
  // sceneSpec: [{name, active}] lồng nhau 1 cấp
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Math, String, Number, Array, Object, Date, RegExp, Error, Promise, Map, Set,
    XMLHttpRequest: function () { this.open = noop; this.send = noop; this.setRequestHeader = noop; },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
    document: {
      addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop }),
      documentElement: { appendChild: noop, style: {} },
      head: { appendChild: noop }, body: { appendChild: noop, style: {} },
    },
    location: { href: "https://ioe.vn/lam-bai/x/", hostname: "ioe.vn" },
    navigator: { userAgent: "node" },
    performance: { now: () => Date.now(), getEntriesByType: () => [] },
    MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    chrome: { runtime: { sendMessage: noop, onMessage: { addListener: noop } } },
  };
  const mk = (spec) => ({
    name: spec.name, activeInHierarchy: spec.active !== false,
    children: (spec.children || []).map(mk),
    _components: [], getComponent: () => null,
  });
  const root = { name: "StartScene", activeInHierarchy: true, children: sceneSpec.map(mk), _components: [] };
  // `window` CHÍNH LÀ sandbox (bridge dùng window.addEventListener trực tiếp),
  // nên các stub DOM phải nằm trên sandbox chứ không chỉ trên document.
  const msgListeners = [];
  sandbox.addEventListener = (type, fn) => { if (type === "message") msgListeners.push(fn); };
  sandbox.removeEventListener = noop;
  // reply() của bridge gọi window.postMessage → hứng ở đây để lấy payload.
  let lastReply = null;
  sandbox.postMessage = (msg) => {
    if (msg && msg.__ioeBridge && msg.reqId) lastReply = msg;
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.cc = { director: { getScene: () => root } };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(bridgeSrc, ctx, { filename: "game-api-bridge.js" });
  if (!msgListeners.length) return null;
  // ev.source phải là CHÍNH window của context. Đối tượng sandbox thô KHÔNG
  // === global bên trong vm, nên nếu truyền nó vào thì handler thoát ngay ở
  // dòng `if (ev.source && ev.source !== window) return;` — đúng như trình
  // duyệt, nơi ev.source và window là cùng một đối tượng.
  const winRef = vm.runInContext("window", ctx);
  // Gửi request y như content script làm (xem ioeBridgeRequest trong ioe.js).
  const ev = { source: winRef, data: { __ioeBridgeRequest: true, type: "ACTIVE_QUESTION_MODE", payload: {}, reqId: "t1" } };
  for (const fn of msgListeners) fn(ev);
  return lastReply && lastReply.type === "ACTIVE_QUESTION_MODE_OK" ? lastReply.payload : null;
}

console.log("\nA2. bridge — activeQuestionMode chạy thật trên scene giả");
{
  const t = runActiveQuestionMode([{ name: "nTracNghiem", active: true }]);
  ok(t && typeof t === "object", "hàm gọi được từ trong bridge", JSON.stringify(t));
  if (t) {
    ok(t.tracNghiem === true && t.conversation === false,
      "scene chỉ có nTracNghiem → chế độ GỘP (đúng an-khe-tra-vang)", JSON.stringify(t));

    const c = runActiveQuestionMode([{ name: "nConversationQuest", active: true }]);
    ok(c && c.conversation === true && c.tracNghiem === false,
      "scene chỉ có nConversationQuest → chế độ TỪNG CÂU (đúng don-rac-bai-bien)", JSON.stringify(c));

    // Node ẩn KHÔNG được tính — nếu tính, mọi game đều thành từng-câu.
    const hidden = runActiveQuestionMode([{ name: "nConversationQuest", active: false }, { name: "nTracNghiem", active: true }]);
    ok(hidden && hidden.conversation === false && hidden.tracNghiem === true,
      "nConversationQuest ẨN không kéo game sang chế độ từng-câu", JSON.stringify(hidden));

    const empty = runActiveQuestionMode([]);
    ok(empty && empty.conversation === false && empty.tracNghiem === false,
      "scene rỗng → không chế độ nào (không ném lỗi)", JSON.stringify(empty));
  }
}

// ============================================ B. content — nhánh từng-câu vs gộp
console.log("\nB. content — phân nhánh từng-câu / gộp");

let mcqBody = null;
try { mcqBody = fnBody(ioeSrc, "solveAndClickMcqMulti"); } catch (e) {}
ok(!!mcqBody, "trích được thân hàm solveAndClickMcqMulti");

if (mcqBody) {
  ok(/ACTIVE_QUESTION_MODE/.test(mcqBody), "solver hỏi RPC ACTIVE_QUESTION_MODE");
  ok(/convMode/.test(mcqBody), "có biến convMode điều khiển nhánh");
  ok(/nConversationQuest/.test(mcqBody), "nhắc rõ nConversationQuest trong log/giải thích");

  // Nhánh gộp phải được bọc trong `if (!convMode)` — nếu không, chế độ từng-câu
  // vẫn gọi AI một lượt cho cả bài (đúng lỗi BUG#52) rồi lại gọi thêm từng câu.
  ok(/if\s*\(\s*!\s*convMode\s*\)\s*\{/.test(mcqBody),
    "lượt AI GỘP bị bọc trong `if (!convMode)` (chế độ từng-câu không gọi gộp)");

  // Trong vòng lặp click phải có nhánh lấy đáp án riêng cho từng câu.
  ok(/if\s*\(\s*convMode\s*\)\s*\{/.test(mcqBody),
    "trong vòng lặp click có nhánh riêng cho convMode");
  ok(/picks\[i\]\s*=\s*ans/.test(mcqBody),
    "đáp án từng câu được ghi vào picks[i] ngay trước khi click");

  // Chống bẫy BUG#44b: đoạn văn mới chỉ có sau khi scene dựng lại.
  ok(/lastPassage/.test(mcqBody),
    "có theo dõi lastPassage để biết đoạn văn đã ĐỔI chưa");
  ok(/cand\s*!==\s*lastPassage/.test(mcqBody),
    "bỏ qua đoạn văn TRÙNG câu trước (chờ scene dựng đoạn văn mới)");
  ok(/lastPassage\s*=\s*pass/.test(mcqBody), "cập nhật lastPassage sau mỗi câu");

  // Gọi AI cho MỘT câu: buildMcqMultiPrompt với đúng 1 phần tử.
  ok(/buildMcqMultiPrompt\(\[qs\[i\]\],\s*\[0\]/.test(mcqBody),
    "gọi AI cho đúng MỘT câu ([qs[i]], [0]) — không phải cả bài");

  // Không được để lộ biến gdNorm ra ngoài scope (đã từng gây ReferenceError).
  ok(!/\bgdNorm\s*\(/.test(mcqBody),
    "KHÔNG dùng gdNorm trực tiếp (biến cục bộ của hàm khác — sẽ ReferenceError)");
  ok(/passageIsGameDesc/.test(mcqBody),
    "dùng passageIsGameDesc dùng chung để chặn gameDesc đóng giả đoạn văn");
}

// ================================================ C. helper dùng chung
console.log("\nC. gdNorm / passageIsGameDesc — một định nghĩa dùng chung");

{
  const gdDefs = (ioeSrc.match(/function\s+gdNorm\s*\(/g) || []).length;
  const gdInline = (ioeSrc.match(/const\s+gdNorm\s*=/g) || []).length;
  ok(gdDefs === 1, "gdNorm có ĐÚNG một định nghĩa (function)", "thấy " + gdDefs + " function, " + gdInline + " const inline");
  ok(gdInline === 0, "không còn bản gdNorm chép đôi trong hàm khác");

  let pBody = null;
  try { pBody = fnBody(ioeSrc, "passageIsGameDesc"); } catch (e) {}
  ok(!!pBody, "có hàm passageIsGameDesc()");
  if (pBody) {
    ok(/gdNorm\(cand\)/.test(pBody) && /gdNorm\(gameDesc\)/.test(pBody),
      "passageIsGameDesc dùng gdNorm cho cả hai phía");
  }
}

// Chạy thật passageIsGameDesc + looksLikePassage để chắc hành vi đúng.
{
  // lấy 2 hàm ra khỏi file rồi chạy trong sandbox
  const fnSrc = fnBody(ioeSrc, "gdNorm") + "\n" + fnBody(ioeSrc, "passageIsGameDesc") + "\n" + fnBody(ioeSrc, "looksLikePassage");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fnSrc + "\nglobalThis.__t = { gdNorm, passageIsGameDesc, looksLikePassage };", ctx);
  const T = sandbox.__t;

  const gameDesc = "The beach is full of trash. Join IOE's team now to clean the beach! Read each passage carefully and choose the most suitable answer by selecting A, B, C or D. You have 20 minutes to answer all the questions. You will get points for each correct answer.";
  ok(T.passageIsGameDesc(gameDesc, gameDesc) === true,
    "đoạn văn TRÙNG gameDesc bị nhận ra (BUG#41: không nhồi hướng dẫn vào prompt)");

  const realPassage = "Generation Y, also known as Millennials, refers to those born between the early 1980s and late 1990s. They are curious and ready to accept changes. If there is a faster, better way of doing something, Millennials want to try it out. They also value teamwork. When working in a team, Millennials welcome different points of view and ideas from others.";
  ok(T.passageIsGameDesc(realPassage, gameDesc) === false,
    "đoạn văn THẬT không bị nhận nhầm là hướng dẫn");
  ok(T.looksLikePassage(realPassage, 120) === true, "đoạn văn thật qua được looksLikePassage");
  ok(T.looksLikePassage("Why didn't Fred Lorz get the gold medal?", 120) === false,
    "một CÂU HỎI đơn lẻ không qua được looksLikePassage");
  ok(T.passageIsGameDesc("", gameDesc) === false && T.passageIsGameDesc(realPassage, "") === false,
    "đầu vào rỗng không làm hàm ném lỗi");
}

// ============================ D. parseTagItems — MỘT mục vẫn phải cắt số thứ tự
// BUG#53 (live 23/09/2026, cùng vòng, ngay sau khi BUG#52 vào): chế độ từng-câu
// hỏi AI ĐÚNG MỘT câu mỗi lượt ⇒ tag chỉ có một mục ("1. D"). parseTagItems cũ
// đòi `numbered.length >= 2` mới chịu cắt số thứ tự, nên một mục rơi xuống nhánh
// fallback (chỉ tách theo [,;\n]) và trả về nguyên chuỗi "1. D" ⇒ /^([A-D])/ không
// khớp ⇒ CẢ 10 CÂU báo "AI không trả lời được" dù AI trả lời đúng 10/10.
// Đường gộp nhiều câu không lộ lỗi vì luôn có ≥2 mục — đây là lý do bug chỉ hiện
// ở chế độ mới.
console.log("\nD. parseTagItems — cắt số thứ tự cho cả MỘT mục");
{
  const fnSrc = fnBody(ioeSrc, "parseTagItems");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fnSrc + "\nglobalThis.__p = parseTagItems;", ctx);
  const P = sandbox.__p;

  // Chính chuỗi AI trả về trong lượt thi hỏng.
  const one = P("1. D");
  ok(JSON.stringify(one) === JSON.stringify(["D"]),
    "MỘT mục '1. D' → ['D'] (không còn dính tiền tố số)", JSON.stringify(one));
  ok(String(one[0]).match(/^([A-D])/) !== null,
    "items[0] qua được /^([A-D])/ — đúng cái đã chặn cả 10 câu");

  // Các dạng một mục khác phải đi cùng đường.
  ok(JSON.stringify(P("1) B")) === JSON.stringify(["B"]), "'1) B' → ['B']", JSON.stringify(P("1) B")));
  ok(JSON.stringify(P("1: A")) === JSON.stringify(["A"]), "'1: A' → ['A']", JSON.stringify(P("1: A")));
  ok(JSON.stringify(P("2. C")) === JSON.stringify([undefined, "C"]),
    "'2. C' giữ đúng vị trí theo số thứ tự", JSON.stringify(P("2. C")));
  ok(JSON.stringify(P("1. supposed")) === JSON.stringify(["supposed"]),
    "điền từ một mục '1. supposed' → ['supposed'] (đường FILL_WORDS cũng hưởng lợi)");

  // Đường gộp nhiều câu KHÔNG được đổi hành vi.
  ok(JSON.stringify(P("1. B, 2. A, 3. C")) === JSON.stringify(["B", "A", "C"]),
    "nhiều mục vẫn đúng thứ tự (đường gộp không hồi quy)");
  ok(JSON.stringify(P("1. B, 2. A, 3. C, 4. D, 5. A")) === JSON.stringify(["B", "A", "C", "D", "A"]),
    "5 mục vẫn đúng thứ tự");

  // Không có số thứ tự ⇒ fallback tách theo dấu phẩy vẫn phải chạy.
  ok(JSON.stringify(P("B")) === JSON.stringify(["B"]), "một chữ trần 'B' → ['B']");
  ok(JSON.stringify(P("B, A")) === JSON.stringify(["B", "A"]), "'B, A' → ['B','A']");
  ok(JSON.stringify(P("")) === JSON.stringify([]), "chuỗi rỗng → mảng rỗng, không ném lỗi");
}

console.log("\n" + (fail === 0 ? "✅ TẤT CẢ ĐẠT" : "❌ CÓ LỖI") +
  " — " + pass + " PASS, " + fail + " FAIL\n");
process.exit(fail === 0 ? 0 : 1);
