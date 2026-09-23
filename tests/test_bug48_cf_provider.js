/**
 * test_bug48_cf_provider.js — BUG#48 (22/09/2026): Cloudflare Workers AI là provider thứ BA
 *
 * Bối cảnh: Groq + Gemini là hai vendor khác nhau nhưng khi cả hai cùng cạn quota thì
 * solver vẫn tắc (đo thực tế 22/09/2026 trên Vòng 7 Bài 4: Gemini 429 cả 5 model, không
 * có key Groq nên không còn đường nào). Cloudflare Workers AI thêm một hạn mức ĐỘC LẬP
 * (10.000 Neurons/ngày, không cần thẻ) và có cả model chữ lẫn Whisper.
 *
 * Ba điểm dễ sai mà test này khoá lại:
 *   1. Cloudflare KHÔNG có audio trong bộ endpoint OpenAI-compatible — Whisper phải gọi
 *      REST run endpoint /ai/run/<model> với body là BYTES THÔ, không phải FormData như Groq.
 *   2. URL Cloudflare có ACCOUNT ID trong đường dẫn → thiếu Account ID thì provider phải
 *      bị loại khỏi chuỗi, KHÔNG được gọi mạng rồi lỗi.
 *   3. Lỗi của Cloudflare có shape riêng ({errors:[{message}]}) — không xử lý thì thông
 *      báo lỗi hiện ra thành "HTTP 400" vô nghĩa.
 *
 * Chạy: node tests/test_bug48_cf_provider.js
 * (nạp thẳng service_worker.js thật với chrome API giả — không cần mạng, không cần key)
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SW_PATH = path.join(__dirname, "..", "background", "service_worker.js");
const src = fs.readFileSync(SW_PATH, "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "  → " + extra : "")); }
}

const CF_ACC = "acc1234567890";
const CF_TRANSCRIPT = "Singapore is a small country. The food there is cheap.";

function makeEnv(storageOverrides) {
  const storage = Object.assign({
    geminiApiKey: "", model: "gemini-3.6-flash", autoShowToolbar: true,
    groqApiKey: "", preferProvider: "groq",
    groqModel: "openai/gpt-oss-120b", groqWhisperModel: "whisper-large-v3-turbo",
    cfApiKey: "", cfAccountId: "", cfModel: "@cf/openai/gpt-oss-120b",
    cfWhisperModel: "@cf/openai/whisper-large-v3-turbo"
  }, storageOverrides || {});

  const calls = [];
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortSignal, Blob, FormData, TextEncoder, TextDecoder,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    fetch: async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, body: opts && opts.body, headers: (opts && opts.headers) || {}, method: (opts && opts.method) || "GET" });
      if (/api\.groq\.com\/openai\/v1\/chat\/completions/.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "[TF_ANSWERS: 1. True, 2. False]\nGroq giải." } }] }),
          text: async () => "" };
      }
      if (/api\.groq\.com\/openai\/v1\/audio\/transcriptions/.test(u)) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => "Groq transcript." };
      }
      // Cloudflare Whisper: REST run endpoint, body bytes thô.
      if (/api\.cloudflare\.com\/.*\/ai\/run\//.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ result: { text: CF_TRANSCRIPT }, success: true }),
          text: async () => "" };
      }
      // Cloudflare chat: OpenAI-compatible.
      if (/api\.cloudflare\.com\/.*\/ai\/v1\/chat\/completions/.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "[TF_ANSWERS: 1. False, 2. True]\nCloudflare giải." } }] }),
          text: async () => "" };
      }
      if (/generativelanguage\.googleapis\.com/.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "[TF_ANSWERS: 1. False]\nGemini giải." }] } }] }),
          text: async () => "" };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    },
    chrome: {
      storage: { local: {
        get: async (defaults) => Object.assign({}, defaults, storage),
        set: async (o) => Object.assign(storage, o)
      } },
      runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} },
                 onStartup: { addListener: () => {} }, lastError: null },
      contextMenus: { create: () => {}, removeAll: (cb) => cb && cb(), onClicked: { addListener: () => {} } },
      tabs: { captureVisibleTab: () => {}, sendMessage: () => {} },
      debugger: { attach: async () => {}, sendCommand: async () => {} }
    }
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: "service_worker.js" });
  return { ctx, calls, storage, run: (e) => vm.runInContext(e, ctx) };
}

const cfCalls = (calls) => calls.filter(c => /api\.cloudflare\.com/.test(c.url));
const cfChat = (calls) => cfCalls(calls).filter(c => /\/ai\/v1\/chat\/completions/.test(c.url));
const cfWhisper = (calls) => cfCalls(calls).filter(c => /\/ai\/run\//.test(c.url));
const groqChat = (calls) => calls.filter(c => /api\.groq\.com.*chat\/completions/.test(c.url));
const geminiCalls = (calls) => calls.filter(c => /generativelanguage/.test(c.url));

const userContentOf = (call) => {
  const body = JSON.parse(call.body);
  const user = body.messages.find(m => m.role === "user");
  return typeof user.content === "string" ? user.content : JSON.stringify(user.content);
};

(async () => {
  // ------------------------------------------------------------------
  console.log("\nT1 — chỉ có key Cloudflare, đề CHỮ: đi Cloudflare, không đụng Groq/Gemini");
  {
    const { calls, run } = makeEnv({ cfApiKey: "cf_test", cfAccountId: CF_ACC });
    const out = await run(`solveWithAi("Câu khẳng định: The food is cheap.", "ioe_auto", { examKind: "listening_tf" })`);
    ok(/TF_ANSWERS/.test(String(out)), "trả về đáp án parse được");
    ok(cfChat(calls).length === 1, "gọi Cloudflare chat đúng 1 lần", "nhận " + cfChat(calls).length);
    ok(groqChat(calls).length === 0, "KHÔNG gọi Groq khi thiếu key", "nhận " + groqChat(calls).length);
    ok(geminiCalls(calls).length === 0, "KHÔNG gọi Gemini (tiết kiệm quota)", "nhận " + geminiCalls(calls).length);
    const url = cfChat(calls)[0].url;
    ok(url.includes(CF_ACC), "URL có Account ID trong đường dẫn", url);
    ok(/\/client\/v4\/accounts\/[^/]+\/ai\/v1\/chat\/completions$/.test(url), "đúng path OpenAI-compatible của Cloudflare", url);
    const body = JSON.parse(cfChat(calls)[0].body);
    ok(body.model === "@cf/openai/gpt-oss-120b", "dùng đúng model Cloudflare đã cấu hình", body.model);
    ok(/Bearer cf_test/.test(cfChat(calls)[0].headers.Authorization || ""), "gửi Authorization Bearer đúng");
  }

  // ------------------------------------------------------------------
  console.log("\nT2 — đề NGHE: phải gọi REST run endpoint /ai/run/ (KHÔNG phải FormData như Groq)");
  {
    const { calls, run } = makeEnv({ cfApiKey: "cf_test", cfAccountId: CF_ACC });
    await run(`solveWithAi("Xác định True/False", "ioe_auto", { audioObj: { base64: "AAAA", mimeType: "audio/mp3" }, examKind: "listening_tf" })`);
    ok(cfWhisper(calls).length === 1, "gọi Whisper của Cloudflare đúng 1 lần", "nhận " + cfWhisper(calls).length);
    const w = cfWhisper(calls)[0];
    ok(/\/ai\/run\/%40cf%2Fopenai%2Fwhisper-large-v3-turbo$/.test(w.url),
       "đúng REST run endpoint (model được encodeURIComponent)", w.url);
    ok(!(w.body instanceof FormData), "body là BYTES THÔ, không phải FormData (Cloudflare khác Groq)", String(w.body && w.body.constructor && w.body.constructor.name));
    ok(w.method === "POST", "dùng POST");
    ok(cfChat(calls).length === 1, "phiên âm xong mới gọi chat đúng 1 lần");
    ok(new RegExp(CF_TRANSCRIPT.split(" ")[0] + ".*" + CF_TRANSCRIPT.split(" ").pop()).test(userContentOf(cfChat(calls)[0])),
       "transcript của Cloudflare được nhồi vào prompt",
       "prompt không chứa transcript");
  }

  // ------------------------------------------------------------------
  console.log("\nT3 — chuỗi 3 provider: Groq 429 → Cloudflare đỡ, Gemini KHÔNG bị gọi");
  {
    const { ctx, calls, run } = makeEnv({
      groqApiKey: "gsk_test", cfApiKey: "cf_test", cfAccountId: CF_ACC, geminiApiKey: "AIza_test"
    });
    const origFetch = ctx.fetch;
    ctx.fetch = async (url, opts) => {
      if (/api\.groq\.com/.test(String(url))) {
        calls.push({ url: String(url), body: opts && opts.body, headers: (opts && opts.headers) || {}, method: "POST" });
        return { ok: false, status: 429, json: async () => ({ error: { message: "Rate limit reached" } }), text: async () => "" };
      }
      return origFetch(url, opts);
    };
    const out = await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(/TF_ANSWERS/.test(String(out)), "vẫn có đáp án nhờ provider thứ ba");
    ok(groqChat(calls).length === 1, "Groq thử trước (ưu tiên mặc định)");
    ok(cfChat(calls).length === 1, "Cloudflare đỡ khi Groq 429");
    ok(geminiCalls(calls).length === 0, "Gemini KHÔNG bị đụng tới (tiết kiệm hạn mức cuối)", "nhận " + geminiCalls(calls).length);
  }

  // ------------------------------------------------------------------
  console.log("\nT4 — đề có ẢNH + model Cloudflare text-only → bỏ Cloudflare, đi Gemini");
  {
    const { calls, run } = makeEnv({ cfApiKey: "cf_test", cfAccountId: CF_ACC, geminiApiKey: "AIza_test" });
    await run(`solveWithAi("đề bài", "ioe_auto", { imageBase64: "data:image/png;base64,AAAA" })`);
    ok(cfCalls(calls).length === 0, "KHÔNG gọi Cloudflare khi model không có vision", "nhận " + cfCalls(calls).length);
    ok(geminiCalls(calls).length === 1, "Gemini gọi đúng 1 lần (không gọi đôi)", "nhận " + geminiCalls(calls).length);
  }

  // ------------------------------------------------------------------
  console.log("\nT5 — thiếu Account ID: Cloudflare bị LOẠI khỏi chuỗi, không gọi mạng");
  {
    const { calls, run } = makeEnv({ cfApiKey: "cf_test", cfAccountId: "", geminiApiKey: "AIza_test" });
    await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(cfCalls(calls).length === 0, "không thử Cloudflare khi thiếu Account ID", "nhận " + cfCalls(calls).length);
    ok(geminiCalls(calls).length === 1, "Gemini vẫn chạy bình thường");
  }

  // ------------------------------------------------------------------
  console.log("\nT6 — preferProvider='cloudflare': Cloudflare chạy TRƯỚC Groq");
  {
    const { calls, run } = makeEnv({
      groqApiKey: "gsk_test", cfApiKey: "cf_test", cfAccountId: CF_ACC, preferProvider: "cloudflare"
    });
    await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(cfChat(calls).length === 1, "Cloudflare chạy trước");
    ok(groqChat(calls).length === 0, "Groq không gọi khi Cloudflare đã thành công");
  }

  // ------------------------------------------------------------------
  console.log("\nT7 — cả 3 provider đều lỗi → thông báo phải nêu ĐỦ tên 3 provider");
  {
    const { ctx, run } = makeEnv({
      groqApiKey: "gsk_test", cfApiKey: "cf_test", cfAccountId: CF_ACC, geminiApiKey: "AIza_test"
    });
    ctx.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" });
    let msg = "";
    try { await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`); }
    catch (e) { msg = String(e && e.message); }
    ok(/Groq/.test(msg), "thông báo có tên Groq", msg);
    ok(/Cloudflare/.test(msg), "thông báo có tên Cloudflare", msg);
    ok(/Gemini/.test(msg), "thông báo có tên Gemini", msg);
    ok(/Cả 3 provider/.test(msg), "nói rõ số provider đã thử", msg);
  }

  // ------------------------------------------------------------------
  console.log("\nT8 — lỗi Cloudflare có shape riêng {errors:[{message}]} → phải hiện thông điệp thật");
  {
    const { ctx, run } = makeEnv({
      cfApiKey: "cf_bad", cfAccountId: CF_ACC, geminiApiKey: ""
    });
    ctx.fetch = async (url) => {
      if (/api\.cloudflare\.com/.test(String(url))) {
        return { ok: false, status: 403,
          json: async () => ({ success: false, errors: [{ code: 10000, message: "Authentication error: invalid API token" }] }),
          text: async () => "" };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    };
    let msg = "";
    try { await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`); }
    catch (e) { msg = String(e && e.message); }
    ok(/invalid API token/i.test(msg), "thông điệp thật của Cloudflare hiện ra", msg);
    ok(!/undefined/.test(msg), "không lộ chữ 'undefined' trong thông báo lỗi", msg);
  }

  console.log("\n" + "=".repeat(56));
  console.log(`KẾT QUẢ: ${pass}/${pass + fail} PASS` + (fail ? `  (${fail} FAIL)` : "  ✅"));
  console.log("=".repeat(56));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n❌ Test crash:", (e && e.stack) || e);
  process.exit(1);
});
