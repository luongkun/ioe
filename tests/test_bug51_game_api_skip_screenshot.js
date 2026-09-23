/**
 * test_bug51_game_api_skip_screenshot.js — BUG#51 (23/09/2026)
 * Đường game-API quên tắt ảnh → Groq bị đá khỏi chuỗi → solver không click câu nào.
 *
 * Bối cảnh (live, giabao10a1 — Vòng 3 Bài 1 "tai-tao-san-ho", 10 câu trắc nghiệm):
 *   Solver đọc API game đúng (10 câu, examKey 202608229E601F.00110), phân loại đúng
 *   "mcq_multi", rồi... KHÔNG click đáp án nào và trả về `undefined`. HUD đứng nguyên
 *   ở câu 1 / 0 điểm / 18:55, console chỉ có một dòng "⚠️ Không đọc được đoạn văn".
 *
 *   Truy ra: askAiForGame() — hàm mà MỌI solver game-API dùng để hỏi AI — gửi
 *   `images: null` với ý "đường này không cần ảnh". Nhưng service worker đọc `null`
 *   thành "content script chưa chụp, để tôi chụp bù" (nhánh captureVisibleTabWithRetry)
 *   → imageBase64 có giá trị → hasImages=true → `groq.usable = !!groqKey && !hasImages`
 *   = false → Groq bị LOẠI KHỎI CHUỖI dù key Groq hợp lệ và còn nguyên quota → chỉ
 *   còn Gemini đang 429 → solveWithAi ném lỗi → askAiForGame resolve {success:false}
 *   → solver không có đáp án nào để click.
 *
 *   Live-verified cùng một prompt, chỉ khác cờ:
 *     images:null                      → {"ok":false,"err":"Hết quota Gemini free tier (429)…"}
 *     images:null + skipScreenshot     → {"ok":true,"prov":"[MCQ_ANSWERS: 1. A]"} sau ~1s
 *   Sau khi bật cờ: bài chạy hết 10 câu, game kết thúc 90/100 (90% ≥ 70% ⇒ ĐẠT).
 *
 * BUG#50 đã thêm cờ skipScreenshot cho đường CHỤP ẢNH; đường game-API đơn giản là
 * quên truyền. Test này khoá cả hai đầu:
 *   A. content script — askAiForGame PHẢI gửi skipScreenshot:true, và mọi lời gọi
 *      SOLVE_CURRENT_SCREEN không kèm ảnh đều phải có cờ (nếu không, SW chụp bù).
 *   B. service worker — skipScreenshot:true ⇒ KHÔNG captureVisibleTab, và với chỉ key
 *      Groq thì Groq phải được gọi thật (Gemini không đụng tới).
 *   C. tương thích ngược — vắng cờ, vắng ảnh ⇒ vẫn chụp như cũ (đường ảnh thật).
 *
 * Chạy: node tests/test_bug51_game_api_skip_screenshot.js
 * (không cần mạng, không cần key, không cần Playwright)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SW_PATH = path.join(ROOT, "background", "service_worker.js");
const IOE_PATH = path.join(ROOT, "content", "ioe", "ioe.js");
const swSrc = fs.readFileSync(SW_PATH, "utf8");
const ioeSrc = fs.readFileSync(IOE_PATH, "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "  → " + extra : "")); }
}

// ---------------------------------------------------------------- sandbox SW
// Giống harness của test_bug50: chrome giả + fetch ghi lại lời gọi.
// captureVisibleTab ghi lại số lần bị gọi — đó là thứ chứng minh "không chụp bù".
function makeSw(storageOverrides, opts) {
  const o = opts || {};
  const storage = Object.assign({
    geminiApiKey: "", model: "gemini-3.6-flash",
    groqApiKey: "", preferProvider: "groq",
    groqModel: "openai/gpt-oss-120b", groqWhisperModel: "whisper-large-v3-turbo"
  }, storageOverrides || {});

  const calls = [];
  const captures = [];
  let onMessageListener = null;

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortSignal, Blob, FormData, TextEncoder, TextDecoder, URL,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    fetch: async (url, rawOpts) => {
      const u = String(url);
      calls.push({ url: u, body: rawOpts && rawOpts.body, headers: (rawOpts && rawOpts.headers) || {} });
      if (/api\.groq\.com\/openai\/v1\/chat\/completions/.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "[MCQ_ANSWERS: 1. A, 2. B]" } }] }),
          text: async () => "" };
      }
      if (/generativelanguage\.googleapis\.com/.test(u)) {
        if (o.geminiOk) {
          return { ok: true, status: 200,
            json: async () => ({ candidates: [{ content: { parts: [{ text: "[MCQ_ANSWERS: 1. A]" }] } }] }),
            text: async () => "" };
        }
        return { ok: false, status: 429, json: async () => ({ error: { message: "Quota exceeded" } }), text: async () => "" };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    },
    chrome: {
      storage: { local: {
        get: async (defaults) => Object.assign({}, defaults, storage),
        set: async (val) => Object.assign(storage, val)
      } },
      runtime: {
        onMessage: { addListener: (fn) => { onMessageListener = fn; } },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        lastError: null
      },
      contextMenus: { create: () => {}, removeAll: (cb) => cb && cb(), onClicked: { addListener: () => {} } },
      tabs: {
        captureVisibleTab: (...args) => {
          captures.push(args);
          const cb = args[args.length - 1];
          if (typeof cb === "function") cb("data:image/png;base64,SHOULD_NOT_BE_USED");
        },
        sendMessage: () => {}
      },
      debugger: { attach: async () => {}, sendCommand: async () => {} }
    }
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(swSrc, ctx, { filename: "service_worker.js" });

  const send = (msg) => new Promise((resolve) => {
    const sender = { tab: { windowId: 1 } };
    let settled = false;
    const done = (r) => { settled = true; resolve(r); };
    const ret = onMessageListener(msg, sender, done);
    if (ret !== true) { if (!settled) resolve(undefined); return; }
    setTimeout(() => { if (!settled) resolve({ __timeout: true }); }, 8000);
  });

  return { ctx, calls, captures, storage, send };
}

const chatCalls = (calls) => calls.filter(c => /chat\/completions/.test(c.url));

// ------------------------------------------------- trích thân hàm từ source
// (dùng lại đúng kỹ thuật của test_bug50: bỏ qua danh sách tham số trước khi
//  tìm `{` đầu tiên, và phân biệt regex với phép chia để không đếm nhầm ngoặc.)
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
  throw new Error("không tìm thấy hết danh sách tham số");
}

function fnBody(src, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = re.exec(src);
  if (!m) throw new Error("không tìm thấy hàm: " + name);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);

  let i = src.indexOf("{", skipParams(src, m.index));
  let depth = 0, inStr = null, inLine = false, inBlock = false, inRe = false, reCls = false;
  let prevSig = "";
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

// Lấy TRỌN object literal của lời gọi sendMessage quanh vị trí `action:`.
// Không dùng cửa sổ độ rộng cố định: một khối comment dài (rất hay gặp trong
// file này) sẽ đẩy các khoá ra ngoài cửa sổ và làm test báo lỗi sai.
function objectLiteralAround(src, idx) {
  // lùi về `{` mở của object literal gần nhất trước idx
  let start = -1, depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let i = idx; i >= 0; i--) {
    const ch = src[i];
    if (inStr) { if (ch === inStr && src[i - 1] !== "\\") inStr = null; continue; }
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "/" && src[i - 1] === "*") { inBlock = false; i--; } continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "}") depth++;
    else if (ch === "{") { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start < 0) return "";
  // tiến tới `}` đóng tương ứng
  depth = 0; inStr = null; inLine = false; inBlock = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && nx === "/") { inBlock = false; i++; } continue; }
    if (inStr) { if (ch === "\\") { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === "/" && nx === "/") { inLine = true; continue; }
    if (ch === "/" && nx === "*") { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return "";
}

// ============================================================ A. content script
console.log("\nA. content script — askAiForGame phải tắt ảnh tường minh");

let askBody = null;
try { askBody = fnBody(ioeSrc, "askAiForGame"); } catch (e) { askBody = null; }
ok(!!askBody, "trích được thân hàm askAiForGame");

if (askBody) {
  ok(/skipScreenshot\s*:\s*true/.test(askBody),
    "askAiForGame gửi skipScreenshot:true",
    "thiếu cờ ⇒ SW chụp bù ⇒ hasImages=true ⇒ Groq bị loại ⇒ Gemini 429");
  ok(/action\s*:\s*"SOLVE_CURRENT_SCREEN"/.test(askBody),
    "askAiForGame vẫn gửi action SOLVE_CURRENT_SCREEN");
  ok(/images\s*:\s*null/.test(askBody),
    "askAiForGame vẫn gửi images:null (không kèm ảnh)");
}

// Mọi lời gọi SOLVE_CURRENT_SCREEN trong content script phải hoặc có ảnh thật,
// hoặc có cờ skipScreenshot — nếu không, SW sẽ tự chụp và đá Groq đi.
{
  const callSites = [];
  const re = /action:\s*"SOLVE_CURRENT_SCREEN"/g;
  let m;
  while ((m = re.exec(ioeSrc))) {
    callSites.push(objectLiteralAround(ioeSrc, m.index));
  }
  ok(callSites.length >= 2, "tìm thấy ≥2 lời gọi SOLVE_CURRENT_SCREEN (" + callSites.length + ")");
  ok(callSites.every(o => o.length > 0), "trích được object literal của mọi lời gọi");
  const bad = callSites.filter(o => !/skipScreenshot/.test(o) && !/images:\s*capturedImages/.test(o));
  ok(bad.length === 0,
    "mọi lời gọi SOLVE_CURRENT_SCREEN đều có ảnh thật hoặc cờ skipScreenshot",
    bad.length ? bad.length + " lời gọi thiếu cả hai: " + bad.map(b => b.split("\n")[0].trim()).join(" ; ") : "");
}

// ============================================================ B. service worker
console.log("\nB. service worker — skipScreenshot:true ⇒ không chụp bù, Groq vẫn chạy");

(async () => {
  // B1: đúng message của askAiForGame (chỉ có key Groq, Gemini 429)
  {
    const sw = makeSw({ groqApiKey: "gsk_test", geminiApiKey: "gm_test" });
    const resp = await sw.send({
      action: "SOLVE_CURRENT_SCREEN", images: null, skipScreenshot: true,
      text: "\n\nTrả lời: [MCQ_ANSWERS: 1. A]", audioUrl: null, audioBase64: null,
      audioUrls: null, hint: "", examKind: "mcq_multi"
    });
    ok(sw.captures.length === 0,
      "skipScreenshot=true → KHÔNG gọi captureVisibleTab",
      "captures=" + sw.captures.length);
    ok(resp && resp.success === true,
      "solve thành công (không rơi vào Gemini 429)",
      resp && resp.error ? String(resp.error).slice(0, 120) : JSON.stringify(resp));
    ok(chatCalls(sw.calls).length === 1 && /api\.groq\.com/.test(chatCalls(sw.calls)[0].url),
      "Groq được gọi đúng 1 lần");
    ok(!sw.calls.some(c => /generativelanguage\.googleapis\.com/.test(c.url)),
      "Gemini KHÔNG bị đụng tới (Groq đã trả lời được)");
  }

  // B2: hồi quy — cùng message nhưng THIẾU cờ (lỗi BUG#51 nguyên bản).
  // Đây là test "đèn đỏ": nó chứng minh cờ là thứ duy nhất cứu được bài,
  // nên nếu ai đó gỡ cờ khỏi askAiForGame thì B1 sẽ đỏ theo.
  {
    const sw = makeSw({ groqApiKey: "gsk_test", geminiApiKey: "gm_test" });
    const resp = await sw.send({
      action: "SOLVE_CURRENT_SCREEN", images: null,
      text: "\n\nTrả lời: [MCQ_ANSWERS: 1. A]", audioUrl: null, audioBase64: null,
      audioUrls: null, hint: "", examKind: "mcq_multi"
    });
    ok(sw.captures.length === 1,
      "thiếu cờ → SW CHỤP BÙ (đúng cơ chế đã giết bài)");
    ok(chatCalls(sw.calls).length === 0,
      "thiếu cờ → Groq bị loại khỏi chuỗi, không hề được gọi");
    ok(resp && resp.success === false && /429|quota/i.test(String(resp.error)),
      "thiếu cờ → chết ở Gemini 429 (đúng triệu chứng live)",
      resp && resp.error ? String(resp.error).slice(0, 80) : JSON.stringify(resp));
  }

  // B3: tương thích ngược — không cờ, không ảnh, nhưng CÓ key Gemini dùng được
  // ⇒ vẫn phải chụp như cũ (đường ảnh thật: bài đọc, BUG#47).
  {
    const sw = makeSw({ geminiApiKey: "gm_test", preferProvider: "gemini" }, { geminiOk: true });
    const resp = await sw.send({
      action: "SOLVE_CURRENT_SCREEN", images: null,
      text: "\n\nĐọc đoạn văn trong ảnh", audioUrl: null, audioBase64: null,
      audioUrls: null, hint: "", examKind: null
    });
    ok(sw.captures.length === 1,
      "vắng cờ + vắng ảnh → vẫn chụp màn hình (đường ảnh không bị bỏ)");
    ok(resp && resp.success === true, "đường ảnh thật vẫn giải được");
  }

  // B4: ảnh có sẵn thì luôn thắng — cờ không được phép ghi đè ảnh thật.
  {
    const sw = makeSw({ geminiApiKey: "gm_test", preferProvider: "gemini" }, { geminiOk: true });
    const resp = await sw.send({
      action: "SOLVE_CURRENT_SCREEN", images: ["data:image/png;base64,REAL"],
      skipScreenshot: true,
      text: "\n\nĐọc đoạn văn", audioUrl: null, audioBase64: null,
      audioUrls: null, hint: "", examKind: null
    });
    ok(sw.captures.length === 0,
      "có ảnh sẵn + cờ → dùng ảnh đã gửi, không chụp thêm");
    ok(resp && resp.success === true, "ảnh có sẵn vẫn được đưa cho AI");
  }

  console.log("\n" + (fail === 0 ? "✅ TẤT CẢ ĐẠT" : "❌ CÓ LỖI") +
    " — " + pass + " PASS, " + fail + " FAIL\n");
  process.exit(fail === 0 ? 0 : 1);
})();
