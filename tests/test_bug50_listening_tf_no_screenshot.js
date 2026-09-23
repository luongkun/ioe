/**
 * test_bug50_listening_tf_no_screenshot.js — BUG#50 (23/09/2026)
 * Đề NGHE True/False nhiều file bị đá khỏi Groq chỉ vì một tấm ảnh vô dụng.
 *
 * Bối cảnh (live, tài khoản giabao10a1 — Vòng 2, lớp 11, dạng "đọc rác bãi biển"):
 *   Bài 4 đã từng đạt 100/100, nhưng lần chạy sau đó rơi vào Gemini 429 liên tục
 *   dù key Groq vẫn còn quota. Truy ra: luồng chung trong content script LUÔN gọi
 *   captureSmartScreenshotsWithAutoScroll() → gửi kèm ảnh → service worker đặt
 *   hasImages=true → `groq.usable = !!groqKey && !hasImages` = false → Groq bị
 *   LOẠI KHỎI CHUỖI, chỉ còn Gemini đang cạn quota.
 *   Lượt đạt 100/100 trước đó chỉ thành công vì lần ấy chụp ảnh lỗi nên không có ảnh.
 *
 * Với dạng đề này ảnh KHÔNG mang thông tin nào: đáp án nằm trọn trong audio (mỗi câu
 * một file nghe) và phần chữ đã chính xác 100% từ buildGameApiPromptText(). Nên ảnh
 * phải bị bỏ ở nơi sinh ra nó, KHÔNG phải bằng cách gỡ cổng `!hasImages` — cổng đó
 * còn phải chặn trường hợp đề mà đáp án CHỈ nằm trong ảnh (bài đọc, BUG#47).
 *
 * Khoá lại 6 bất biến:
 *   1. content script: skipScreenshot được tính & gửi kèm, và chỉ bật khi MỌI câu
 *      đều là câu nghe (bài đọc phải giữ ảnh).
 *   2. skipScreenshot=true → SW KHÔNG gọi chrome.tabs.captureVisibleTab (không chụp bù).
 *   3. skipScreenshot=true + chỉ có key Groq → Groq vẫn được gọi, Gemini không đụng tới.
 *   4. request.images có sẵn → ảnh vẫn được dùng (đường ảnh thật không bị bỏ).
 *   5. KHÔNG skipScreenshot, không images → vẫn chụp như cũ (tương thích ngược).
 *   6. Đề có ảnh thật (không skip) → Groq vẫn bị loại (cổng ngữ nghĩa còn nguyên).
 *
 * Chạy: node tests/test_bug50_listening_tf_no_screenshot.js
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

// ---- sandbox service worker: chrome giả + fetch ghi lại lời gọi ----
// captureVisibleTab ghi lại số lần bị gọi — đó chính là thứ BUG#50 cần khoá.
// opts.geminiOk=true cho Gemini trả lời được (để kiểm đường ảnh thật chạy tới nơi);
// mặc định false = Gemini 429, đúng tình trạng thật đã làm bài chết.
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

      // Tải file nghe về (fetchAudioAsBase64 cần arrayBuffer()).
      if (/\.(mp3|wav|ogg|m4a)(\?|$)/i.test(u)) {
        const bytes = new Uint8Array([65, 65, 65, 65]);
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer,
                 json: async () => ({}), text: async () => "" };
      }
      if (/api\.groq\.com\/openai\/v1\/chat\/completions/.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "[TF_ANSWERS: 1. True, 2. False]\nXong." } }] }),
          text: async () => "" };
      }
      if (/api\.groq\.com\/openai\/v1\/audio\/transcriptions/.test(u)) {
        return { ok: true, status: 200, json: async () => ({}),
          text: async () => "Singapore is a small country. The food there is cheap." };
      }
      if (/generativelanguage\.googleapis\.com/.test(u)) {
        if (o.geminiOk) {
          return { ok: true, status: 200,
            json: async () => ({ candidates: [{ content: { parts: [{ text: "[TF_ANSWERS: 1. True]" }] } }] }),
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

  // Gửi một message y như content script gửi, rồi chờ sendResponse.
  const send = (msg) => new Promise((resolve) => {
    const sender = { tab: { windowId: 1 } };
    let settled = false;
    const done = (r) => { settled = true; resolve(r); };
    const ret = onMessageListener(msg, sender, done);
    if (ret !== true) { if (!settled) resolve(undefined); return; }
    // sendResponse có thể tới muộn; chặn trần 8s để test không treo.
    setTimeout(() => { if (!settled) resolve({ __timeout: true }); }, 8000);
  });

  return { ctx, calls, captures, storage, send };
}

const chatCalls = (calls) => calls.filter(c => /chat\/completions/.test(c.url));
const geminiCalls = (calls) => calls.filter(c => /generativelanguage/.test(c.url));
const whisperCalls = (calls) => calls.filter(c => /audio\/transcriptions/.test(c.url));

// ---- trích thân hàm từ file thật ----
// Hai cái bẫy đã dính khi viết test này, ghi lại để không lặp:
//   1. Tham số mặc định của hàm là `options = {}` — nếu đếm ngoặc từ dấu "{" đầu
//      tiên tìm được thì thân hàm bị cắt còn đúng dòng khai báo. Phải NHẢY QUA
//      danh sách tham số trước (skipParams) rồi mới lấy "{" kế tiếp.
//   2. Hàm có regex literal (`.replace(/&/g, ...)`) — nếu coi mọi "/" là comment
//      hoặc không xử lý "/" đóng regex thì bộ đếm trôi mất và hàm "không đóng ngoặc".
//      Phân biệt regex với phép chia bằng token đáng kể trước đó.
function skipParams(src, from) {
  let i = src.indexOf("(", from), d = 0, inStr = null, inLine = false, inBlock = false;
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && nx === "/") { inBlock = false; i++; } continue; }
    if (inStr) { if (ch === "\\") { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === "/" && nx === "/") { inLine = true; continue; }
    if (ch === "/" && nx === "*") { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "(") d++;
    else if (ch === ")") { d--; if (d === 0) return i + 1; }
  }
  throw new Error("không đóng danh sách tham số");
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

(async () => {
  // ------------------------------------------------------------------
  console.log("\nT1 — content script: cờ skipScreenshot phải được tính và gửi kèm");
  {
    const body = fnBody(ioeSrc, "executeScreenAndAudioSolve");
    ok(body.length > 5000, "trích được thân hàm thật", "chỉ " + body.length + " ký tự");
    ok(/skipScreenshot/.test(body), "có tính biến skipScreenshot trong luồng chung");
    // Cờ phải nằm TRONG object gửi kèm SOLVE_CURRENT_SCREEN (dùng shorthand nên
    // không có dấu ":" — chấp nhận cả hai dạng).
    const sendObj = (body.match(/action:\s*"SOLVE_CURRENT_SCREEN"[\s\S]{0,400}?\}\s*,/) || [""])[0];
    ok(/skipScreenshot/.test(sendObj), "gửi skipScreenshot trong message SOLVE_CURRENT_SCREEN",
       "không thấy trong object sendMessage");
    ok(/capturedImages\s*=\s*skipScreenshot\s*\?\s*\[\]/.test(body),
       "BỎ hẳn ảnh khi skipScreenshot (không chụp rồi vứt)");
    ok(/skipScreenshot\s*=\s*isMultiTfExam\s*\|\|/.test(body),
       "điều kiện skip có nhánh đề nghe TF nhiều file");
    // Bất biến quan trọng: KHÔNG được bỏ ảnh cho mọi bài nghe — bài đọc (BUG#47)
    // phải giữ ảnh. Nhánh mở rộng phải đòi MỌI câu đều có audio, và điều kiện đó
    // phải thật sự nằm trong biểu thức quyết định skip (qua biến trung gian).
    const audioAll = (body.match(/[^\n]*audioCoversAllQuestions\s*=[^\n]*/) || [""])[0];
    ok(/every\(q\s*=>\s*q\.isListening\)/.test(audioAll),
       "điều kiện 'mọi câu đều là câu nghe' định nghĩa đúng", audioAll.trim());
    const skipLine = (body.match(/[^\n]*skipScreenshot\s*=[^\n]*/) || [""])[0];
    ok(/isMultiTfExam/.test(skipLine) && /audioCoversAllQuestions/.test(skipLine),
       "biểu thức skip dùng cả hai điều kiện (bài đọc không bị bỏ ảnh)", skipLine.trim());
  }

  // ------------------------------------------------------------------
  console.log("\nT2 — SW: skipScreenshot=true → KHÔNG chụp bù, Groq vẫn chạy");
  {
    const { calls, captures, send } = makeSw({ groqApiKey: "gsk_test" });
    const resp = await send({
      action: "SOLVE_CURRENT_SCREEN",
      images: null,
      skipScreenshot: true,
      text: "DỮ LIỆU ĐỀ THI... câu 1, câu 2",
      audioUrls: ["https://x/a1.mp3", "https://x/a2.mp3"],
      examKind: "tf"
    });
    ok(captures.length === 0, "KHÔNG gọi captureVisibleTab", "bị gọi " + captures.length + " lần");
    ok(resp && resp.success, "trả về success", resp && resp.error);
    ok(chatCalls(calls).length === 1, "Groq chat được gọi đúng 1 lần", "nhận " + chatCalls(calls).length);
    ok(geminiCalls(calls).length === 0, "KHÔNG đụng Gemini (còn quota)", "nhận " + geminiCalls(calls).length);
    ok(whisperCalls(calls).length === 2, "phiên âm đủ 2 file nghe", "nhận " + whisperCalls(calls).length);
    const body = JSON.parse(chatCalls(calls)[0].body);
    const user = body.messages.find(m => m.role === "user");
    ok(typeof user.content === "string",
       "prompt là CHUỖI (không có content part ảnh nào lẫn vào)");
  }

  // ------------------------------------------------------------------
  console.log("\nT3 — SW: request.images có sẵn → ảnh VẪN được dùng (đường ảnh không bị bỏ)");
  {
    const { calls, captures, send } = makeSw({ groqApiKey: "gsk_test", geminiApiKey: "AIza_test" }, { geminiOk: true });
    const resp = await send({
      action: "SOLVE_CURRENT_SCREEN",
      images: ["data:image/png;base64,AAAA"],
      text: "đề bài có ảnh",
      examKind: null
    });
    ok(captures.length === 0, "không chụp thêm vì content script đã gửi ảnh");
    ok(resp && resp.success, "trả về success", resp && resp.error);
    ok(geminiCalls(calls).length === 1, "ảnh đi qua Gemini (provider có vision)", "nhận " + geminiCalls(calls).length);
    ok(chatCalls(calls).length === 0, "Groq bị loại khi có ảnh thật — cổng ngữ nghĩa còn nguyên");
  }

  // ------------------------------------------------------------------
  console.log("\nT4 — SW: không skip, không images → vẫn chụp như cũ (tương thích ngược)");
  {
    const { captures, send } = makeSw({ geminiApiKey: "AIza_test" }, { geminiOk: true });
    const resp = await send({
      action: "SOLVE_CURRENT_SCREEN",
      text: "đề bài",
      examKind: null
    });
    ok(captures.length >= 1, "vẫn chụp màn hình như hành vi cũ", "bị gọi " + captures.length + " lần");
    ok(resp && resp.success, "trả về success", resp && resp.error);
  }

  // ------------------------------------------------------------------
  console.log("\nT5 — SW: đề nghe + CÓ ảnh thật (không skip) → Groq vẫn phải bị loại");
  {
    const { calls, send } = makeSw({ groqApiKey: "gsk_test", geminiApiKey: "AIza_test" }, { geminiOk: true });
    const resp = await send({
      action: "SOLVE_CURRENT_SCREEN",
      images: ["data:image/png;base64,AAAA"],
      text: "đề nghe",
      audioUrls: ["https://x/a1.mp3"],
      examKind: "tf"
    });
    ok(resp && resp.success, "trả về success", resp && resp.error);
    ok(geminiCalls(calls).length === 1, "đi Gemini vì ảnh chưa được bỏ ở nguồn", "nhận " + geminiCalls(calls).length);
    ok(chatCalls(calls).length === 0, "KHÔNG để Groq đoán mò khi ảnh là thông tin thật");
  }

  // ------------------------------------------------------------------
  console.log("\nT6 — SW: skipScreenshot + mọi provider đều hỏng → báo lỗi rõ, không treo");
  {
    const { send } = makeSw({ geminiApiKey: "AIza_test" }); // Gemini 429, không có key Groq
    const resp = await send({
      action: "SOLVE_CURRENT_SCREEN",
      images: null,
      skipScreenshot: true,
      text: "đề nghe",
      audioUrls: ["https://x/a1.mp3"],
      examKind: "tf"
    });
    ok(resp && resp.__timeout !== true, "không treo (sendResponse có được gọi)");
    ok(resp && resp.success === false, "trả success:false");
    ok(resp && /429|quota|quá tải/i.test(String(resp.error || "")),
       "thông báo lỗi nói rõ nguyên nhân", resp && resp.error);
  }

  console.log("\n" + "=".repeat(56));
  console.log(`KẾT QUẢ: ${pass}/${pass + fail} PASS` + (fail ? `  (${fail} FAIL)` : "  ✅"));
  console.log("=".repeat(56));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n❌ Test crash:", (e && e.stack) || e);
  process.exit(1);
});
