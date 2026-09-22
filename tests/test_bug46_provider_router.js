/**
 * test_bug46_provider_router.js — BUG#46 (22/09/2026): bộ điều phối 2 provider
 *
 * Bối cảnh: Gemini free tier chỉ cho 20 request/PHÚT (`generate_content_free_tier_requests,
 * limit: 20` — đo thực tế khi chạy Vòng 7 Bài 4), mỗi bài thi solver gọi AI 5-10 lần
 * + retry nên cạn quota liên tục giữa bài. Gói Google AI Pro KHÔNG nâng hạn mức API
 * (hạn mức tính theo PROJECT; muốn lên phải bật billing).
 *
 * BUG#46 thêm Groq làm provider chính (free: 30 RPM, 1000 req/ngày, không cần thẻ)
 * và Gemini làm dự phòng. Test này khoá các quy tắc định tuyến — sai một quy tắc là
 * hoặc mất hẳn đường giải, hoặc đốt gấp đôi quota.
 *
 * Chạy: node tests/test_bug46_provider_router.js
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

// ---- dựng sandbox với chrome API giả + fetch ghi lại lời gọi ----
function makeEnv(storageOverrides) {
  const storage = Object.assign({
    geminiApiKey: "", model: "gemini-3.6-flash", autoShowToolbar: true,
    groqApiKey: "", preferProvider: "groq",
    groqModel: "openai/gpt-oss-120b", groqWhisperModel: "whisper-large-v3-turbo"
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
      calls.push({ url: u, body: opts && opts.body, headers: (opts && opts.headers) || {} });
      if (/api\.groq\.com\/openai\/v1\/chat\/completions/.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "[TF_ANSWERS: 1. True, 2. False]\nGiải thích." } }] }),
          text: async () => "" };
      }
      if (/api\.groq\.com\/openai\/v1\/audio\/transcriptions/.test(u)) {
        return { ok: true, status: 200, json: async () => ({}),
          text: async () => "Singapore is a small country. The food there is cheap." };
      }
      if (/generativelanguage\.googleapis\.com/.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "[TF_ANSWERS: 1. False]" }] } }] }),
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

const groqCalls = (calls) => calls.filter(c => /api\.groq\.com/.test(c.url));
const geminiCalls = (calls) => calls.filter(c => /generativelanguage/.test(c.url));
const chatCalls = (calls) => calls.filter(c => /chat\/completions/.test(c.url));
const whisperCalls = (calls) => calls.filter(c => /audio\/transcriptions/.test(c.url));

(async () => {
  // ------------------------------------------------------------------
  console.log("\nT1 — chỉ có key Groq, đề CHỮ: phải đi Groq, KHÔNG đụng Gemini");
  {
    const { calls, run } = makeEnv({ groqApiKey: "gsk_test" });
    const out = await run(`solveWithAi("Câu khẳng định: The food is cheap.", "ioe_auto", { examKind: "listening_tf" })`);
    ok(/TF_ANSWERS/.test(String(out)), "trả về đáp án parse được");
    ok(chatCalls(calls).length === 1, "gọi Groq chat đúng 1 lần", "nhận " + chatCalls(calls).length);
    ok(geminiCalls(calls).length === 0, "KHÔNG gọi Gemini (tiết kiệm quota)", "nhận " + geminiCalls(calls).length);
    const body = JSON.parse(chatCalls(calls)[0].body);
    ok(body.model === "openai/gpt-oss-120b", "dùng đúng model Groq đã cấu hình", body.model);
    ok(/Bearer gsk_test/.test(chatCalls(calls)[0].headers.Authorization || ""), "gửi Authorization Bearer đúng");
  }

  // ------------------------------------------------------------------
  console.log("\nT2 — đề NGHE: Whisper phiên âm TRƯỚC, transcript phải vào prompt");
  {
    const { calls, run } = makeEnv({ groqApiKey: "gsk_test" });
    await run(`solveWithAi("Xác định True/False", "ioe_auto", { audioObj: { base64: "AAAA", mimeType: "audio/mp3" }, examKind: "listening_tf" })`);
    ok(whisperCalls(calls).length === 1, "gọi Whisper đúng 1 lần", "nhận " + whisperCalls(calls).length);
    ok(chatCalls(calls).length === 1, "sau đó gọi chat đúng 1 lần");
    const body = JSON.parse(chatCalls(calls)[0].body);
    const user = body.messages.find(m => m.role === "user");
    const content = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    ok(/Singapore is a small country/.test(content),
       "transcript của Whisper được nhồi vào prompt",
       "prompt không chứa transcript");
    ok(/listening_tf|BÀI NGHE TRUE\/FALSE/.test(content),
       "prompt có chỉ thị dạng đề NGHE (không lẫn reading_tf)");
  }

  // ------------------------------------------------------------------
  console.log("\nT3 — đề có ẢNH: model chữ của Groq không có vision → phải đi Gemini, KHÔNG gọi Groq");
  {
    const { calls, run } = await makeEnv({ groqApiKey: "gsk_test", geminiApiKey: "AIza_test" });
    await run(`solveWithAi("đề bài", "ioe_auto", { imageBase64: "data:image/png;base64,AAAA" })`);
    ok(groqCalls(calls).length === 0, "KHÔNG gọi Groq khi có ảnh", "nhận " + groqCalls(calls).length);
    ok(geminiCalls(calls).length === 1, "gọi Gemini đúng 1 lần (không gọi đôi)", "nhận " + geminiCalls(calls).length);
  }

  // ------------------------------------------------------------------
  console.log("\nT4 — Groq lỗi (429): phải tự chuyển sang Gemini, không ném lỗi ra ngoài");
  {
    const { ctx, calls, run } = makeEnv({ groqApiKey: "gsk_test", geminiApiKey: "AIza_test" });
    // đổi fetch để Groq trả 429
    const origFetch = ctx.fetch;
    ctx.fetch = async (url, opts) => {
      if (/api\.groq\.com/.test(String(url))) {
        calls.push({ url: String(url), body: opts && opts.body, headers: (opts && opts.headers) || {} });
        return { ok: false, status: 429, json: async () => ({ error: { message: "Rate limit reached" } }), text: async () => "" };
      }
      return origFetch(url, opts);
    };
    const out = await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(/TF_ANSWERS/.test(String(out)), "vẫn có đáp án nhờ provider dự phòng");
    ok(geminiCalls(calls).length >= 1, "Gemini được gọi làm dự phòng");
  }

  // ------------------------------------------------------------------
  console.log("\nT5 — preferProvider='gemini': đảo thứ tự ưu tiên");
  {
    const { calls, run } = makeEnv({ groqApiKey: "gsk_test", geminiApiKey: "AIza_test", preferProvider: "gemini" });
    await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(geminiCalls(calls).length === 1, "Gemini gọi trước");
    ok(groqCalls(calls).length === 0, "Groq không gọi khi Gemini đã thành công");
  }

  // ------------------------------------------------------------------
  console.log("\nT6 — KHÔNG có key Groq: hành vi y như bản cũ (chỉ Gemini), không vỡ");
  {
    const { calls, run } = makeEnv({ groqApiKey: "", geminiApiKey: "AIza_test" });
    const out = await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(/TF_ANSWERS/.test(String(out)), "vẫn giải được bằng Gemini");
    ok(groqCalls(calls).length === 0, "không thử Groq khi thiếu key");
    ok(geminiCalls(calls).length === 1, "Gemini gọi đúng 1 lần");
  }

  // ------------------------------------------------------------------
  console.log("\nT7 — nhiều file audio (mỗi câu 1 file): phiên âm TỪNG file, gắn nhãn theo câu");
  {
    const { calls, run } = makeEnv({ groqApiKey: "gsk_test" });
    await run(`solveWithAi("đề nghe", "ioe_auto", {
      audioList: [
        { base64: "AAAA", mimeType: "audio/mp3", qIndex: 1 },
        { base64: "BBBB", mimeType: "audio/mp3", qIndex: 2 },
        { base64: "CCCC", mimeType: "audio/mp3", qIndex: 3 }
      ], examKind: "listening_tf" })`);
    ok(whisperCalls(calls).length === 3, "phiên âm đủ 3 file", "nhận " + whisperCalls(calls).length);
    const body = JSON.parse(chatCalls(calls)[0].body);
    const user = body.messages.find(m => m.role === "user");
    const content = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    ok(/AUDIO CÂU 1/.test(content) && /AUDIO CÂU 3/.test(content),
       "transcript gắn nhãn đúng theo câu (không gộp lẫn)");
  }

  // ------------------------------------------------------------------
  console.log("\nT8 — BUG#47b: 1 file audio DÙNG CHUNG cho bài 5 câu — prompt không được nói '1 câu'");
  {
    const { calls, run } = makeEnv({ groqApiKey: "gsk_test" });
    await run(`solveWithAi("BÀI NGHE TRUE/FALSE — 5 câu khẳng định:\\n1. Lucas worked on transportation\\n2. Housing and green space\\n3. Renewable energy\\n4. Unrealistic project\\n5. Innovative design", "ioe_auto", { audioList: [{ base64: "AAAA", mimeType: "audio/mp3", qIndex: 1 }], examKind: "listening_tf" })`);
    const body = JSON.parse(chatCalls(calls)[0].body);
    const user = body.messages.find(m => m.role === "user");
    const content = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
    ok(!/GỒM 1 CÂU/.test(content),
       "KHÔNG dặn 'GỒM 1 CÂU' khi 1 file phục vụ nhiều câu", "prompt vẫn đếm theo số file");
    ok(/DÙNG CHUNG CHO (TOÀN BỘ CÁC CÂU|MỌI CÂU)/.test(content),
       "nói rõ file là bài nghe của CẢ BÀI");
    ok(/ĐỦ mọi câu/.test(content),
       "vẫn đòi đủ đáp án cho mọi câu (không phải 1)");
  }

  console.log("\n" + "=".repeat(56));
  console.log(`KẾT QUẢ: ${pass}/${pass + fail} PASS` + (fail ? `  (${fail} FAIL)` : "  ✅"));
  console.log("=".repeat(56));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n❌ Test crash:", e && e.stack || e);
  process.exit(1);
});
