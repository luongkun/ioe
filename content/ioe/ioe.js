/**
 * English Master AI - Dedicated IOE Universal Game Solver v3.5
 * Supports: True/False Listening (Dọn rác bãi biển), Matching Pairs (Ghép Cặp 12 ô), MCQ (Tái tạo san hô, Fansipan, Leo núi), Long Reading Passage Auto-Scroll & Extraction
 */

(function () {
  if (window.__IOE_MASTER_LOADED__) return;
  window.__IOE_MASTER_LOADED__ = true;

  console.log("%c[English Master AI v3.5] IOE True/False, MCQ & Reading Passage Engine Active!", "color: #10b981; font-weight: bold; font-size: 14px;");

  // 1. Super Unblocker
  function superUnblockAll() {
    ["contextmenu", "selectstart", "copy", "cut", "paste"].forEach(evt => {
      window.addEventListener(evt, (e) => {
        e.stopImmediatePropagation();
      }, true);
    });

    const style = document.createElement("style");
    style.id = "ioe-super-unblock-style";
    style.innerHTML = `
      body, *, div, p, span, h1, h2, h3, h4, section, article {
        user-select: text !important;
        -webkit-user-select: text !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  superUnblockAll();

  // 1.5 GAME API BRIDGE (Cocos Creator IOE games) - receives exact exam JSON
  let gameBridgeState = null;
  let gameBridgeError = null;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || !d.__ioeBridge) return;
    if (d.type === "GETINFO" || d.type === "SYNC") {
      gameBridgeState = d.payload || null;
      gameBridgeError = null;
      if (gameBridgeState && gameBridgeState.questions) {
        const n = gameBridgeState.questions.length;
        console.log(`[English Master AI] 🎮 IOE game API: ${n} câu hỏi (examKey ${gameBridgeState.examKey})`);
        const badge = document.getElementById("ioe-game-api-badge");
        if (badge) {
          badge.textContent = `🎮 API ${n} câu`;
          badge.classList.remove("hidden");
        }
      }
    } else if (d.type === "GETINFO_ERROR") {
      // BUG#8: token game chỉ dùng 1 lần — báo rõ thay vì đứng im
      gameBridgeError = (d.extra && d.extra.message) || "Lỗi quyền truy cập";
      console.warn("[English Master AI] ⚠️ API game từ chối: " + gameBridgeError);
      showToast("⚠️ API game từ chối (token mỗi lần chỉ dùng 1 lần). Hãy tải lại trang (F5) rồi bấm Tự Làm lại.");
    } else if (d.type === "ANSWERCHECK") {
      if (gameBridgeState) gameBridgeState.lastAnswerCheck = d.payload;
    }
  });

  function requestGameBridgeSync() {
    try { window.postMessage({ __ioeBridgeRequest: true, type: "SYNC_STATE" }, window.location.origin); } catch (e) {}
  }

  function getGameQuestions() {
    if (gameBridgeState && gameBridgeState.questions && gameBridgeState.questions.length) {
      return gameBridgeState.questions;
    }
    return null;
  }

  // In-memory fallback: try to read the MAIN-world bridge directly (works if same world)
  function getGameBridgeStateDirect() {
    try {
      if (window.__IOE_GAME_BRIDGE__ && window.__IOE_GAME_BRIDGE__.getState) return window.__IOE_GAME_BRIDGE__.getState();
    } catch (e) {}
    return gameBridgeState;
  }

  // RPC to the MAIN-world Cocos bridge (for clicking nodes on the canvas)
  function ioeBridgeRequest(type, data, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const reqId = "rpc_" + type + "_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      let done = false;
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || !d.__ioeBridge) return;
        if (d.reqId !== reqId) return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(d);
      };
      window.addEventListener("message", onMsg);
      try { window.postMessage({ __ioeBridgeRequest: true, type, data, reqId }, window.location.origin); } catch (e) { resolve(null); return; }
      setTimeout(() => { if (!done) { window.removeEventListener("message", onMsg); resolve(null); } }, timeoutMs);
    });
  }

  function isCocosGame() {
    try { return !!(window.__IOE_GAME_BRIDGE__) || !!(gameBridgeState && gameBridgeState.questions && gameBridgeState.questions.length); } catch (e) { return false; }
  }

  function isImageRef(s) {
    return typeof s === "string" && /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(s);
  }

  // Build [ [prompt, answer], ... ] pairs from the exact game JSON (text-only pairs)
  function deriveMatchPairsFromGameApi() {
    const qs = getGameQuestions();
    if (!qs || !qs.length) return [];
    const pairs = [];
    for (const q of qs) {
      const prompt = (q.prompt || "").trim();
      const ans = (q.tans && q.tans.length) ? String(q.tans[0]).trim() : ((q.answers && q.answers.length) ? String(q.answers[0]).trim() : "");
      if (!prompt || !ans) continue;
      if (isImageRef(prompt) || isImageRef(ans)) continue;
      if (/^https?:\/\//i.test(prompt) || /^https?:\/\//i.test(ans)) continue;
      pairs.push([prompt, ans]);
    }
    return pairs;
  }

  // ===================== DATA-DRIVEN EXAM CLASSIFIER (BUG#1 fix) =====================
  // Classify from the ACTUAL API payload (mask/answers/tans/format/audio) — NOT from
  // the game URL or name — so a NEW game type or the "same exam in a different
  // form" is still recognised correctly every time.
  function classifyExam(qs) {
    if (!qs || !qs.length) return "unknown";
    const allF25 = qs.every(q => q.format === 25);
    const allListening = qs.every(q => q.isListening && q.audio);
    const allMasked = qs.every(q => q.masked);
    const withTans = qs.filter(q => q.tans && q.tans.length);
    const withOptions = qs.filter(q => q.answers && q.answers.length >= 2);
    const textPairs = deriveMatchPairsFromGameApi();

    // ===== 2 dạng mới gặp ở Vòng 6 (live 16/09/2026) =====
    // * transform_typing (hanh-tinh-tim): format 19 + type 3 — biến đổi câu
    //   "It is important that..." → gõ "must be careful" vào EditBox. API trả
    //   sẵn word-bank (bị xáo trộn) trong answers, cần AI đặt theo ngữ pháp.
    const allF19T3 = qs.every(q => q.format === 19 && q.type === 3);
    if (allF19T3 && withOptions.length === qs.length) return "transform_typing";
    // * cloze_chip (cuon-giay-bi-an): 1 câu duy nhất, prompt là word-bank phân
    //   cách bằng "|" ("every|all|by|called|took|scored") — điền từ vào đoạn văn
    //   bằng cách chọn chip; nộp qua controller (submitCloze).
    const pipeBank = qs.length === 1 && /^\s*\w+(\|\w+)+\s*$/.test(String(qs[0].prompt || ""));
    if (pipeBank) return "cloze_chip";

    // Thứ tự quan trọng: lựa chọn (options) / đáp án sẵn (tans) được xét TRƯỚC
    // mask — đề trắc nghiệm có stem "______" không bị nhận nhầm thành điền từ.
    if (allF25 && textPairs.length >= Math.ceil(qs.length * 0.5)) return "matching";
    if (withTans.length === qs.length) return "mcq_known";   // every answer already in API
    if (withOptions.length === qs.length) return "mcq_multi"; // options but no tans → AI picks
    if (allMasked) return "listening_fillword";               // masked prompts, NO options → listen & type
    if (allListening) return "listening_tf";
    return "unknown";                                         // mixed / brand-new type → generic AI
  }

  // ===================== PER-QUESTION ANSWER CACHE ("cùng đề, khác dạng") =====================
  // Key = audio URL (unique per question) hoặc prompt đã chuẩn hoá + đáp án → một
  // câu hỏi lặp lại (dù đổi hình thức trình bày) được trả lời NGAY và NHẤT QUÁN.
  const QCACHE_KEY = "ioe_qcache";
  let qCacheMem = null;
  function qNorm(s) {
    return String(s || "").toLowerCase()
      .replace(/\*{2,}|_{2,}/g, "#")
      .replace(/[^\p{L}\p{N}# ]/gu, " ")
      .replace(/\s+/g, " ").trim();
  }
  function qCacheKeyFor(q, pool) {
    // BUG#11: IOE re-randomises the answerPool between attempts while REUSING
    // the same audio URLs — a cache keyed on audio alone returns the OLD
    // attempt's word (wrong length for the new mask). Mix the pool in.
    const poolPart = (Array.isArray(pool) && pool.length) ? "|pool:" + pool.join(",").toLowerCase() : "";
    if (q.audio) return "a:" + q.audio + "|m:" + (q.maskPrefix || "") + (q.maskStars || 0) + poolPart;
    return "p:" + qNorm(q.prompt) + "|o:" + (q.answers || []).map(qNorm).join("~") + poolPart;
  }
  async function getQCache() {
    if (qCacheMem) return qCacheMem;
    try {
      const data = await chrome.storage.local.get({ [QCACHE_KEY]: {} });
      qCacheMem = (data && data[QCACHE_KEY]) ? data[QCACHE_KEY] : {};
    } catch (e) { qCacheMem = {}; }
    return qCacheMem;
  }
  async function saveQCacheEntry(key, answer) {
    try {
      const cache = await getQCache();
      cache[key] = { answer: String(answer), ts: Date.now() };
      const keys = Object.keys(cache);
      if (keys.length > 500) {
        keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
        for (const k of keys.slice(0, keys.length - 500)) delete cache[k];
      }
      await chrome.storage.local.set({ [QCACHE_KEY]: cache });
    } catch (e) {}
  }

  // "[FILL_WORDS: 1. supposed, 2. meets]" / "[MCQ_ANSWERS: 1. B, 2. A]" → array theo số thứ tự
  function parseTagItems(inner) {
    const s = String(inner || "");
    const numbered = s.match(/(\d+)\s*[.):\-\s]+[^,;]+/g);
    if (numbered && numbered.length >= 2) {
      const out = [];
      for (const tok of numbered) {
        const m = tok.match(/(\d+)\s*[.):\-\s]+(.+)/);
        if (m) out[parseInt(m[1], 10) - 1] = m[2].trim();
      }
      if (out.some(x => x != null && x !== "")) return out;
    }
    return s.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
  }

  // Ask the AI directly with a built prompt (game-API path — no screenshot needed)
  function askAiForGame(promptText, opts) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          action: "SOLVE_CURRENT_SCREEN",
          images: null,
          text: "\n\n" + promptText,
          audioUrl: null,
          audioBase64: null,
          audioUrls: (opts && opts.audioUrls) || null,
          hint: "",
          examKind: (opts && opts.examKind) || null
        }, resolve);
      } catch (e) { resolve(null); }
    });
  }

  function buildFillWordPrompt(qs, indices, st) {
    const lines = [];
    lines.push("ĐỀ THI NGHE ĐIỀN TỪ — đọc trực tiếp từ API GAME IOE (chính xác 100%, không cần OCR):");
    if (st && st.gameDesc) lines.push("Hướng dẫn game: " + st.gameDesc);
    if (st && st.answerPool && st.answerPool.length) {
      lines.push("KHO TỪ GỢI Ý (ưu tiên khi khớp cả NGHĨA lẫn ĐỘ DÀI chữ cái): " + st.answerPool.join(", "));
    }
    lines.push("");
    lines.push(`Tổng số câu cần giải: ${indices.length}`);
    lines.push("");
    indices.forEach((qi, k) => {
      const q = qs[qi];
      const stars = q.maskStars ? "*".repeat(Math.min(q.maskStars, 20)) : "*****";
      const maskHint = q.masked
        ? ` [TỪ BỊ CHE: "${(q.maskPrefix || "") + stars}" — ${q.maskStars || "?"} chữ cái bị ẩn${q.maskPrefix ? `, tiền tố đã biết "${q.maskPrefix}"` : ""}]`
        : "";
      lines.push(`Câu ${k + 1} — file audio đính kèm nhãn [AUDIO CÂU ${k + 1}]:`);
      lines.push(`  Câu khẳng định: ${q.prompt}${maskHint}`);
    });
    lines.push("");
    lines.push(`YÊU CẦU: Nghe TỪNG file audio, xác định TỪ BỊ CHE trong câu khẳng định tương ứng (đúng dạng ngữ pháp: chia động từ, số nhiều...). Trả về dòng đầu tiên ĐÚNG định dạng: [FILL_WORDS: 1. từ_câu_1, 2. từ_câu_2, ...] với ĐỦ ${indices.length} từ, mỗi câu ĐÚNG 1 từ.`);
    return lines.join("\n");
  }

  function buildMcqMultiPrompt(qs, indices, st) {
    const lines = [];
    lines.push("ĐỀ THI TRẮC NGHIỆM NHIỀU CÂU — đọc trực tiếp từ API GAME IOE (chính xác 100%, không cần OCR):");
    if (st && st.gameDesc) lines.push("Hướng dẫn game: " + st.gameDesc);
    lines.push("");
    lines.push(`Tổng số câu: ${indices.length}`);
    lines.push("");
    indices.forEach((qi, k) => {
      const q = qs[qi];
      lines.push(`Câu ${k + 1}: ${q.prompt || "(xem hình)"}`);
      (q.answers || []).forEach((a, ai) => lines.push(`  ${String.fromCharCode(65 + ai)}. ${a}`));
    });
    lines.push("");
    lines.push(`YÊU CẦU: Giải TỪNG câu, chọn 1 lựa chọn đúng. Dòng đầu tiên ĐÚNG định dạng: [MCQ_ANSWERS: 1. B, 2. A, ...] với ĐỦ ${indices.length} kết quả.`);
    return lines.join("\n");
  }

  // Wait until the on-screen question is fully rendered (counter or long text)
  async function waitForQuestionReady(timeoutMs = 12000) {
    const t0 = Date.now();
    let info = { qnum: null, text: "" };
    while (Date.now() - t0 < timeoutMs) {
      info = await getCurrentTfQuestionInfo();
      const ready = (info.qnum !== null && info.qnum >= 1) || (info.text && info.text.length >= 10);
      if (ready) { await sleep(1000); return info; }
      await sleep(300);
    }
    return info;
  }

  // Generic per-question executor: the game must ALREADY be started (callers
  // start it BEFORE the slow AI call — the real games time out their intro
  // screen if you wait). Runs the action for each question, then blocks until
  // the game actually animates to the NEXT question (never click blind).
  async function runPerQuestionActions(total, actionFn, label) {
    let lastQinfo = await waitForQuestionReady();
    let done = 0;
    for (let i = 0; i < total; i++) {
      let ok = false;
      try { ok = await actionFn(i); } catch (e) { console.warn("[English Master AI] per-question action error:", e); }
      if (ok) done++;
      if (i < total - 1) {
        const w = await waitForTfNextQuestion(lastQinfo, 15000);
        if (w.ok) {
          lastQinfo = w.info;
        } else if (w.unreadable) {
          await sleep(getRandomHumanDelay(4200, 5200));
          lastQinfo = await getCurrentTfQuestionInfo();
        } else {
          await sleep(getRandomHumanDelay(3500, 5000));
          lastQinfo = await getCurrentTfQuestionInfo();
        }
      }
    }
    showToast(`${label}: ${done}/${total} câu!`);
    return done;
  }

  // =============== LISTENING FILL-WORD SOLVER (BUG#1/#2/#3 fix) ===============
  // AI nghe từng file audio → tìm từ bị che → GÕ vào EditBox Cocos → bấm ANSWER.
  // Câu đã từng giải (cache) được điền ngay không cần gọi AI lại.
  async function solveAndTypeFillWords(qs, st) {
    createIOEUI();
    panelEl.classList.remove("hidden");
    // START the game IMMEDIATELY (before the slow AI call): the real games
    // time out their instruction screen while we wait for the AI.
    await ioeBridgeRequest("START_GAME", {}, 6000);
    const cache = await getQCache();
    const answers = new Array(qs.length).fill(null);
    const unknownIdx = [];
    const pool = (st && st.answerPool) || [];
    qs.forEach((q, i) => {
      const c = cache[qCacheKeyFor(q, pool)];
      if (c && c.answer) answers[i] = c.answer;
      else unknownIdx.push(i);
    });

    // BUG#17: nhớ lại lỗi thật của AI để cuối cùng hiển thị đúng nguyên nhân
    let aiError = null;
    if (unknownIdx.length) {
      const cachedCount = qs.length - unknownIdx.length;
      showToast(`🎧 Bài nghe điền từ: AI đang nghe ${unknownIdx.length}/${qs.length} câu${cachedCount ? ` (đã nhớ ${cachedCount} câu gặp trước đó)` : ""}...`);
      const promptText = buildFillWordPrompt(qs, unknownIdx, st);
      const audioUrls = unknownIdx.map(i => qs[i].audio).filter(Boolean);
      const resp = await askAiForGame(promptText, { audioUrls, examKind: "fillword" });
      aiError = (resp && !resp.success) ? resp.error : null;
      const tag = (resp && resp.success) ? String(resp.data || "").match(/\[FILL_WORDS:\s*([^\]]+)\]/i) : null;
      if (tag) {
        const items = parseTagItems(tag[1]);
        unknownIdx.forEach((qi, k) => {
          const w = items[k] != null ? String(items[k]).trim() : "";
          if (w) {
            answers[qi] = w.replace(/^["']|["']$/g, "");
            saveQCacheEntry(qCacheKeyFor(qs[qi], pool), answers[qi]);
          }
        });
      } else if (!aiError) {
        showToast("⚠️ AI không trả được danh sách từ — hãy bấm lại Tự Làm.");
      }
    } else {
      showToast(`⚡ Đã nhớ sẵn đáp án cả ${qs.length} câu (câu hỏi lặp lại) — điền ngay không cần AI!`);
    }

    // Câu AI bỏ sót: thử ghép với kho từ (answerPool) theo tiền tố + độ dài
    const pool2 = (st && st.answerPool) || [];
    qs.forEach((q, i) => {
      if (!answers[i] && pool2.length) {
        const hit = pool2.find(w => {
          const lw = String(w).toLowerCase();
          const pref = (q.maskPrefix || "").toLowerCase();
          const needLen = (q.maskPrefix || "").length + (q.maskStars || 0);
          return (!pref || lw.startsWith(pref)) && (!needLen || lw.length === needLen);
        });
        if (hit) answers[i] = hit;
      }
    });

    renderFillWordsResult(qs, answers);

    // BUG#17: sau AI + rescue kho từ mà KHÔNG có từ nào → báo lỗi thật thay vì
    // vẽ bảng "1.? 2.? 3.?" rồi lặng lẽ không làm gì
    if (!answers.filter(Boolean).length) {
      renderAiFailurePanel(aiError || "AI không trả được danh sách từ sau khi đã thử kho từ gợi ý.", `nghe điền từ ${qs.length} câu`);
      showToast("❌ Không giải được — xem hướng dẫn trong panel");
      return false;
    }

    // GÕ NGUYÊN TỪ TRƯỚC (v2.13.0 — fixed regression v2.12.1): phần lớn game
    // (mock + nhiều game thật) nhận NGUYÊN TỪ vào EditBox. Riêng game hiện sẵn
    // prefix trong câu (tai-tao-san-ho "ca****") chỉ nhận PHẦN BỊ CHE — gõ nguyên
    // từ bị popup validation "Vui lòng nhập đủ số ký tự" chặn → khi đó mới gõ
    // lại phần ẩn (giữ live-fix v2.12.1 cho game đó).
    function typedPortion(word, q) {
      const pref = String((q && q.maskPrefix) || "").toLowerCase();
      const w = String(word || "");
      if (pref && w.toLowerCase().startsWith(pref) && w.length > pref.length) return w.slice(pref.length);
      return w;
    }

    const total = qs.length;
    const typed = await runPerQuestionActions(total, async (i) => {
      const word = answers[i];
      if (!word) return false;
      const q = qs[i] || {};
      let typedWord = String(word);
      const typeResp = await ioeBridgeRequest("TYPE_EDITBOX", { text: typedWord, index: 0 }, 8000);
      const typedOk = !!(typeResp && typeResp.payload && typeResp.payload.ok);
      if (!typedOk) {
        // Game dùng chip từ bấm được thay cho EditBox → bấm chip
        const clickResp = await ioeBridgeRequest("CLICK_TEXT", { text: word, contains: true }, 8000);
        if (!(clickResp && clickResp.payload && clickResp.payload.ok)) return false;
      }
      await sleep(getRandomHumanDelay(600, 1100));
      let confirmResp = await ioeBridgeRequest("CONFIRM_ANSWER", {}, 8000);
      // Game chỉ nhận PHẦN BỊ CHE (prefix hiển thị sẵn): gõ nguyên từ bị chặn →
      // gõ lại đúng maskStars ký tự phần ẩn (live-verified tai-tao-san-ho).
      if (confirmResp && confirmResp.payload && confirmResp.payload.reason === "validation_popup") {
        typedWord = typedPortion(word, q);
        console.warn("[English Master AI] Confirm chặn nguyên từ (" + (confirmResp.payload.popup || "validate") + ") — gõ phần ẩn '" + typedWord + "' câu " + (i + 1));
        await sleep(500);
        await ioeBridgeRequest("TYPE_EDITBOX", { text: typedWord, index: 0 }, 8000);
        await sleep(getRandomHumanDelay(500, 900));
        confirmResp = await ioeBridgeRequest("CONFIRM_ANSWER", {}, 8000);
      }
      // CỨU VÒNG: nếu vẫn bị chặn (AI trả từ sai độ dài / game kẹt), gõ từ trung
      // tính đủ đúng số ký tự mask để submit (mất điểm câu này) —quan trọng hơn
      // là game NEXT câu, vòng thi vẫn hoàn thành và finishGame được gọi.
      if (confirmResp && confirmResp.payload && confirmResp.payload.reason === "validation_popup") {
        const fillLen = Math.max(1, q.maskStars || typedWord.length || 4);
        const rescue = "abcdefghij".slice(0, Math.min(fillLen, 10));
        console.warn("[English Master AI] Câu " + (i + 1) + " kẹt validation — gõ từ cứu vòng '" + rescue + "' để next câu");
        await sleep(400);
        await ioeBridgeRequest("TYPE_EDITBOX", { text: rescue, index: 0 }, 8000);
        await sleep(getRandomHumanDelay(500, 900));
        confirmResp = await ioeBridgeRequest("CONFIRM_ANSWER", {}, 8000);
      }
      showToast(`✍️ Câu ${i + 1}/${total}: ${word}${confirmResp && confirmResp.payload && confirmResp.payload.reason === "validation_popup" ? " (chưa nộp được)" : ""}`);
      return true;
    }, "✍️ Điền từ xong");

    return typed > 0;
  }

  // =============== MULTI-MCQ SOLVER (options in API, AI picks) ===============
  async function solveAndClickMcqMulti(qs, st) {
    createIOEUI();
    panelEl.classList.remove("hidden");
    // Start BEFORE the AI call (see solveAndTypeFillWords).
    await ioeBridgeRequest("START_GAME", {}, 6000);
    const cache = await getQCache();
    const picks = new Array(qs.length).fill(null); // "B"...
    const pool = (st && st.answerPool) || [];
    const unknownIdx = [];
    qs.forEach((q, i) => {
      const c = cache[qCacheKeyFor(q, pool)];
      if (c && c.answer) picks[i] = c.answer;
      else unknownIdx.push(i);
    });

    if (unknownIdx.length) {
      showToast(`🎯 Trắc nghiệm ${qs.length} câu: AI đang giải ${unknownIdx.length} câu còn lại...`);
      const resp = await askAiForGame(buildMcqMultiPrompt(qs, unknownIdx, st), { examKind: "mcq_multi" });
      // BUG#17: AI fail → KHÔNG render bảng "?" — báo lỗi thật trong panel, thoát sớm
      if (!resp || !resp.success) {
        const known = picks.filter(Boolean).length;
        if (!known) {
          renderAiFailurePanel(resp && resp.error, `trắc nghiệm ${qs.length} câu`);
          showToast("❌ Không giải được — xem hướng dẫn trong panel");
          return false;
        }
        showToast(`⚠️ AI lỗi nhưng còn ${known} câu trong cache — làm tiếp phần đã biết`);
      } else {
        const tag = String(resp.data || "").match(/\[MCQ_ANSWERS:\s*([^\]]+)\]/i);
        if (tag) {
          const items = parseTagItems(tag[1]);
          unknownIdx.forEach((qi, k) => {
            const v = items[k] != null ? String(items[k]).trim().toUpperCase() : "";
            const m = v.match(/^([A-D])/);
            if (m) {
              picks[qi] = m[1];
              saveQCacheEntry(qCacheKeyFor(qs[qi], pool), m[1]);
            }
          });
        } else if (!picks.filter(Boolean).length) {
          // AI trả lời nhưng không đúng định dạng — cũng là fail, không vẽ bảng "?"
          renderAiFailurePanel("AI trả lời không đúng định dạng [MCQ_ANSWERS: 1. B, 2. A, ...] — bấm Tự Làm để thử lại.", `trắc nghiệm ${qs.length} câu`);
          return false;
        }
      }
    } else {
      showToast(`⚡ Đã nhớ sẵn đáp án cả ${qs.length} câu trắc nghiệm — làm ngay!`);
    }

    renderMcqMultiResult(qs, picks);

    const total = qs.length;
    const done = await runPerQuestionActions(total, async (i) => {
      const letter = picks[i];
      if (!letter) return false;
      const q = qs[i];
      const li = letter.charCodeAt(0) - 65;
      const optText = (q.answers && q.answers[li]) || "";
      let resp = null;
      if (optText) resp = await ioeBridgeRequest("CLICK_TEXT", { text: optText, contains: true }, 8000);
      if (!resp || !resp.payload || !resp.payload.ok) {
        for (const nm of ["btn" + letter, "btn_" + letter.toLowerCase(), "ans" + letter, "choice" + letter,
          // thanh-pho-xanh (Vòng 6): options là node khung_tracnghiem* — A→(không
          // hậu tố), B→-001, C→-002, D→-003 (live-verified thứ tự này)
          "khung_tracnghiem" + (li === 0 ? "" : "-" + String(li).padStart(3, "0"))]) {
          resp = await ioeBridgeRequest("CLICK_NAME", { name: nm }, 8000);
          if (resp && resp.payload && resp.payload.ok) break;
        }
      }
      if (resp && resp.payload && resp.payload.ok) {
        showToast(`🎯 Câu ${i + 1}/${total}: ${letter}${optText ? " — " + optText : ""}`);
        return true;
      }
      return false;
    }, "🎯 Trắc nghiệm xong");

    return done > 0;
  }

  // =============== TRANSFORM TYPING SOLVER (hanh-tinh-tim, Vòng 6 — 16/09/2026) ===============
  // "It is important that city planners are careful..." → gõ "must | be | careful"
  // vào các EditBox của câu thứ 2. Điểm sống còn: IOE XÁO LẠI đề giữa các lần làm
  // (câu khác nhau mỗi lần mở) nên KHÔNG thể map theo index — phải đọc TEXT câu 1
  // trên màn rồi match vào word-bank API. Live-verified: 90/100.
  async function solveTransformTyping(qs, st) {
    createIOEUI();
    panelEl.classList.remove("hidden");
    await ioeBridgeRequest("START_GAME", {}, 6000);
    await sleep(2500);
    showToast("🚀 Biến đổi câu: đang đọc màn hình game...");

    const total = qs.length;
    let solved = 0;
    const seen = new Set();
    for (let iter = 0; iter < total + 4; iter++) {
      // 1. Đọc màn: câu 1 + skeleton câu 2 + số ô
      const screenResp = await ioeBridgeRequest("READ_GAME_SCREEN", {}, 8000);
      const screen = screenResp && screenResp.payload;
      if (!screen || !screen.editboxes || !screen.editboxes.length) {
        await sleep(2500);
        continue;
      }
      const first = String(screen.first || "").trim();
      if (!first || seen.has(first)) { await sleep(2000); continue; }
      seen.add(first);
      const blanks = screen.editboxes.length;

      // 2. Match câu API theo text câu 1 (IOE xáo đề mỗi lần làm)
      const nf = first.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      let bank = null;
      for (const q of qs) {
        const np = String(q.prompt || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
        if (np && (nf.startsWith(np.slice(0, 40)) || np.slice(0, 40).startsWith(nf.slice(0, 40)))) { bank = q.answers; break; }
      }
      if (!bank) {
        const w5 = nf.split(" ").slice(0, 5).join(" ");
        for (const q of qs) {
          if (String(q.prompt || "").toLowerCase().includes(w5)) { bank = q.answers; break; }
        }
      }

      // 3. AI đặt từ vào skeleton (hoặc map theo độ dài khi không có bank)
      let words = null;
      if (bank && bank.length) {
        const promptLines = [
          "BÀI BIẾN ĐỔI CÂU — đọc trực tiếp từ game:",
          `Câu gốc: "${first}"`,
          `Câu viết lại (ô trống dạng [B1], [B2], ...): "${screen.skeleton || ""}"`,
          `Kho từ (dùng mỗi từ đúng 1 lần): ${bank.join(", ")}`
        ];
        const resp = await askAiForGame(promptLines.join("\n"), { examKind: "transform" });
        const tag = (resp && resp.success) ? String(resp.data || "").match(/\[TRANSFORM_WORDS:\s*([^\]]+)\]/i) : null;
        if (tag) {
          const firstLine = tag[1].split(",")[0] || tag[1];
          words = firstLine.split("|").map(w => w.replace(/^\d+[.):\-\s]+/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        }
      }
      if (!words || words.length !== blanks) {
        // Fallback: map theo độ dài mask — đúng khi các từ khác độ dài nhau
        words = screen.editboxes.map(eb => {
          const L = eb.maxLength || 0;
          const used = new Set(words || []);
          return (bank || []).find(a => String(a).length === L && !used.has(a)) || "";
        });
      }

      // 4. Điền + bấm ANSWER
      const fillResp = await ioeBridgeRequest("FILL_EDITBOXES", { texts: words }, 8000);
      await sleep(getRandomHumanDelay(500, 900));
      await ioeBridgeRequest("CLICK_ANSWER_BTN", {}, 8000);
      solved++;
      showToast(`✍️ Câu ${solved}/${total}: ${words.join(" | ")}`);
      await sleep(getRandomHumanDelay(3500, 5000));
    }
    return solved > 0;
  }

  // =============== CLOZE CHIP SOLVER (cuon-giay-bi-an, Vòng 6 — 16/09/2026) ===============
  // 1 câu duy nhất: đoạn văn 5 ô trống + 6 chip từ (1 từ nhiễu). Chip KHÔNG nhận
  // mouse synthetic (live-caught) → NỘP TRỰC QUA CONTROLLER: set _lstSelect rồi
  // onSubmitGame(). Live-verified: 100/100.
  async function solveClozeChip(qs, st) {
    createIOEUI();
    panelEl.classList.remove("hidden");
    await ioeBridgeRequest("START_GAME", {}, 6000);
    await sleep(2500);
    showToast("📖 Điền từ đoạn văn: đang đọc đề...");

    // 1. Đọc màn: đoạn văn + word bank từ controller
    const screenResp = await ioeBridgeRequest("READ_GAME_SCREEN", {}, 8000);
    const screen = screenResp && screenResp.payload;
    // passage: ghép RICHTEXT_CHILD của đoạn (READ_GAME_SCREEN gom vào first khi
    // không có EditBox — cloze dùng chip chứ không có EditBox)
    const passage = String((screen && screen.first) || "");
    const blanks = (screen && screen.clozeBlanks) || 0;
    let bank = (screen && screen.wordBank) || null;
    if (!bank || !bank.length) bank = qs[0] && qs[0].answers;
    if (!passage || !blanks || !bank || !bank.length) {
      showToast("⚠️ Không đọc được đoạn văn điền từ — hãy F5 rồi thử lại.");
      return false;
    }

    // 2. AI đặt từ
    const promptLines = [
      "BÀI ĐIỀN TỪ ĐOẠN VĂN — đoạn văn có các ô trống (1)____ ... (5)____:",
      passage,
      "",
      `Kho từ (${bank.length} từ, mỗi từ dùng đúng 1 lần): ${bank.join(", ")}`,
      `Cần điền ${blanks} ô trống.`
    ];
    const resp = await askAiForGame(promptLines.join("\n"), { examKind: "cloze" });
    let words = null;
    const tag = (resp && resp.success) ? String(resp.data || "").match(/\[CLOZE_WORDS:\s*([^\]]+)\]/i) : null;
    if (tag) {
      words = parseTagItems(tag[1]).map(w => String(w).trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    if (!words || words.length < blanks) {
      // fallback: khớp độ dài mask đã đọc từ các label "(n)____"
      words = new Array(blanks).fill("");
      for (let i = 0; i < blanks; i++) words[i] = bank[i % bank.length];
    }

    // 3. Nộp qua controller + xác nhận popup
    const sub = await ioeBridgeRequest("SUBMIT_CLOZE", { words }, 10000);
    const subPayload = sub && sub.payload;
    if (!(subPayload && subPayload.ok)) {
      showToast("⚠️ Không nộp được bài điền từ (" + ((subPayload && subPayload.reason) || "lỗi") + ").");
      return false;
    }
    await sleep(1800);
    // popup confirm "Bạn có chắc chắn muốn nộp bài không?" → bấm Đồng ý (btn_dongy
    // bên phải). Đóng cả popup lỗi cũ (btn_OK) nếu còn.
    await ioeBridgeRequest("CLICK_NAME", { name: "btn_OK" }, 6000);
    await sleep(600);
    await ioeBridgeRequest("CLICK_NAME", { name: "btn_dongy" }, 6000);
    await sleep(2500);
    showToast(`✅ Đã điền & nộp: ${words.join(" | ")}`);
    renderFillWordsResult([{ prompt: "Đoạn văn" }].concat(new Array(blanks - 1).fill({})), words);
    return true;
  }

  function renderFillWordsResult(qs, answers) {
    const qBox = ioeRootEl?.querySelector("#ioe-question-display");
    const contentBox = ioeRootEl?.querySelector("#ioe-panel-content");
    if (qBox) qBox.textContent = `✍️ Nghe-điền-từ: ${answers.filter(Boolean).length}/${qs.length} từ đã có`;
    if (!contentBox) return;
    const chips = qs.map((q, i) => {
      const w = answers[i];
      const bg = w ? "background:#ede9fe;border-color:#7c3aed;" : "background:#fee2e2;border-color:#ef4444;";
      return `<span class="ioe-slot-chip" data-act="type" data-word="${escapeHtml(w || "")}" style="${bg}cursor:pointer;" title="Click để gõ lại từ này vào ô trống">${i + 1}. <strong>${escapeHtml(w || "?")}</strong></span>`;
    }).join("");
    contentBox.innerHTML = `
      <div class="ioe-ans-banner">
        <div class="ioe-ans-label"><span>✍️ KẾT QUẢ NGHE ĐIỀN TỪ (${qs.length} CÂU)</span></div>
        <div class="ioe-slot-chips">${chips}</div>
        <div style="margin-top:8px;font-size:11.5px;color:#64748b;">Nhấn "Tự Làm" để tự điền toàn bộ, hoặc click từng ô để gõ lại từ đó.</div>
      </div>`;
  }

  // BUG#17: khi AI fail (chưa nhập key / key sai / mạng...) — hiển thị LỖI THẬT
  // trong panel kèm hướng dẫn khắc phục, thay vì render bảng "1.? 2.? 3.?"
  // (bản cũ: solveAndClickMcqMulti vẫn vẽ 10 chip "?" đỏ như thể đã có kết quả,
  // user không biết nguyên nhân là gì — chỉ thấy "nó không giải được").
  function renderAiFailurePanel(errorMsg, kindLabel) {
    const qBox = ioeRootEl?.querySelector("#ioe-question-display");
    const contentBox = ioeRootEl?.querySelector("#ioe-panel-content");
    if (qBox) qBox.textContent = "❌ Không giải được" + (kindLabel ? " — " + kindLabel : "");
    if (!contentBox) return;
    const raw = String(errorMsg || "AI không phản hồi.");
    const isKeyErr = /api[\s_-]?key/i.test(raw) || /chưa có gemini/i.test(raw);
    contentBox.innerHTML = `
      <div style="color:#b91c1c;background:#fef2f2;padding:14px;border-radius:10px;line-height:1.65;font-size:13px;border:1px solid #fecaca;">
        <strong>⚠️ Không giải được${kindLabel ? " (" + escapeHtml(kindLabel) + ")" : ""}.</strong><br>
        <span style="color:#7f1d1d;">${escapeHtml(raw)}</span>
        ${isKeyErr ? `
          <hr style="border:none;border-top:1px solid #fecaca;margin:10px 0;">
          <strong>Cách khắc phục (2 phút):</strong>
          <ol style="margin:6px 0 0 18px;padding:0;">
            <li>Bấm biểu tượng <strong>English Master AI</strong> trên thanh công cụ Chrome.</li>
            <li>Tab <strong>Cài đặt API Key</strong> → dán Gemini API Key (bắt đầu bằng <code>AIza...</code>).</li>
            <li>Chưa có key? Lấy <strong>MIỄN PHÍ</strong> tại <strong>aistudio.google.com/app/apikey</strong> (đăng nhập Google → Create API key).</li>
            <li>Bấm <strong>Lưu</strong> → <strong>Kiểm tra kết nối</strong> → thấy "thành công" rồi quay lại đây bấm <strong>Tự Làm</strong>.</li>
          </ol>` : ""}
      </div>`;
  }

  function renderMcqMultiResult(qs, picks) {
    const qBox = ioeRootEl?.querySelector("#ioe-question-display");
    const contentBox = ioeRootEl?.querySelector("#ioe-panel-content");
    if (qBox) qBox.textContent = `🎯 Trắc nghiệm: ${picks.filter(Boolean).length}/${qs.length} câu đã có đáp án`;
    if (!contentBox) return;
    const chips = qs.map((q, i) => {
      const v = picks[i];
      const bg = v ? "background:#dcfce7;border-color:#10b981;" : "background:#fee2e2;border-color:#ef4444;";
      const opt = v ? ((q.answers || [])[v.charCodeAt(0) - 65] || "") : "";
      return `<span class="ioe-slot-chip" style="${bg}">${i + 1}. <strong>${v || "?"}</strong>${opt ? " · " + escapeHtml(opt) : ""}</span>`;
    }).join("");
    contentBox.innerHTML = `
      <div class="ioe-ans-banner">
        <div class="ioe-ans-label"><span>🎯 KẾT QUẢ TRẮC NGHIỆM (${qs.length} CÂU)</span></div>
        <div class="ioe-slot-chips">${chips}</div>
      </div>`;
  }

  // =============== UNIFIED COCOS SOLVER (single source of truth) ===============
  async function solveCocosGameWithApi() {
    const st = getGameBridgeStateDirect();
    if (!st || !st.questions || !st.questions.length) return false;
    const qs = st.questions;
    const kind = classifyExam(qs);
    console.log("[English Master AI] 🎮 Phân loại đề từ dữ liệu API: " + kind);

    // START the game up-front for every solver path — the real games expire
    // their instruction screen in seconds, while the AI call (audio fetch +
    // transcribe) can take much longer. Starting first keeps the round alive.
    await ioeBridgeRequest("START_GAME", {}, 6000);
    await sleep(2000);

    // Matching (format 25, text pairs): exact API pairs, no AI
    if (kind === "matching") {
      const pairs = deriveMatchPairsFromGameApi();
      if (pairs.length) {
        await ioeBridgeRequest("AUTO_MATCH", { pairs, runId: "match_" + Date.now() }, 30000 + pairs.length * 3000);
        showToast(`✅ Cocos: đã tự ghép ${pairs.length} cặp!`);
        return true;
      }
    }

    // MCQ known (every answer already in the API via tans)
    if (kind === "mcq_known") {
      const items = [];
      for (const q of qs) {
        const ans = (q.tans && q.tans[0]) || (q.answers && q.answers[0]) || "";
        const txt = String(ans).trim();
        if (txt && !/^https?:\/\//i.test(txt)) items.push({ text: txt, contains: true, delay: 1400 });
      }
      if (items.length) {
        const seqResp = await ioeBridgeRequest("CLICK_SEQUENCE", { items }, 15000 + items.length * 25000);
        const seqPayload = seqResp && seqResp.payload;
        const doneCount = seqPayload && typeof seqPayload.done === "number" ? seqPayload.done : null;
        if (doneCount !== null && doneCount < items.length) {
          showToast(`⚠️ Cocos: chỉ click được ${doneCount}/${items.length} đáp án — hãy bấm Giải lại (F2).`);
        } else {
          showToast(`✅ Cocos: đã tự chọn ${items.length} đáp án!`);
        }
        return true;
      }
    }

    if (kind === "listening_fillword") return await solveAndTypeFillWords(qs, st);
    if (kind === "mcq_multi") return await solveAndClickMcqMulti(qs, st);
    if (kind === "transform_typing") return await solveTransformTyping(qs, st);
    if (kind === "cloze_chip") return await solveClozeChip(qs, st);

    return false; // listening_tf / unknown → caller falls back to the generic AI flow
  }

  // Auto-solve a Cocos Creator IOE game using the exact API JSON + canvas node clicks
  async function autoSolveCocosGame() {
    createIOEUI();
    let st = getGameBridgeStateDirect();
    if (!st || !st.questions || !st.questions.length) {
      requestGameBridgeSync();
      await sleep(800);
      st = getGameBridgeStateDirect();
    }
    if (!st || !st.questions || !st.questions.length) {
      showToast(gameBridgeError
        ? "⚠️ API game từ chối truy cập (token đã dùng). Hãy tải lại trang (F5) rồi thử lại."
        : "⚠️ Chưa bắt được dữ liệu API game. Hãy chờ game tải xong rồi thử lại.");
      return;
    }

    const handled = await solveCocosGameWithApi();
    if (handled) return;

    // Listening True/False: API has no answers — solve ALL questions with AI
    // (multi-audio exam) then auto-click each result. No manual F2 needed.
    showToast("🎧 Bài nghe True/False: đang nhờ AI nghe & giải toàn bộ câu hỏi...");
    await executeScreenAndAudioSolve("", async (success, answer, hasAudio, isMatching, isTrueFalse, isMcq, isMultiTf, busySkipped) => {
      if (!success) {
        // BUG#22: busySkipped = bị bỏ qua vì đang bận (đã có toast riêng)
        if (!busySkipped) showToast("⚠️ AI không giải được bài nghe. Hãy thử lại.");
        return;
      }
      if (lastTrueFalseAnswers.length > 0) {
        await executeTrueFalseClicksSequentially();
      } else {
        showToast("⚠️ AI chưa trả về danh sách True/False. Hãy bấm F2 (Giải) rồi thử lại.");
      }
    });
  }

  window.autoSolveCocosGameIOE = autoSolveCocosGame;

  // 2. Audio Tracking
  let latestAudioUrl = null;
  let audioDetectTime = 0;

  window.addEventListener("IOE_AUDIO_CAPTURED", (e) => {
    if (e.detail && e.detail.url) {
      latestAudioUrl = e.detail.url;
      audioDetectTime = Date.now();
      showToast("🎧 Đã bắt được âm thanh câu hỏi nghe!");
      const audioBadge = document.getElementById("ioe-audio-detected-badge");
      if (audioBadge) {
        audioBadge.classList.remove("hidden");
      }
    }
  });

  // 3. UI Elements & States
  let ioeRootEl = null;
  let panelEl = null;
  let lastAnswerParsed = "";
  let lastMatchingPairs = [];
  let lastTrueFalseAnswers = [];
  let lastFillWords = [];
  let lastMcqPicks = [];
  let isSolving = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  // Auto-Pilot state
  let isAutoRunning = false;
  let autoTimer = null;
  let autoCountdownInterval = null;

  // ===== BUG#22 (v3.5): KHÓA CHỐNG GIẢI LỒNG NHAU (re-entry guard) =====
  // Khi AI giải lâu, người dùng bấm "Tự Làm"/F2 thêm nhiều lần → nhiều luồng giải
  // chạy song song, chồng chéo click/gõ/ghép thẻ gây lỗi (gõ từ lặp 2 lần, click
  // sai thứ tự câu, game nhảy loạn). Từ giờ: đang giải thì MỌI trigger (Tự Làm /
  // F2 / Ctrl+Space / F4 / Giải lại / Enter hint / Áp dụng đoạn đọc) đều bị bỏ
  // qua + hiện thông báo; khóa chỉ nhả khi TOÀN BỘ quy trình (AI + tự click/gõ)
  // thật sự kết thúc. Khóa riêng biệt với isSolving (cờ nội bộ của 1 lần gọi AI)
  // vì isSolving bị reset SỚM hơn điểm kết thúc thật (trước đây: reset trước cả
  // khi phase gõ/click chạy xong → lỗ hổng giải lồng nhau).
  let isSolverBusy = false;
  let solverBusyGen = 0;
  let lastBusyToastTs = 0;

  function setSolveControlsDisabled(disabled) {
    if (ioeRootEl) {
      // Nút Tự Làm khi auto-pilot (F4) đang chạy đóng vai nút "Dừng" — không disable
      const pairs = [
        [ioeRootEl.querySelector("#ioe-auto-btn"), !isAutoRunning],
        [ioeRootEl.querySelector("#ioe-trigger-solve-btn"), true],
        [ioeRootEl.querySelector("#ioe-re-solve-hint-btn"), true]
      ];
      pairs.forEach(([btn, apply]) => {
        if (btn && apply) {
          btn.disabled = disabled;
          btn.style.opacity = disabled ? "0.55" : "1";
          btn.style.cursor = disabled ? "not-allowed" : "";
        }
      });
    }
    // Thuộc tính DOM để debug/E2E test quan sát trạng thái khóa từ MAIN world
    try {
      document.documentElement.setAttribute("data-ema-busy", disabled ? "1" : "0");
    } catch (e) {}
  }

  function tryAcquireSolverBusy() {
    if (isSolverBusy) {
      // Auto-pilot (F4) tự loop nội bộ — lượt kế rơi vào lúc chưa nhả khóa là
      // bình thường, không toast mỗi vòng (nó tự retry qua busySkipped).
      if (!isAutoRunning) {
        const now = Date.now();
        // Throttle 2.5s: bấm liên tiếp chỉ hiện 1 toast, không spam màn hình
        if (now - lastBusyToastTs > 2500) {
          lastBusyToastTs = now;
          showToast("⏳ Bot đang giải bài... Vui lòng đợi đến khi xong rồi bấm tiếp (bấm thêm đang bị bỏ qua để tránh giải lồng nhau gây lỗi).");
        }
      }
      return false;
    }
    isSolverBusy = true;
    setSolveControlsDisabled(true);
    // Watchdot 5 phút: nếu 1 code path nào đó quên nhả khóa (throw giữa chừng,
    // callback lỗi...) thì tự nhả để không kẹt vĩnh viễn đến khi F5.
    const gen = ++solverBusyGen;
    setTimeout(() => {
      if (isSolverBusy && solverBusyGen === gen) {
        console.warn("[English Master AI] BUG#22 watchdog: khóa giải không được nhả đúng — tự nhả sau 5 phút.");
        releaseSolverBusy();
      }
    }, 5 * 60 * 1000);
    return true;
  }

  function releaseSolverBusy() {
    isSolverBusy = false;
    setSolveControlsDisabled(false);
  }

  function getRandomHumanDelay(minMs, maxMs) {
    const base = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    const jitter = Math.floor((Math.random() - 0.5) * 500);
    return Math.max(minMs, base + jitter);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function createIOEUI() {
    if (document.getElementById("ioe-master-root")) return;

    ioeRootEl = document.createElement("div");
    ioeRootEl.id = "ioe-master-root";

    ioeRootEl.innerHTML = `
      <div class="ioe-control-pill" id="ioe-pill-toggle">
        <div class="ioe-badge-icon">IOE</div>
        <span class="ioe-pill-title">English Master v3.5</span>
        <span id="ioe-audio-detected-badge" class="ioe-audio-pill hidden" title="Phát hiện bài thi nghe">🎧 Audio</span>
        <span id="ioe-game-api-badge" class="ioe-api-pill hidden" title="Đã đọc đề trực tiếp từ API game">🎮 API</span>
        <div class="ioe-pill-btn-group">
          <button class="ioe-btn-pill ioe-btn-solve" id="ioe-trigger-solve-btn" title="Chụp màn hình & Tự nhận diện dạng bài để giải (F2)">
            ⚡ Chụp & Giải (F2)
          </button>
        </div>
      </div>

      <div class="ioe-panel hidden" id="ioe-result-panel">
        <div class="ioe-panel-header" id="ioe-drag-header" title="Giữ chuột tại đây để kéo di chuyển bảng">
          <div class="ioe-panel-title">
            <span>🎯 Trợ Lý IOE (True/False • Ghép Cặp • Trắc Nghiệm • Điền Từ)</span>
            <span class="ioe-drag-indicator">⠿ Kéo</span>
          </div>
          <div class="ioe-panel-tools">
            <button class="ioe-tool-btn" id="ioe-close-panel" title="Đóng">✕</button>
          </div>
        </div>

        <!-- Hint / Slot Constraint Bar -->
        <div class="ioe-hint-bar">
          <span class="ioe-hint-label">🔢 Tùy chỉnh:</span>
          <input type="text" id="ioe-slot-hint-input" class="ioe-hint-input" placeholder="Tự động nhận diện dạng bài...">
          <button id="ioe-re-solve-hint-btn" class="ioe-hint-btn" title="Giải lại">Giải lại</button>
        </div>

      <div class="ioe-reader-bar">
          <span class="ioe-reader-label">📖 Đề đọc được:</span>
          <span id="ioe-reader-stats" class="ioe-reader-stats">chưa đọc</span>
          <button id="ioe-reader-toggle-btn" class="ioe-reader-btn" title="Mở/đóng khung đọc đề">Xem</button>
        </div>

        <div class="ioe-reader-box hidden" id="ioe-reader-box">
          <textarea id="ioe-reader-text" class="ioe-reader-text" placeholder="Nhấn 'Đọc đề' để tự động trích xuất văn bản từ trang, hoặc dán đề bài vào đây..."></textarea>
          <div class="ioe-reader-actions">
            <button class="ioe-reader-action" id="ioe-reader-refresh" title="Đọc lại đề từ trang">🔄 Đọc lại</button>
            <button class="ioe-reader-action" id="ioe-reader-apply" title="Dùng văn bản này làm đề bài cho AI">✅ Dùng làm đề</button>
          </div>
        </div>

        <div class="ioe-question-box">
          <span id="ioe-question-display">Nhấn F2 để chụp & giải, hoặc bật Tự Làm để bot tự chạy...</span>
        </div>

        <div class="ioe-panel-body" id="ioe-panel-content">
          <div style="text-align: center; color: #64748b; padding: 20px;">
            Hỗ trợ <strong>tự động nhận diện 100% dạng bài</strong>:<br/>
            🎧 Nghe True/False • 🧩 Ghép Cặp • 🎯 Trắc nghiệm 2x2/1x4 • ✏️ Điền từ.
          </div>
        </div>

        <div class="ioe-panel-footer">
          <span>Phím tắt: <strong>F2</strong> (Chụp & Giải) • <strong>F4</strong> (Tự Làm liên tục)</span>
          <div class="ioe-footer-btn-group">
            <button class="ioe-btn-action ioe-btn-copy" id="ioe-copy-btn" title="Sao chép đáp án vào clipboard">
              📋 Copy
            </button>
            <button class="ioe-btn-action ioe-btn-auto" id="ioe-auto-btn" title="Tự động 1 nút: AI giải đề (API game + chụp màn hình + nghe audio) rồi tự click/ghép/điền hết — hỗ trợ cả True/False 10 câu, Ghép cặp, Trắc nghiệm, Điền từ">
              ⚡ Tự Làm
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(ioeRootEl);

    panelEl = ioeRootEl.querySelector("#ioe-result-panel");
    const pill = ioeRootEl.querySelector("#ioe-pill-toggle");
    const solveBtn = ioeRootEl.querySelector("#ioe-trigger-solve-btn");
    const closeBtn = ioeRootEl.querySelector("#ioe-close-panel");
    const copyBtn = ioeRootEl.querySelector("#ioe-copy-btn");
    const autoBtn = ioeRootEl.querySelector("#ioe-auto-btn");
    const reSolveHintBtn = ioeRootEl.querySelector("#ioe-re-solve-hint-btn");
    const hintInput = ioeRootEl.querySelector("#ioe-slot-hint-input");
    const dragHeader = ioeRootEl.querySelector("#ioe-drag-header");

    const readerBox = ioeRootEl.querySelector("#ioe-reader-box");
    const readerText = ioeRootEl.querySelector("#ioe-reader-text");
    const readerStats = ioeRootEl.querySelector("#ioe-reader-stats");
    const readerToggleBtn = ioeRootEl.querySelector("#ioe-reader-toggle-btn");
    const readerRefreshBtn = ioeRootEl.querySelector("#ioe-reader-refresh");
    const readerApplyBtn = ioeRootEl.querySelector("#ioe-reader-apply");

    readerToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = readerBox.classList.contains("hidden");
      if (opening) {
        if (!readerText.value.trim()) runOverlayRead();
        readerBox.classList.remove("hidden");
        readerToggleBtn.textContent = "Ẩn";
      } else {
        readerBox.classList.add("hidden");
        readerToggleBtn.textContent = "Xem";
      }
    });

    readerRefreshBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      runOverlayRead();
    });

    readerApplyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const txt = readerText.value.trim();
      if (!txt) {
        showToast("Chưa có văn bản đề để dùng.");
        return;
      }
      executeScreenAndAudioSolve("", null, { textOverride: txt });
    });

    // Delegated chip actions (BUG#5 fix: inline onclick chạy ở MAIN world → ReferenceError)
    ioeRootEl.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-act]");
      if (!chip) return;
      e.stopPropagation();
      const act = chip.getAttribute("data-act");
      if (act === "autofill") {
        triggerUniversalAutoFillOrSelect();
      } else if (act === "match") {
        const a = parseInt(chip.getAttribute("data-a"), 10);
        const b = parseInt(chip.getAttribute("data-b"), 10);
        if (a && b) clickMatchingPairDirectly(a, b);
      } else if (act === "copyword") {
        const w = chip.getAttribute("data-w") || "";
        navigator.clipboard.writeText(w);
        showToast(`📋 Đã copy: "${w}"`);
      } else if (act === "type") {
        const w = chip.getAttribute("data-word") || "";
        if (w) {
          ioeBridgeRequest("TYPE_EDITBOX", { text: w, index: 0 }, 8000).then((r) => {
            showToast(r && r.payload && r.payload.ok ? `✍️ Đã gõ "${w}" vào ô trống` : "⚠️ Không tìm thấy ô nhập (EditBox) trên màn hình");
          });
        }
      }
    });

    // Shared post-solve auto-click: after ANY solve path (F2 / Giải lại / hint),
    // automatically apply the answer — one-button philosophy.
    const solveAndAutoClick = function (hint) {
      // BUG#22: F4 auto-pilot đang tự chạy thì F2/Giải lại/Enter bị bỏ qua
      // (2 luồng cùng click/gõ sẽ lồng nhau); bấm F4 hoặc nút Tự Làm để DỪNG trước.
      if (isAutoRunning) {
        showToast("🤖 Tự Làm liên tục (F4) đang chạy — bấm F4 hoặc nút Tự Làm để DỪNG trước khi giải thủ công.");
        return;
      }
      executeScreenAndAudioSolve(hint, async (success) => {
        if (!success) return;
        if (lastMatchingPairs && lastMatchingPairs.length > 0) {
          await executeMatchingClicksSequentially();
        } else if (lastTrueFalseAnswers && lastTrueFalseAnswers.length > 0) {
          await executeTrueFalseClicksSequentially();
        } else if (lastFillWords && lastFillWords.length > 0) {
          const qs = getGameQuestions() || [];
          if (qs.length) await solveAndTypeFillWords(qs, getGameBridgeStateDirect());
        } else if (lastMcqPicks && lastMcqPicks.length > 0) {
          const qs = getGameQuestions() || [];
          if (qs.length) await solveAndClickMcqMulti(qs, getGameBridgeStateDirect());
        } else if (lastAnswerParsed) {
          await triggerUniversalAutoFillOrSelect();
        }
      });
    };
    window.__IOE_SOLVE_AND_AUTOCLICK__ = solveAndAutoClick;

    solveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      solveAndAutoClick("");
    });

    reSolveHintBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      solveAndAutoClick(hintInput.value.trim());
    });

    hintInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        solveAndAutoClick(hintInput.value.trim());
      }
    });

    pill.addEventListener("click", () => {
      panelEl.classList.toggle("hidden");
    });

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      stopAutoPilot();
      panelEl.classList.add("hidden");
    });

    copyBtn.addEventListener("click", () => {
      if (lastAnswerParsed) {
        navigator.clipboard.writeText(lastAnswerParsed);
        showToast(`📋 Đã copy: "${lastAnswerParsed}"`);
      } else {
        showToast("Chưa có đáp án để copy.");
      }
    });

    autoBtn.addEventListener("click", () => {
      // Dual-purpose: while F4 auto-pilot is running, clicking stops it; otherwise one-click solve
      if (isAutoRunning) {
        stopAutoPilot();
        return;
      }
      oneClickSolveAll();
    });

    dragHeader.addEventListener("mousedown", (e) => {
      if (e.target.closest(".ioe-panel-tools")) return;
      isDragging = true;
      const rect = panelEl.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });
  }

  // Draggable Mousemove
  document.addEventListener("mousemove", (e) => {
    if (!isDragging || !panelEl) return;
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;
    const panelWidth = panelEl.offsetWidth || 440;
    const panelHeight = panelEl.offsetHeight || 400;

    let newX = e.clientX - dragOffset.x;
    let newY = e.clientY - dragOffset.y;

    newX = Math.max(10, Math.min(winWidth - panelWidth - 10, newX));
    newY = Math.max(10, Math.min(winHeight - panelHeight - 10, newY));

    panelEl.style.left = `${newX}px`;
    panelEl.style.top = `${newY}px`;
    panelEl.style.right = "auto";
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });

  // 4. ONE-CLICK "TỰ LÀM" — merged button: detect type & do everything automatically
  //    Priority: Cocos API exact-data games (matching/MCQ) → AI solve (screenshots + audio,
  //    including multi-question True/False) → auto click/fill results.
  async function oneClickSolveAll() {
    // BUG#22: đang giải thì bấm "Tự Làm" thêm → bỏ qua (chống giải lồng nhau)
    if (!tryAcquireSolverBusy()) return;
    createIOEUI();
    panelEl.classList.remove("hidden");

    try {
      // A. Cocos game with exact API data: classify from the DATA (not URL) and
      //    dispatch to the right executor — matching / MCQ / listening fill-word / multi-MCQ.
      if (isCocosGame()) {
        let st = getGameBridgeStateDirect();
        if (!st || !st.questions || !st.questions.length) {
          requestGameBridgeSync();
          await sleep(800);
          st = getGameBridgeStateDirect();
        }
        if (st && st.questions && st.questions.length) {
          const handled = await solveCocosGameWithApi();
          if (handled) return; // return vẫn đi qua finally → nhả khóa
        }
      }
    } finally {
      // BUG#22: nhả khóa trước khi vào AI path — executeScreenAndAudioSolve sẽ
      // giành lại khóa NGAY ở dòng đầu tiên (đồng bộ → không có khoảng trống
      // cho click khác xen vào giữa 2 lệnh này).
      releaseSolverBusy();
    }

      // B. AI solve: screenshots + extracted text + audio (single or multi-question T/F)
      //    then auto-click/fill the results — no manual F2 needed.
    // Auto-click after solve is normally reserved for the one-click "Tự Làm" flow.
    // Pass opt.noAutoClick=true for the plain F2/Chụp & Giải path when the user
    // wants to review the answer first.
    await executeScreenAndAudioSolve("", async (success, answer, hasAudio, isMatching, isTrueFalse, isMcq, isMultiTf, busySkipped) => {
      if (!success) {
        // BUG#22: bị bỏ qua vì lượt khác đang chạy — toast hướng dẫn đã hiện sẵn
        if (!busySkipped) showToast("⚠️ AI không giải được. Hãy thử lại.");
        return;
      }

      // Matching: click pairs sequentially
      if (isMatching && lastMatchingPairs.length > 0) {
        await executeMatchingClicksSequentially();
        return;
        }

        // Multi-question True/False: click all N answers sequentially
        if (lastTrueFalseAnswers && lastTrueFalseAnswers.length > 0) {
          await executeTrueFalseClicksSequentially();
          return;
        }

        // Listening fill-word / multi-MCQ returned by the generic AI path →
        // dispatch to the dedicated executors (cache makes the re-solve instant)
        if (lastFillWords && lastFillWords.length > 0) {
          const qs = getGameQuestions() || [];
          if (qs.length) { await solveAndTypeFillWords(qs, getGameBridgeStateDirect()); return; }
        }
        if (lastMcqPicks && lastMcqPicks.length > 0) {
          const qs = getGameQuestions() || [];
          if (qs.length) { await solveAndClickMcqMulti(qs, getGameBridgeStateDirect()); return; }
        }

        // Single True/False / MCQ / fill: click or fill the single answer
        if (lastAnswerParsed) {
          await triggerUniversalAutoFillOrSelect();
          return;
        }

        showToast("⚠️ Không có đáp án để tự điền. Hãy kiểm tra kết quả AI trong bảng.");
      });
    // BUG#22: khóa bận của AI path do executeScreenAndAudioSolve tự quản
    // (giành khi vào, nhả khi callback tự click/gõ chạy xong).
  }

  window.oneClickSolveAllIOE = oneClickSolveAll;
  // Trạng thái khóa để debug + E2E test (read-only)
  window.__IOE_SOLVER_STATE__ = () => ({ isSolverBusy, isAutoRunning, isSolving });

  // 4. AUTO-PILOT ENGINE WITH GAME-AWARE ANIMATION TIMING
  function toggleAutoPilot() {
    if (isAutoRunning) {
      stopAutoPilot();
    } else {
      startAutoPilot();
    }
  }

  function startAutoPilot() {
    // BUG#22: một lượt giải thủ công đang chạy thì chưa cho bật auto-pilot —
    // chờ xong rồi bấm F4 lại (tránh 2 luồng giải lồng nhau).
    if (isSolverBusy) {
      const now = Date.now();
      if (now - lastBusyToastTs > 2500) {
        lastBusyToastTs = now;
        showToast("⏳ Bot đang giải bài... Đợi lượt này xong rồi mới bấm F4.");
      }
      return;
    }
    createIOEUI();
    panelEl.classList.remove("hidden");
    isAutoRunning = true;

    const autoBtn = ioeRootEl.querySelector("#ioe-auto-btn");
    if (autoBtn) {
      autoBtn.classList.add("running");
      autoBtn.innerHTML = "⏹️ Dừng Lại (Stop)";
    }

    showToast("🚀 Đã BẬT Tự Làm liên tục (F4) — mô phỏng tốc độ người thật!");
    runAutoPilotStep();
  }

  function stopAutoPilot() {
    isAutoRunning = false;
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    if (autoCountdownInterval) {
      clearInterval(autoCountdownInterval);
      autoCountdownInterval = null;
    }

    const autoBtn = ioeRootEl?.querySelector("#ioe-auto-btn");
    if (autoBtn) {
      autoBtn.classList.remove("running");
      autoBtn.innerHTML = "⚡ Tự Làm";
    }

    const qBox = ioeRootEl?.querySelector("#ioe-question-display");
    if (qBox) {
      qBox.textContent = "⏹️ Đã dừng chế độ Tự Làm.";
    }
    showToast("⏹️ Đã dừng chế độ Tự Làm.");
  }

  // 4.1 Deterministic Question State Snapshot
  function getCurrentQuestionSnapshot() {
    const audioUrl = window.__LAST_CAPTURED_IOE_AUDIO__?.url || latestAudioUrl || null;
    const audioTimestamp = window.__LAST_CAPTURED_IOE_AUDIO__?.timestamp || audioDetectTime || 0;

    let domText = "";
    const domQ = document.querySelector("#txtQuestion, .question-title, .title-question, .question-content, #contentQuestion, [class*='question']");
    if (domQ) domText = domQ.innerText.trim();

    let qNum = "";
    const numEl = document.querySelector(".question-number, .badge-question, .current-question, [class*='number']");
    if (numEl) qNum = numEl.innerText.trim();

    let memKey = "";
    if (window.__IOE_SLOT_INSPECTOR__) {
      const mem = window.__IOE_SLOT_INSPECTOR__.inspectGameMemory();
      if (mem && mem.data) {
        try { memKey = JSON.stringify(mem.data).slice(0, 100); } catch (e) {}
      }
    }

    return {
      audioUrl,
      audioTimestamp,
      domText,
      qNum,
      memKey,
      capturedAt: Date.now()
    };
  }

  // 4.2 Fast Dynamic Question Transition Watcher
  async function waitForNextQuestionTransition(previousSnapshot, isTrueFalse = false) {
    const qBox = ioeRootEl?.querySelector("#ioe-question-display");
    if (qBox) {
      qBox.textContent = "⏳ Đang chuyển sang câu hỏi mới...";
    }

    const startTime = Date.now();
    const minWaitTime = isTrueFalse ? 2600 : 2200;
    const maxTimeout = 10000;

    while (isAutoRunning) {
      const elapsed = Date.now() - startTime;
      if (elapsed > maxTimeout) {
        break;
      }

      // 1. Immediate wakeup when new audio is intercepted and ready
      const currentAudio = window.__LAST_CAPTURED_IOE_AUDIO__;
      if (currentAudio && currentAudio.isReady && currentAudio.timestamp > previousSnapshot.capturedAt) {
        console.log("[English Master AI] 🎯 New Audio Ready! Immediate transition.");
        if (qBox) qBox.textContent = "🎯 Đã có audio câu mới! Đang giải...";
        await sleep(200);
        return true;
      }

      // 2. DOM / Memory Change
      const currentSnapshot = getCurrentQuestionSnapshot();
      if (currentSnapshot.domText && previousSnapshot.domText && currentSnapshot.domText !== previousSnapshot.domText) {
        console.log("[English Master AI] 🎯 DOM Question Text Changed!");
        await sleep(200);
        return true;
      }

      if (currentSnapshot.qNum && previousSnapshot.qNum && currentSnapshot.qNum !== previousSnapshot.qNum) {
        console.log("[English Master AI] 🎯 Question Number Changed!");
        await sleep(200);
        return true;
      }

      if (currentSnapshot.memKey && previousSnapshot.memKey && currentSnapshot.memKey !== previousSnapshot.memKey) {
        console.log("[English Master AI] 🎯 Game Memory Question Changed!");
        await sleep(200);
        return true;
      }

      // 3. For True/False: if animation finished (~2.8s) and audio hasn't auto-played, click Play once
      if (isTrueFalse && elapsed >= 2800 && elapsed <= 3100) {
        const canvas = findGameCanvas();
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const playBtnX = rect.left + (rect.width * 0.165);
          const playBtnY = rect.top + (rect.height * 0.315);
          simulateClick(canvas, playBtnX, playBtnY);
        }
      }

      // 4. Safe threshold
      if (isTrueFalse && elapsed >= 3800) {
        await sleep(200);
        return true;
      }

      if (!isTrueFalse && elapsed >= minWaitTime) {
        await sleep(200);
        return true;
      }

      await sleep(150);
    }
    return false;
  }

  // 4.3 Main Auto-Pilot Step Execution
  async function runAutoPilotStep() {
    if (!isAutoRunning) return;

    // Record baseline snapshot before solving
    const previousSnapshot = getCurrentQuestionSnapshot();

    executeScreenAndAudioSolve("", async (success, answer, hasAudio, isMatching, isTrueFalse, isMcq, isMultiTf, busySkipped) => {
      if (!isAutoRunning) return;

      // BUG#22: bị chặn vì lượt trước chưa nhả khóa xong (khóa nhả sau khi
      // callback này kết thúc) — retry im lặng sau 1.5s, KHÔNG báo lỗi.
      if (busySkipped) {
        await sleep(1500);
        if (isAutoRunning) runAutoPilotStep();
        return;
      }

      if (!success) {
        showToast("⚠️ Không giải được câu này, thử lại sau 2s...");
        await sleep(2000);
        if (isAutoRunning) runAutoPilotStep();
        return;
      }

      // A0. Multi-question True/False: AI already answered ALL questions at once —
      //     click them sequentially, then the exam is done (no next-question loop needed).
      if (isMultiTf && lastTrueFalseAnswers && lastTrueFalseAnswers.length > 0) {
        await executeTrueFalseClicksSequentially();
        if (!isAutoRunning) return;
        if (window.invalidateIOEAudio) window.invalidateIOEAudio();
        await sleep(1500);
        if (isAutoRunning) runAutoPilotStep();
        return;
      }

      // A. If Matching Game: execute paired clicks
      if (isMatching && lastMatchingPairs.length > 0) {
        await executeMatchingClicksSequentially();
        if (!isAutoRunning) return;
        if (window.invalidateIOEAudio) window.invalidateIOEAudio();
        await waitForNextQuestionTransition(previousSnapshot, false);
        if (isAutoRunning) runAutoPilotStep();
        return;
      }

      // B. If True/False Listening Game: rapid natural click (0.3s - 0.6s)
      if (isTrueFalse) {
        const reactionDelay = getRandomHumanDelay(300, 600);
        const qBox = ioeRootEl?.querySelector("#ioe-question-display");
        if (qBox) {
          qBox.textContent = `⚡ Đang chọn đáp án...`;
        }
        await sleep(reactionDelay);
        if (!isAutoRunning) return;

        triggerUniversalAutoFillOrSelect();

        // Completely invalidate previous question audio
        if (window.invalidateIOEAudio) {
          window.invalidateIOEAudio();
        }

        // Wait deterministically for new question
        await waitForNextQuestionTransition(previousSnapshot, true);
        if (isAutoRunning) runAutoPilotStep();
        return;
      }

      // C. If Multiple Choice (MCQ - Tái tạo san hô, Fansipan, Leo núi)
      if (isMcq) {
        const reactionDelay = getRandomHumanDelay(350, 700);
        const qBox = ioeRootEl?.querySelector("#ioe-question-display");
        if (qBox) {
          qBox.textContent = `🎯 Đang tự chọn đáp án trắc nghiệm...`;
        }
        await sleep(reactionDelay);
        if (!isAutoRunning) return;

        triggerUniversalAutoFillOrSelect();

        if (window.invalidateIOEAudio) {
          window.invalidateIOEAudio();
        }

        await waitForNextQuestionTransition(previousSnapshot, false);
        if (isAutoRunning) runAutoPilotStep();
        return;
      }

      // D. Normal Fill Text Question flow
      const reactionDelay = getRandomHumanDelay(400, 800);
      const qBox = ioeRootEl?.querySelector("#ioe-question-display");
      if (qBox) {
        qBox.textContent = `🧠 Đang điền đáp án...`;
      }
      await sleep(reactionDelay);
      if (!isAutoRunning) return;

      await triggerHumanizedAutoFillOrSelect(answer);
      if (!isAutoRunning) return;

      const reviewDelay = getRandomHumanDelay(300, 600);
      await sleep(reviewDelay);
      if (!isAutoRunning) return;

      triggerSubmitButton();

      if (window.invalidateIOEAudio) {
        window.invalidateIOEAudio();
      }

      // Wait deterministically for next question
      await waitForNextQuestionTransition(previousSnapshot, false);
      if (isAutoRunning) runAutoPilotStep();
    });
  }

  // 5. MATCHING PAIRS AUTO-CLICKER (3x4 Grid on Canvas & DOM)
  async function executeMatchingClicksSequentially() {
    // Preferred path: Cocos Creator game — use exact API pairs and click real nodes
    const cocosPairs = deriveMatchPairsFromGameApi();
    if (isCocosGame() && cocosPairs.length > 0) {
      showToast(`🧩 Cocos: tự ghép ${cocosPairs.length} cặp từ API game...`);
      const started = await ioeBridgeRequest("START_GAME", {});
      await sleep(1200);
      const resp = await ioeBridgeRequest("AUTO_MATCH", { pairs: cocosPairs, runId: "match_" + Date.now() }, 30000);
      await sleep(1500);
      showToast(`✅ Đã tự động ghép ${cocosPairs.length} cặp (Cocos)!`);
      return;
    }

    if (!lastMatchingPairs || lastMatchingPairs.length === 0) {
      showToast("Chưa có danh sách cặp để ghép.");
      return;
    }

    const canvas = document.querySelector("canvas");
    showToast(`🧩 Đang tự động ghép ${lastMatchingPairs.length} cặp...`);

    for (let i = 0; i < lastMatchingPairs.length; i++) {
      if (!isAutoRunning && !panelEl) break;

      const pair = lastMatchingPairs[i];
      const cellA = parseInt(pair[0]);
      const cellB = parseInt(pair[1]);

      if (cellA >= 1 && cellA <= 12 && cellB >= 1 && cellB <= 12) {
        clickMatchingCell(cellA, canvas);
        await sleep(getRandomHumanDelay(350, 550));

        clickMatchingCell(cellB, canvas);
        await sleep(getRandomHumanDelay(750, 1100));
      }
    }

    showToast("✅ Đã tự động ghép xong tất cả các cặp!");
  }

  function clickMatchingCell(cellNumber, canvas = null) {
    if (!canvas) canvas = document.querySelector("canvas");

    const domCards = document.querySelectorAll(".card, .item-card, .card-item, [class*='card']");
    if (domCards && domCards.length >= 12 && domCards[cellNumber - 1]) {
      domCards[cellNumber - 1].click();
      return;
    }

    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      const zeroIndex = cellNumber - 1;
      const row = Math.floor(zeroIndex / 4);
      const col = zeroIndex % 4;

      const colXPercentages = [0.24, 0.39, 0.54, 0.69];
      const rowYPercentages = [0.36, 0.58, 0.80];

      const targetX = rect.left + (width * colXPercentages[col]);
      const targetY = rect.top + (height * rowYPercentages[row]);

      simulateClick(canvas, targetX, targetY);
    }
  }

  // 5.5 UNIVERSAL MULTIPLE CHOICE CLICKER (DOM + Stage Tree + 2x2 / 1x4 / 4x1 Geometries)
  function clickMultipleChoiceOption(choiceLetter, choiceText = "", canvas = null) {
    if (!choiceLetter) return false;
    const letter = choiceLetter.toUpperCase().trim();
    const letterIdx = letter.charCodeAt(0) - 65; // 0 for A, 1 for B, 2 for C, 3 for D
    if (letterIdx < 0 || letterIdx > 3) return false;

    if (!canvas) canvas = findGameCanvas();

    // 1. DOM Elements Check
    const domSelectors = [
      '.answer-item', '.btn-answer', '.item-answer', 'ul.answers li',
      'button[class*="ans"]', '[class*="choice"]', '[class*="option"]',
      'input[type="radio"]', '.radio-answer', '.list-answer li'
    ];
    const domElements = Array.from(document.querySelectorAll(domSelectors.join(","))).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== "none";
    });

    if (domElements.length >= 2) {
      for (let i = 0; i < domElements.length; i++) {
        const el = domElements[i];
        const txt = el.innerText ? el.innerText.trim().toUpperCase() : "";
        const val = (el.value || el.getAttribute("data-answer") || el.getAttribute("data-value") || "").toUpperCase();

        if (
          txt.startsWith(letter + ".") ||
          txt.startsWith(letter + " ") ||
          txt === letter ||
          val === letter ||
          (i === letterIdx && domElements.length === 4) ||
          (choiceText && txt.includes(choiceText.toUpperCase()))
        ) {
          el.focus();
          el.click();
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          console.log(`[English Master AI] 🎯 Clicked DOM MCQ Option: ${letter}`);
          return true;
        }
      }
    }

    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // 2. CreateJS / EaselJS DisplayObject Tree Traversal
    const win = canvas.ownerDocument?.defaultView || window;
    const stage = win.stage || win.exportRoot?.stage || (win.createjs && win.createjs.Stage?._stages?.[0]);

    if (stage) {
      try {
        let foundStageObj = null;

        function walkStageTree(obj) {
          if (!obj || foundStageObj) return;

          // Check object name (e.g. btn_a, btnA, ans_0, choiceA, itemA)
          const name = (obj.name || "").toLowerCase();
          const targetNamePatterns = [
            `btn_${letter.toLowerCase()}`, `btn${letter.toLowerCase()}`,
            `choice_${letter.toLowerCase()}`, `choice${letter.toLowerCase()}`,
            `ans_${letter.toLowerCase()}`, `ans${letter.toLowerCase()}`,
            `opt_${letter.toLowerCase()}`, `opt${letter.toLowerCase()}`,
            `btn_${letterIdx}`, `btn${letterIdx + 1}`, `ans_${letterIdx}`, `choice_${letterIdx}`
          ];

          if (name && targetNamePatterns.some(p => name.includes(p))) {
            foundStageObj = obj;
            return;
          }

          // Check text property
          if (obj.text && typeof obj.text === "string") {
            const t = obj.text.trim().toUpperCase();
            if (t.startsWith(letter + ".") || t.startsWith(letter + " ") || t === letter || (choiceText && t.includes(choiceText.toUpperCase()))) {
              foundStageObj = obj.parent || obj;
              return;
            }
          }

          if (obj.children && Array.isArray(obj.children)) {
            for (const child of obj.children) {
              walkStageTree(child);
              if (foundStageObj) return;
            }
          }
        }

        walkStageTree(stage);

        if (foundStageObj) {
          const pt = foundStageObj.localToGlobal(0, 0);
          const bounds = foundStageObj.getBounds ? (foundStageObj.getBounds() || foundStageObj.nominalBounds) : null;
          const stageScaleX = stage.scaleX || 1;
          const stageScaleY = stage.scaleY || 1;

          let targetStageX = pt.x;
          let targetStageY = pt.y;

          if (bounds) {
            targetStageX += (bounds.width * (foundStageObj.scaleX || 1)) / 2;
            targetStageY += (bounds.height * (foundStageObj.scaleY || 1)) / 2;
          }

          const clientX = rect.left + (targetStageX * stageScaleX);
          const clientY = rect.top + (targetStageY * stageScaleY);

          simulateClick(canvas, clientX, clientY);
          setTimeout(() => simulateClick(canvas, clientX, clientY), 60);
          console.log(`[English Master AI] 🎯 Clicked Stage Object for MCQ Option ${letter} at (${Math.round(clientX)}, ${Math.round(clientY)})`);
          return true;
        }
      } catch (err) {
        console.warn("[English Master AI] Stage tree walk error:", err);
      }
    }

    // 3. Adaptive Coordinate Matrix Engine
    const url = window.location.href.toLowerCase();
    const isFansipan = url.includes("fansipan");
    const isLeoNui = url.includes("leo-nui") || url.includes("vuot-chuong-ngai-vat");
    const isSanHo = url.includes("tai-tao-san-ho") || url.includes("san-ho") || url.includes("coral");

    let relX = 0.5;
    let relY = 0.5;

    if (isFansipan) {
      // 1x4 Horizontal Row (Fansipan)
      const fansipanX = [0.140, 0.380, 0.620, 0.860];
      relX = fansipanX[letterIdx];
      relY = 0.880;
    } else if (isLeoNui) {
      // 4x1 Vertical Column (Leo núi)
      const leoNuiY = [0.460, 0.580, 0.700, 0.820];
      relX = 0.500;
      relY = leoNuiY[letterIdx];
    } else {
      // Default: 2x2 Grid (Tái tạo san hô / San hô / Điền khuyết 4 lựa chọn)
      // A (Top-Left): X=22.5%, Y=32.0%
      // B (Top-Right): X=50.5%, Y=32.0%
      // C (Bottom-Left): X=22.5%, Y=46.0%
      // D (Bottom-Right): X=50.5%, Y=46.0%
      const grid2x2 = [
        { x: 0.225, y: 0.320 }, // A
        { x: 0.505, y: 0.320 }, // B
        { x: 0.225, y: 0.460 }, // C
        { x: 0.505, y: 0.460 }  // D
      ];
      relX = grid2x2[letterIdx].x;
      relY = grid2x2[letterIdx].y;
    }

    const primaryX = rect.left + (width * relX);
    const primaryY = rect.top + (height * relY);

    // Micro-cluster clicks: center of button and circle offset
    simulateClick(canvas, primaryX, primaryY);
    setTimeout(() => {
      simulateClick(canvas, primaryX, primaryY);
    }, 60);

    console.log(`[English Master AI] 🎯 Clicked Matrix MCQ Option ${letter} at (${Math.round(primaryX)}, ${Math.round(primaryY)})`);
    return true;
  }

  // 6. UNIVERSAL AUTO-FILL & AUTO-SELECT (True/False • MCQ • Fill Inputs)
  // Cocos Creator answering: click real canvas nodes via the MAIN-world bridge
  async function cocosAutoAnswer(answer) {
    const clean = (answer || "").trim();
    const lower = clean.toLowerCase();
    if (!clean) return false;

    // Ensure game started (close intro popups / press start) if still on StartScene
    await ioeBridgeRequest("START_GAME", {});
    await sleep(400);

    // A. True / False
    if (lower === "true" || lower === "false" || lower.startsWith("true") || lower.startsWith("false")) {
      const isTrue = lower.startsWith("true");
      const resp = await ioeBridgeRequest("CLICK_NAME", { name: isTrue ? "btnTrue" : "btnFalse" });
      if (resp && resp.payload && resp.payload.ok) {
        showToast(`✅ Cocos: đã chọn [${isTrue ? "True" : "False"}]!`);
        return true;
      }
      return false;
    }

    // B. Multiple choice: [ANSWER: A. word] -> click node whose text is the word, or btnA
    const mcq = clean.match(/^([A-D])(?:[\.\s]+)(.*)$/i);
    if (mcq) {
      const letter = mcq[1].toUpperCase();
      const text = (mcq[2] || "").trim();
      let resp = null;
      if (text) resp = await ioeBridgeRequest("CLICK_TEXT", { text, contains: true });
      if (!resp || !resp.payload || !resp.payload.ok) {
        const names = [`btn${letter}`, `btn_${letter.toLowerCase()}`, `ans${letter}`, `choice${letter}`];
        for (const nm of names) {
          resp = await ioeBridgeRequest("CLICK_NAME", { name: nm });
          if (resp && resp.payload && resp.payload.ok) break;
        }
      }
      if (resp && resp.payload && resp.payload.ok) {
        showToast(`✅ Cocos: đã chọn đáp án [${letter}] ${text ? `(${text})` : ""}!`);
        return true;
      }
      return false;
    }

    // C. Fill / short text: try clicking a node whose text equals the answer
    const resp = await ioeBridgeRequest("CLICK_TEXT", { text: clean, contains: true });
    if (resp && resp.payload && resp.payload.ok) {
      showToast(`✅ Cocos: đã chọn "${clean}"!`);
      return true;
    }
    return false;
  }

  // Ask the MAIN-world bridge what question is currently rendered on the canvas.
  // Returns { text, qnum } — only ACTIVE nodes are considered by the bridge.
  async function getCurrentTfQuestionInfo() {
    const resp = await ioeBridgeRequest("CURRENT_QUESTION", {}, 5000);
    if (resp && resp.payload) return resp.payload;
    return { text: "", qnum: null };
  }

  // Wait until the game has FINISHED animating to the NEXT question:
  // - the on-screen question number increases (or question text changes), AND
  // - a minimum animation window has elapsed (Cocos TF transition ≈ 2.8s).
  // Returns unreadable:true when neither counter nor text can be read — the
  // caller must then fall back to a fixed safe wait instead of clicking blind.
  async function waitForTfNextQuestion(prevInfo, timeoutMs = 12000) {
    const prevQnum = prevInfo ? prevInfo.qnum : null;
    const prevText = (prevInfo && prevInfo.text) || "";
    const canDetect = (prevQnum !== null && prevQnum !== undefined) || !!prevText;
    if (!canDetect) {
      return { ok: false, unreadable: true, info: prevInfo };
    }

    const MIN_ANIM_MS = 4200;
    const start = Date.now();
    let lastInfo = { qnum: null, text: "" };

    while (Date.now() - start < timeoutMs) {
      const info = await getCurrentTfQuestionInfo();
      lastInfo = info;

      const animDone = Date.now() - start >= MIN_ANIM_MS;
      const qnumAdvanced = animDone && info.qnum !== null && prevQnum !== null && info.qnum > prevQnum;
      const textChanged = animDone && info.text && prevText && info.text !== prevText;

      if (qnumAdvanced || textChanged) {
        // Label is on screen, but the card/animation may still be settling —
        // give it a full beat so the answer button is completely interactive.
        await sleep(1000);
        return { ok: true, info };
      }
      await sleep(200);
    }
    return { ok: false, info: lastInfo };
  }

  // 6.1 MULTI True/False SEQUENTIAL CLICKER (AI answered all N listening questions)
  // Clicks True/False on each question one-by-one via the MAIN-world Cocos bridge,
  // then waits for the game to advance to the next question before clicking again.
  async function executeTrueFalseClicksSequentially() {
    if (!lastTrueFalseAnswers || lastTrueFalseAnswers.length === 0) {
      showToast("Chưa có danh sách đáp án True/False.");
      return false;
    }

    showToast(`🎧 Đang tự chọn ${lastTrueFalseAnswers.length} câu True/False...`);

    // Only start the game if it hasn't started yet (start_btn is inactive after start,
    // so the bridge's findNodeByName simply won't find it → safe no-op).
    await ioeBridgeRequest("START_GAME", {}, 6000);

    // Wait until question 1 is fully rendered on screen (intro animation ≈ 2.8s).
    let lastQinfo = { qnum: null, text: "" };
    {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const info = await getCurrentTfQuestionInfo();
        const ready = (info.qnum !== null && info.qnum >= 1) || (info.text && info.text.length >= 15);
        if (ready) { lastQinfo = info; break; }
        await sleep(300);
      }
      if (!lastQinfo.text && lastQinfo.qnum === null) {
        // Couldn't read the screen — fall back to a generous fixed wait so we
        // still don't click during the intro animation.
        await sleep(4200);
        lastQinfo = await getCurrentTfQuestionInfo();
      } else {
        await sleep(1000); // settle beat after the question is visible
      }
    }

    let clicked = 0;
    let skippedNoAdvance = 0;

    for (let i = 0; i < lastTrueFalseAnswers.length; i++) {
      const val = lastTrueFalseAnswers[i];
      if (val === null || val === undefined) {
        console.warn(`[English Master AI] ⚠️ Câu ${i + 1}: AI không trả lời — bỏ qua.`);
        continue;
      }

      // (Question-readiness is handled AFTER each click below — after an answer is
      // chosen the game always animates to the next question, and we block until
      // that animation completes. The pre-click state was captured in lastQinfo.)

      const nodeName = val ? "btnTrue" : "btnFalse";
      const resp = await ioeBridgeRequest("CLICK_NAME", { name: nodeName }, 8000);
      const ok = !!(resp && resp.payload && resp.payload.ok);
      if (ok) {
        clicked++;
        showToast(`✅ Câu ${i + 1}/${lastTrueFalseAnswers.length}: đã chọn [${val ? "True" : "False"}]`);
      } else {
        // Fallback: percentage coordinates on canvas (btnTrue ~75.8%/17.5%, btnFalse ~75.2%/28.9%)
        const canvas = findGameCanvas();
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const targetX = rect.left + (rect.width * (val ? 0.758 : 0.752));
          const targetY = rect.top + (rect.height * (val ? 0.175 : 0.289));
          simulateClick(canvas, targetX, targetY);
          clicked++;
          showToast(`✅ Câu ${i + 1}/${lastTrueFalseAnswers.length}: [${val ? "True" : "False"}] (canvas)`);
        }
      }

      // ===== WAIT FOR THE GAME TO ADVANCE TO THE NEXT QUESTION (ALWAYS, no exceptions) =====
      // The game MUST animate to the next question after an answer is chosen. Clicking
      // during that animation selects the next card blindly → wrong answers. So after
      // every click we block until the on-screen question has actually changed.
      if (i < lastTrueFalseAnswers.length - 1) {
        const w = await waitForTfNextQuestion(lastQinfo);
        if (w.ok) {
          lastQinfo = w.info;
        } else if (w.unreadable) {
          // Screen unreadable (no counter, no text): fixed human-like wait.
          // TF transition ≈ 2.8s + card settle + human reading beat — 4.6s..5.5s.
          await sleep(getRandomHumanDelay(4600, 5500));
          lastQinfo = await getCurrentTfQuestionInfo();
        } else {
          // Readable but never advanced within 12s (timeout). Do NOT click blind —
          // wait more and re-read; count it so the summary toast can warn.
          skippedNoAdvance++;
          console.warn(`[English Master AI] ⚠️ Sau câu ${i + 1}: màn hình chưa chuyển câu — đợi thêm 3s.`);
          await sleep(3000);
          lastQinfo = await getCurrentTfQuestionInfo();
        }
      }
    }

    showToast(`🎧 Hoàn thành: đã chọn ${clicked}/${lastTrueFalseAnswers.length} câu${skippedNoAdvance ? ` (⚠️ ${skippedNoAdvance} lần chờ màn hình)` : ""}!`);
    return clicked > 0;
  }

  // 6. UNIVERSAL AUTO-FILL & AUTO-SELECT (True/False • MCQ • Fill Inputs)
  async function triggerUniversalAutoFillOrSelect() {
    // If Matching Pairs Game
    if (lastMatchingPairs && lastMatchingPairs.length > 0) {
      await executeMatchingClicksSequentially();
      return;
    }

    // Multi-question True/False listening: click all N answers sequentially
    if (lastTrueFalseAnswers && lastTrueFalseAnswers.length > 0) {
      await executeTrueFalseClicksSequentially();
      return;
    }

    // Cocos Creator games: click the real node on the canvas via the MAIN-world bridge
    if (isCocosGame() && lastAnswerParsed) {
      const clicked = await cocosAutoAnswer(lastAnswerParsed);
      if (clicked) return;
    }

    if (!lastAnswerParsed) {
      showToast("Chưa có đáp án để tự điền.");
      return;
    }

    const cleanAns = lastAnswerParsed.trim();
    const cleanLower = cleanAns.toLowerCase();
    let actionTaken = false;

    // A. True / False Game (Dọn rác bãi biển)
    if (cleanLower === "true" || cleanLower === "false" || cleanLower.startsWith("true") || cleanLower.startsWith("false")) {
      const isTrue = cleanLower.startsWith("true");

      // DOM True/False buttons
      const trueBtn = document.querySelector('.btn-true, button[title*="True"], [data-value="true"]');
      const falseBtn = document.querySelector('.btn-false, button[title*="False"], [data-value="false"]');
      if (isTrue && trueBtn) {
        trueBtn.click();
        actionTaken = true;
      } else if (!isTrue && falseBtn) {
        falseBtn.click();
        actionTaken = true;
      }

      // Canvas Game True/False buttons (Right column on Dọn rác bãi biển)
      const canvas = findGameCanvas();
      if (canvas && !actionTaken) {
        const rect = canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        // True button oval center: X = 75.8%, Y = 17.5%
        // False button oval center: X = 75.2%, Y = 28.9%
        const targetX = isTrue ? (rect.left + (width * 0.758)) : (rect.left + (width * 0.752));
        const targetY = isTrue ? (rect.top + (height * 0.175)) : (rect.top + (height * 0.289));

        simulateClick(canvas, targetX, targetY);
        setTimeout(() => simulateClick(canvas, targetX, targetY), 50);

        actionTaken = true;
        showToast(`⚡ Đã tự động chọn [${isTrue ? 'True' : 'False'}] trên màn hình!`);
      }

      if (actionTaken) {
        showToast(`✅ Đã tự chọn [${isTrue ? 'True' : 'False'}]!`);
        return;
      }
    }

    // B. Multiple Choice Answer (A, B, C, D)
    const mcqMatch = cleanAns.match(/^([A-D])(?:\.\s*|\s+)?(.*)$/i);
    if (mcqMatch) {
      const choiceLetter = mcqMatch[1].toUpperCase();
      const choiceText = mcqMatch[2] ? mcqMatch[2].trim() : "";
      const canvas = findGameCanvas();

      actionTaken = clickMultipleChoiceOption(choiceLetter, choiceText, canvas);
      if (actionTaken) {
        showToast(`✅ Đã tự chọn đáp án [${choiceLetter}] ${choiceText ? `(${choiceText})` : ''}!`);
        return;
      }
    }

    // C. Fill Text Inputs — never touch OUR OWN UI's inputs (BUG#6: the hint box
    //    #ioe-slot-hint-input used to swallow half of a multi-word answer)
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, .input-answer, #txtAnswer'))
      .filter(el => !el.closest("#ioe-master-root"));
    const visibleInputs = inputs.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== "none";
    });

    if (visibleInputs.length > 0) {
      const words = cleanAns.split(/\s+/);

      if (visibleInputs.length === 1) {
        fillInputElement(visibleInputs[0], cleanAns);
        actionTaken = true;
      } else {
        visibleInputs.forEach((input, i) => {
          if (words[i]) {
            fillInputElement(input, words[i]);
            actionTaken = true;
          }
        });
      }

      if (actionTaken) {
        showToast(`✍️ Đã điền: "${cleanAns}"!`);
        visibleInputs[visibleInputs.length - 1].focus();
        return;
      }
    }

    navigator.clipboard.writeText(cleanAns);
    showToast(`📋 Đã copy đáp án: "${cleanAns}"`);
  }

  async function triggerHumanizedAutoFillOrSelect(customText = null) {
    if (lastMatchingPairs && lastMatchingPairs.length > 0) {
      await executeMatchingClicksSequentially();
      return;
    }

    const textToFill = (customText || lastAnswerParsed || "").trim();
    if (!textToFill) return;

    // Check if True/False or MCQ
    if (textToFill.toLowerCase().startsWith("true") || textToFill.toLowerCase().startsWith("false") || textToFill.match(/^([A-D])(\.|\s|$)/i)) {
      triggerUniversalAutoFillOrSelect();
      return;
    }

    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, .input-answer, #txtAnswer'))
      .filter(el => !el.closest("#ioe-master-root"));
    const visibleInputs = inputs.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== "none";
    });

    if (visibleInputs.length > 0) {
      const words = textToFill.split(/\s+/);

      if (visibleInputs.length === 1) {
        await typeIntoElementHumanLike(visibleInputs[0], textToFill);
      } else {
        for (let i = 0; i < visibleInputs.length; i++) {
          if (words[i]) {
            await typeIntoElementHumanLike(visibleInputs[i], words[i]);
            await sleep(getRandomHumanDelay(150, 300));
          }
        }
      }
      showToast(`✍️ Đã điền: "${textToFill}"!`);
      return;
    }

    triggerUniversalAutoFillOrSelect();
  }

  async function typeIntoElementHumanLike(el, text) {
    el.focus();
    el.value = "";
    for (let i = 0; i < text.length; i++) {
      el.value += text[i];
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(getRandomHumanDelay(45, 110));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillInputElement(el, text) {
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function triggerSubmitButton() {
    const btn = document.querySelector('button#btnAnswer, button.btn-submit, button.btn-answer-submit, #btn_answer, .btn-nopbai, button[class*="submit"]');
    if (btn) {
      btn.click();
      return;
    }
    const canvas = findGameCanvas();
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const targetX = rect.left + (rect.width * 0.65);
      const targetY = rect.top + (rect.height * 0.76);
      simulateClick(canvas, targetX, targetY);
    }
  }

  function findGameCanvas() {
    let canvas = document.querySelector("canvas");
    if (canvas) return canvas;
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const c = iframe.contentDocument?.querySelector("canvas");
        if (c) return c;
      } catch (e) {}
    }
    return null;
  }

  function renderClickRipple(x, y) {
    const dot = document.createElement("div");
    dot.style.cssText = `position: fixed; left: ${x - 14}px; top: ${y - 14}px; width: 28px; height: 28px; border-radius: 50%; background: rgba(239, 68, 68, 0.4); border: 2px solid #ef4444; z-index: 2147483647; pointer-events: none; animation: ioe-ripple 0.5s ease-out forwards;`;
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 550);
  }

  function simulateClick(element, clientX, clientY) {
    if (!element) element = findGameCanvas();
    if (!element) return;

    renderClickRipple(clientX, clientY);

    const targetEl = document.elementFromPoint(clientX, clientY) || element;
    const rect = targetEl.getBoundingClientRect ? targetEl.getBoundingClientRect() : element.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const screenX = (window.screenX || 0) + clientX;
    const screenY = (window.screenY || 0) + clientY;

    const baseEvent = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      screenX: screenX,
      screenY: screenY,
      clientX: clientX,
      clientY: clientY,
      pageX: clientX + (window.scrollX || 0),
      pageY: clientY + (window.scrollY || 0),
      offsetX: offsetX,
      offsetY: offsetY,
      x: clientX,
      y: clientY,
      layerX: offsetX,
      layerY: offsetY,
      button: 0,
      buttons: 1,
      which: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    };

    // 1. Move to update engine's internal hover/mouse target
    targetEl.dispatchEvent(new MouseEvent("mousemove", { ...baseEvent, buttons: 0 }));
    if (window.PointerEvent) {
      try { targetEl.dispatchEvent(new PointerEvent("pointermove", { ...baseEvent, buttons: 0 })); } catch (e) {}
    }

    // 2. PointerDown & MouseDown
    if (window.PointerEvent) {
      try { targetEl.dispatchEvent(new PointerEvent("pointerdown", baseEvent)); } catch (e) {}
    }
    targetEl.dispatchEvent(new MouseEvent("mousedown", baseEvent));

    // 3. PointerUp, MouseUp & Click
    const upEvent = { ...baseEvent, buttons: 0 };
    if (window.PointerEvent) {
      try { targetEl.dispatchEvent(new PointerEvent("pointerup", upEvent)); } catch (e) {}
    }
    targetEl.dispatchEvent(new MouseEvent("mouseup", upEvent));
    targetEl.dispatchEvent(new MouseEvent("click", upEvent));

    // 4. Also dispatch directly on canvas if targetEl was a wrapper/container
    if (element !== targetEl) {
      element.dispatchEvent(new MouseEvent("mousemove", { ...baseEvent, buttons: 0 }));
      element.dispatchEvent(new MouseEvent("mousedown", baseEvent));
      element.dispatchEvent(new MouseEvent("mouseup", upEvent));
      element.dispatchEvent(new MouseEvent("click", upEvent));
    }

    // 5. Direct CreateJS / EaselJS stage hook
    const win = element.ownerDocument?.defaultView || window;
    const stage = win.stage || win.exportRoot?.stage || (win.createjs && win.createjs.Stage?._stages?.[0]);
    if (stage && stage.handleEvent) {
      try {
        const scaleX = stage.scaleX || 1;
        const scaleY = stage.scaleY || 1;
        const stageX = offsetX / scaleX;
        const stageY = offsetY / scaleY;
        stage.mouseX = stageX;
        stage.mouseY = stageY;

        stage.handleEvent({
          type: "stagemousedown",
          stageX: stageX,
          stageY: stageY,
          rawX: clientX,
          rawY: clientY,
          nativeEvent: baseEvent
        });
        stage.handleEvent({
          type: "stagemouseup",
          stageX: stageX,
          stageY: stageY,
          rawX: clientX,
          rawY: clientY,
          nativeEvent: upEvent
        });
        stage.handleEvent({
          type: "click",
          stageX: stageX,
          stageY: stageY,
          rawX: clientX,
          rawY: clientY,
          nativeEvent: upEvent
        });
      } catch (e) {}
    }
  }

  // 6.5 Audio Synchronization Engine
  async function ensureFreshAudioReady(isAudioGame, timeoutMs = 3000) {
    if (!isAudioGame) return null;
    const canvas = findGameCanvas();
    const startTime = Date.now();

    // If audio is already fresh and ready
    if (window.__LAST_CAPTURED_IOE_AUDIO__ && window.__LAST_CAPTURED_IOE_AUDIO__.isReady && window.__LAST_CAPTURED_IOE_AUDIO__.base64 && (Date.now() - window.__LAST_CAPTURED_IOE_AUDIO__.timestamp < 15000)) {
      return window.__LAST_CAPTURED_IOE_AUDIO__;
    }

    // Trigger Play / Replay button on canvas
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const playBtnX = rect.left + (rect.width * 0.165);
      const playBtnY = rect.top + (rect.height * 0.315);
      simulateClick(canvas, playBtnX, playBtnY);
    }

    // Await until audio is intercepted AND converted to Base64
    while (Date.now() - startTime < timeoutMs) {
      if (window.__LAST_CAPTURED_IOE_AUDIO__ && window.__LAST_CAPTURED_IOE_AUDIO__.isReady && window.__LAST_CAPTURED_IOE_AUDIO__.base64) {
        return window.__LAST_CAPTURED_IOE_AUDIO__;
      }
      await sleep(100);
    }

    return window.__LAST_CAPTURED_IOE_AUDIO__ || null;
  }

  // 6.7 OVERLAY READER - deterministic multi-source extraction into editable box
  let lastOverlayReadText = "";

  function runOverlayRead(silent = false) {
    createIOEUI();
    const readerText = ioeRootEl.querySelector("#ioe-reader-text");
    const readerStats = ioeRootEl.querySelector("#ioe-reader-stats");
    if (!readerText) return "";

    let result = { text: "", stats: {} };
    if (window.__IOE_OVERLAY_READER__) {
      try { result = window.__IOE_OVERLAY_READER__.readStructured(); } catch (e) { console.warn(e); }
    }

    lastOverlayReadText = result.text || "";

    if (lastOverlayReadText) {
      readerText.value = lastOverlayReadText;
      if (readerStats) {
        const s = result.stats || {};
        readerStats.textContent = `${lastOverlayReadText.length} ký tự • ${s.domBlocks || 0} khối DOM${s.hasCanvasText ? " • canvas" : ""}${s.memoryStrings ? " • memory" : ""}`;
      }
      if (!silent) showToast(`📖 Đã đọc ${lastOverlayReadText.length} ký tự từ trang.`);
    } else {
      if (readerStats) readerStats.textContent = "không đọc được (dán thủ công)";
      if (!silent) showToast("⚠️ Không đọc được đề từ trang, hãy dán thủ công.");
    }
    return lastOverlayReadText;
  }

  window.runOverlayReadIOE = runOverlayRead;

  // 6.7.1 Build prompt text from the exact IOE game API JSON (Cocos games)
  function buildGameApiPromptText() {
    const st = getGameBridgeStateDirect();
    if (!st || !st.questions || !st.questions.length) return "";

    const lines = [];
    lines.push("DỮ LIỆU ĐỀ THI ĐỌC TRỰC TIẾP TỪ API GAME IOE (CHÍNH XÁC 100%, KHÔNG CẦN OCR):");
    lines.push(`Mã đề: ${st.examKey || "?"} | Tổng điểm: ${st.totalPoint || "?"} | Thời gian: ${st.examTime || "?"}s`);
    if (st.gameDesc) lines.push(`Hướng dẫn game: ${st.gameDesc}`);
    lines.push("");
    lines.push(`Tổng số câu: ${st.questions.length}`);
    lines.push("");

    st.questions.forEach((q) => {
      const fmt = q.format;
      let kind = "Khác";
      if (q.masked) kind = "NGHE ĐIỀN TỪ (từ bị che ***)";
      else if (q.isListening) kind = "NGHE True/False";
      else if (fmt === 25) kind = "Ghép cặp (Anh-Việt)";
      else if (q.answers && q.answers.length >= 2) kind = "Trắc nghiệm";
      else if (q.answers && q.answers.length === 1) kind = "Điền từ/1 đáp án";

      lines.push(`Câu ${q.index} [${kind}] (format=${fmt}, type=${q.type}, điểm=${q.point}):`);
      if (q.audio) lines.push(`  - File nghe: ${q.audio}`);
      if (q.prompt) lines.push(`  - Nội dung/Đề: ${q.prompt}`);
      if (q.masked) lines.push(`  - Từ bị che: "${(q.maskPrefix || "") + "*".repeat(Math.min(q.maskStars || 5, 20))}" (${q.maskStars || "?"} chữ cái ẩn${q.maskPrefix ? `, tiền tố "${q.maskPrefix}"` : ""})`);
      if (q.answers && q.answers.length) {
        q.answers.forEach((a, i) => lines.push(`  - Đáp án [${String.fromCharCode(65 + i)}]: ${a}`));
      }
      if (q.tans && q.tans.length) lines.push(`  - Đáp án đúng (tans): ${q.tans.join(" | ")}`);
      lines.push("");
    });

    if (st.answerPool && st.answerPool.length) {
      lines.push("KHO TỪ GỢI Ý (answerPool — cho câu điền từ/ghép cặp):");
      st.answerPool.forEach((a, i) => lines.push(`  [${i + 1}] ${a}`));
      lines.push("");
    }

    lines.push("YÊU CẦU: Dựa vào dữ liệu trên, hãy đưa ra đáp án đúng cho từng câu theo đúng định dạng tag: câu NGHE ĐIỀN TỪ → [FILL_WORDS: 1. từ_1, 2. từ_2, ...]; câu NGHE True/False → [TF_ANSWERS: ...] (nghe file audio đính kèm); câu Trắc nghiệm nhiều câu → [MCQ_ANSWERS: ...]; ghép cặp → [MATCH_PAIRS: ...]; câu đơn → [ANSWER: ...].");
    return lines.join("\n");
  }

  // 6.8 DEEP PASSAGE EXTRACTOR & AUTO-SCROLL CAPTURE ENGINE
  function extractFullReadingPassage() {
    let passageParts = [];

    // 0. Prefer deterministic overlay reader if it produced richer text
    if (window.__IOE_OVERLAY_READER__) {
      try {
        const overlayText = window.__IOE_OVERLAY_READER__.readQuestionText();
        if (overlayText && overlayText.length >= 60) {
          passageParts.push(overlayText);
        }
      } catch (e) {}
    }


    // 1. Check DOM Reading Elements (innerText contains 100% of untruncated story/passage)
    //    BUG#9: skip OUR OWN panel/pill so the AI never sees extension UI text.
    const domSelectors = [
      '.reading-content', '.passage', '.reading-text', '.text-reading',
      '#contentReading', '.exam-reading', '.box-reading', '.scroll-text',
      '[class*="reading"]', '[class*="passage"]', '[class*="story"]',
      '#txtQuestion', '.question-title', '.question-content'
    ];

    const domEls = document.querySelectorAll(domSelectors.join(","));
    for (const el of domEls) {
      if (el.closest && el.closest("#ioe-master-root")) continue;
      const txt = (el.innerText || "").trim();
      if (txt.length >= 60 && !passageParts.includes(txt)) {
        passageParts.push(txt);
      }
    }

    // Check all scrollable DOM elements
    const allDivs = document.querySelectorAll("div, p, section, article");
    for (const d of allDivs) {
      if (d.closest && d.closest("#ioe-master-root")) continue;
      if (d.scrollHeight > d.clientHeight + 40) {
        const txt = (d.innerText || "").trim();
        if (txt.length >= 80 && !passageParts.includes(txt)) {
          passageParts.push(txt);
        }
      }
    }

    // 2. Check CreateJS / EaselJS Stage Tree
    const canvas = findGameCanvas();
    if (canvas) {
      const win = canvas.ownerDocument?.defaultView || window;
      const stage = win.stage || win.exportRoot?.stage || (win.createjs && win.createjs.Stage?._stages?.[0]);
      if (stage) {
        try {
          const stageTexts = [];
          function walkStageForText(obj) {
            if (!obj) return;
            if (obj.text && typeof obj.text === "string") {
              const t = obj.text.trim();
              if (t.length >= 25) stageTexts.push(t);
            }
            if (obj.children && Array.isArray(obj.children)) {
              for (const child of obj.children) walkStageForText(child);
            }
          }
          walkStageForText(stage);
          if (stageTexts.length > 0) {
            const joinedStageText = stageTexts.join("\n");
            if (joinedStageText.length >= 60 && !passageParts.some(p => p.includes(joinedStageText))) {
              passageParts.push(joinedStageText);
            }
          }
        } catch (e) {}
      }
    }

    // 3. Check Global Game Memory
    const candidateKeys = ["curQuestion", "currentQuestion", "gameData", "testData", "currentQues", "questionData", "examData"];
    for (const k of candidateKeys) {
      if (window[k]) {
        try {
          const data = window[k];
          if (typeof data === "object") {
            const str = JSON.stringify(data);
            const matches = str.match(/("content"|"reading"|"passage"|"text"|"story")\s*:\s*"([^"]{60,})"/gi);
            if (matches) {
              matches.forEach(m => {
                const clean = m.replace(/^[^:]+:\s*"/, "").replace(/"$/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
                if (clean.length >= 60 && !passageParts.includes(clean)) {
                  passageParts.push(clean);
                }
              });
            }
          }
        } catch (e) {}
      }
    }

    return passageParts.join("\n\n---\n\n").trim();
  }

  // 6.9 SMART AUTO-SCROLL DOUBLE-SHOT SCREENSHOT
  async function captureSmartScreenshotsWithAutoScroll() {
    if (ioeRootEl) ioeRootEl.style.opacity = "0";
    await sleep(70);

    // 1. Capture Top View (Part 1)
    const topShotResp = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: "CAPTURE_TAB_ONLY" }, resolve);
    });
    const topShot = topShotResp?.dataUrl || null;

    // 2. Check if there is a scrollable container in DOM or Canvas
    const scrollableDom = Array.from(document.querySelectorAll("div, section, article, .reading-content, .passage, [class*='scroll']")).find(el => {
      return el.scrollHeight > el.clientHeight + 40 && el.offsetHeight > 50;
    });

    const canvas = findGameCanvas();
    let scrolled = false;

    if (scrollableDom) {
      scrollableDom.scrollTop = scrollableDom.scrollHeight;
      scrolled = true;
    } else if (canvas && !isCocosGame()) {
      // NOTE: never simulate clicks on a Cocos canvas here — the click lands on a
      // gameplay node and would pre-select an answer before solving starts.
      canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 800, bubbles: true }));
      scrolled = true;
    }

    let bottomShot = null;
    if (scrolled) {
      // Wait ≥0.5s: Chrome throttles captureVisibleTab to 2 calls/second, so a
      // second capture fired too soon after the first silently fails.
      await sleep(600);
      const bottomShotResp = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: "CAPTURE_TAB_ONLY" }, resolve);
      });
      bottomShot = bottomShotResp?.dataUrl || null;

      if (scrollableDom) {
        scrollableDom.scrollTop = 0;
      }
    }

    if (ioeRootEl) ioeRootEl.style.opacity = "1";

    if (topShot && bottomShot && topShot !== bottomShot) {
      console.log("[English Master AI] 📸 Captured 2-Part Multi-Scroll Screenshot (Top + Bottom)!");
      return [topShot, bottomShot];
    } else if (topShot) {
      return [topShot];
    }
    return [];
  }

  // 7. EXECUTE SOLVER
async function executeScreenAndAudioSolve(customHint = "", callback = null, options = {}) {
    if (isSolving) {
      // BUG#22: trả callback(false, busySkipped=true) để caller phân biệt "bị
      // bỏ qua vì đang bận" với "AI giải thất bại" (auto-pilot cần điều này
      // để retry im lặng thay vì báo lỗi).
      if (callback) callback(false, null, false, false, false, false, false, true);
      return;
    }
    // BUG#22: giành khóa toàn cục chống giải lồng nhau — mọi trigger đều đi qua
    // đây nên đang giải thì lần gọi mới bị bỏ qua + hiện toast hướng dẫn.
    if (!tryAcquireSolverBusy()) {
      if (callback) callback(false, null, false, false, false, false, false, true);
      return;
    }
    // Wrap callback: khóa chỉ được nhả khi TOÀN BỘ hậu kỳ của caller (tự click
    // ghép cặp / click True-False / gõ từ / điền đáp án) chạy xong — không phải
    // khi AI vừa trả lời như bản cũ (isSolving=false đặt tại đầu handler
    // sendMessage trong khi callback click/gõ vẫn đang chạy → bấm thêm là lồng).
    const releaseLock = () => releaseSolverBusy();
    const cb = callback
      ? (...args) => Promise.resolve()
          .then(() => callback(...args))
          .catch((e) => console.warn("[English Master AI] Solver callback error:", e))
          .finally(releaseLock)
      : null;
    createIOEUI();
    panelEl.classList.remove("hidden");

    isSolving = true;
    lastMatchingPairs = [];
    lastTrueFalseAnswers = [];
    const qBox = ioeRootEl.querySelector("#ioe-question-display");
    const contentBox = ioeRootEl.querySelector("#ioe-panel-content");
    const hintInput = ioeRootEl.querySelector("#ioe-slot-hint-input");
    const readerText = ioeRootEl.querySelector("#ioe-reader-text");
    const useOverride = !!(options && options.textOverride && options.textOverride.trim());

    // Auto-detect game type from URL
    const isMatchingUrl = window.location.href.includes("ghep-cap") || window.location.href.includes("matching");
    const isDonRacUrl = window.location.href.includes("don-rac-bai-bien") || window.location.href.includes("don-rac");
    let detectedSlotInfo = "";

    if (isDonRacUrl && !customHint) {
      detectedSlotInfo = "Bài thi Nghe True/False (Dọn rác bãi biển)";
      hintInput.value = detectedSlotInfo;
    } else if (isMatchingUrl && !customHint) {
      detectedSlotInfo = "Bài thi Ghép Cặp (12 ô: 3 hàng x 4 cột)";
      hintInput.value = detectedSlotInfo;
    } else if (window.__IOE_SLOT_INSPECTOR__ && !customHint) {
      const analysis = window.__IOE_SLOT_INSPECTOR__.getCompleteSlotAnalysis();
      if (analysis && analysis.count) {
        if (analysis.source === "DOM_INPUTS") {
          detectedSlotInfo = `Đọc từ DOM: ${analysis.count} ô nhập liệu`;
        } else if (analysis.source === "CANVAS_PIXEL_SCAN") {
          detectedSlotInfo = `Quét từ Canvas: ${analysis.count} ô gạch dưới`;
        }
        hintInput.value = detectedSlotInfo;
      }
    }

    const effectiveHint = customHint || detectedSlotInfo;

    // Detect multi-question True/False listening exam via game API (each question has its own audio file)
    const apiQuestions = getGameQuestions() || [];
    const examClass = classifyExam(apiQuestions);
    // Masked listening exams (fill-word) are NOT True/False — exclude them here so
    // they take the dedicated fill-word path instead of the TF pipeline (BUG#1).
    const isMultiTfExam = apiQuestions.length > 1 &&
      apiQuestions.every(q => q.isListening && q.audio) &&
      !apiQuestions.every(q => q.masked);

    // Data-driven dispatch: when we already hold the exact API JSON for a
    // fill-word / multi-MCQ exam, solve it straight from the data (AI + typing /
    // option clicking) — regardless of which button (F2 / Tự Làm) fired this.
    if (!useOverride && (examClass === "listening_fillword" || examClass === "mcq_multi")) {
      const stE = getGameBridgeStateDirect();
      const done = examClass === "listening_fillword"
        ? await solveAndTypeFillWords(apiQuestions, stE)
        : await solveAndClickMcqMulti(apiQuestions, stE);
      // BUG#22: isSolving chỉ reset SAU khi phase gõ/click thật sự xong (bản cũ
      // reset TRƯỚC → suốt vài phút gõ từ, isSolving=false → bấm thêm là lồng).
      isSolving = false;
      if (isAutoRunning && done) {
        showToast("✅ Bot đã làm xong toàn bộ bài này.");
        stopAutoPilot();
      }
      if (cb) cb(!!done, null, false, false, false, false, false); else releaseLock();
      return;
    }

    // Ensure audio is captured and Base64 is 100% ready before sending to AI
    let audioData = null;
    let multiAudioUrls = null;
    if (isMultiTfExam) {
      multiAudioUrls = apiQuestions.map(q => q.audio).filter(Boolean);
    } else if (isDonRacUrl) {
      audioData = await ensureFreshAudioReady(true, 3000);
    }

    qBox.textContent = isAutoRunning ? "🤖 [Tự Làm] Đang phân tích bài thi & đoạn đọc..." : (isMultiTfExam ? `🎧 Đang nghe ${multiAudioUrls.length} câu True/False...` : "📸 Đang chụp bài thi (hỗ trợ cuộn & trích xuất bài đọc)...");

    contentBox.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 25px 0;">
        <div style="width: 32px; height: 32px; border: 3px solid #e2e8f0; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.7s linear infinite; margin-bottom: 12px;"></div>
        <span style="font-weight: 700; color: #4f46e5; font-size: 14px;">
          ${isMultiTfExam ? `🎧 Đang nghe & giải ${multiAudioUrls.length} câu True/False...` : (isDonRacUrl ? '🎧 Đang nghe bài đọc & giải True/False...' : (isMatchingUrl ? '🧩 Đang nhận diện & ghép các cặp thẻ...' : 'AI đang phân tích & giải đề thi IOE...'))}
        </span>
        <span style="font-size: 11.5px; color: #64748b; margin-top: 6px;">
          ${effectiveHint ? effectiveHint : 'Tự động nhận diện True/False • Ghép cặp • Trắc nghiệm • Đoạn đọc cuộn • Điền từ'}
        </span>
      </div>
    `;

    // 1. Deep Extract Full Passage Text (100% untruncated by scrollbars)
    let extractedPassage = "";
    if (useOverride) {
      extractedPassage = options.textOverride.trim();
      if (readerText) readerText.value = extractedPassage;
      if (ioeRootEl) {
        const rs = ioeRootEl.querySelector("#ioe-reader-stats");
        if (rs) rs.textContent = `${extractedPassage.length} ký tự • thủ công`;
      }
    } else {
      // Prefer exact exam JSON captured from the IOE game API (Cocos games)
      const apiText = buildGameApiPromptText();
      if (apiText) {
        extractedPassage = apiText;
        requestGameBridgeSync();
        if (readerText) readerText.value = apiText;
        if (ioeRootEl) {
          const rs = ioeRootEl.querySelector("#ioe-reader-stats");
          const qs = getGameQuestions() || [];
          if (rs) rs.textContent = `${qs.length} câu • 🎮 đọc từ API game (chính xác 100%)`;
        }
      } else {
        extractedPassage = extractFullReadingPassage();
        if (extractedPassage && readerText && !readerText.value.trim()) readerText.value = extractedPassage;
        if (extractedPassage && ioeRootEl) {
          const rs = ioeRootEl.querySelector("#ioe-reader-stats");
          if (rs) rs.textContent = `${extractedPassage.length} ký tự • tự động`;
        }
      }
    }

    let promptPayloadText = "";
    if (extractedPassage) {
      promptPayloadText = `\n\n[ĐỀ BÀI / ĐOẠN VĂN TRÍCH XUẤT TỪ TRANG (ĐÃ ĐẦY ĐỦ, BỎ QUA GIỚI HẠN THANH CUỘN)]:\n${extractedPassage}\n\n`;
      console.log(`[English Master AI] 📖 Extracted Full Passage (${extractedPassage.length} chars)`);
    }

    // 2. Multi-Shot Auto-Scroll Screenshot
    const capturedImages = await captureSmartScreenshotsWithAutoScroll();

    const capturedBase64 = (audioData && audioData.base64) ? audioData.base64 : ((window.__LAST_CAPTURED_IOE_AUDIO__ && window.__LAST_CAPTURED_IOE_AUDIO__.base64) ? window.__LAST_CAPTURED_IOE_AUDIO__.base64 : null);
    const activeAudioUrl = (audioData && audioData.url) ? audioData.url : (window.__LAST_CAPTURED_IOE_AUDIO__ ? window.__LAST_CAPTURED_IOE_AUDIO__.url : null);

    chrome.runtime.sendMessage({
      action: "SOLVE_CURRENT_SCREEN",
      images: capturedImages.length > 0 ? capturedImages : null,
      text: promptPayloadText,
      audioUrl: activeAudioUrl,
      audioBase64: capturedBase64,
      audioUrls: multiAudioUrls,
      hint: effectiveHint,
      examKind: isMultiTfExam ? "tf" : null
    }, (resp) => {
      isSolving = false;
      if (!resp) {
        contentBox.innerHTML = '<div style="color: red; padding: 10px;">Không thể kết nối đến extension.</div>';
        if (cb) cb(false, null, false, false, false, false, false); else releaseLock();
        return;
      }

      if (resp.success) {
        let rawAnswer = resp.data;
        let isMatching = false;
        let isTrueFalse = false;
        let isMcq = false;
        let isMultiTf = false;
        let bannerHtml = "";
        lastFillWords = [];
        lastMcqPicks = [];

        // Multi fill-word: [FILL_WORDS: 1. supposed, 2. meets, ...] → cache & execute via the fill-word pipeline
        const fillTag = rawAnswer.match(/\[FILL_WORDS:\s*([^\]]+)\]/i);
        if (fillTag) {
          const items = parseTagItems(fillTag[1]);
          lastFillWords = items.map(w => (w == null ? null : String(w).trim().replace(/^["']|["']$/g, "")));
          // Persist per-question answers so a repeated question is instant next time
          // (pool-aware key — see qCacheKeyFor, BUG#11)
          const poolNow = (getGameBridgeStateDirect() || {}).answerPool || [];
          if (apiQuestions.length && apiQuestions.length === lastFillWords.length) {
            apiQuestions.forEach((q, i) => {
              if (lastFillWords[i]) saveQCacheEntry(qCacheKeyFor(q, poolNow), lastFillWords[i]);
            });
          }
          rawAnswer = rawAnswer.replace(/\[FILL_WORDS:\s*[^\]]+\]/i, "").trim();
          lastAnswerParsed = lastFillWords.map((w, i) => `${i + 1}. ${w || "?"}`).join(", ");
          const fwChips = lastFillWords.map((w, idx) => `
            <span class="ioe-slot-chip" data-act="type" data-word="${escapeHtml(w || "")}" style="${w ? "background:#ede9fe; border-color:#7c3aed;" : "background:#fee2e2; border-color:#ef4444;"}cursor:pointer;" title="Click để gõ lại từ này">
              ${idx + 1}: <strong>${escapeHtml(w || "?")}</strong>
            </span>
          `).join("");
          bannerHtml = `
            <div class="ioe-ans-banner">
              <div class="ioe-ans-label"><span>✍️ KẾT QUẢ NGHE ĐIỀN TỪ (${lastFillWords.length} CÂU)</span></div>
              <div class="ioe-slot-chips">${fwChips}</div>
            </div>
          `;
        } else if (/\[MCQ_ANSWERS:\s*([^\]]+)\]/i.test(rawAnswer)) {
          // Multi-MCQ: [MCQ_ANSWERS: 1. B, 2. A, ...]
          const mqTag = rawAnswer.match(/\[MCQ_ANSWERS:\s*([^\]]+)\]/i);
          const items = parseTagItems(mqTag[1]);
          lastMcqPicks = items.map(v => {
            const m = (v == null ? "" : String(v).trim().toUpperCase()).match(/^([A-D])/);
            return m ? m[1] : null;
          });
          const poolNow2 = (getGameBridgeStateDirect() || {}).answerPool || [];
          if (apiQuestions.length && apiQuestions.length === lastMcqPicks.length) {
            apiQuestions.forEach((q, i) => {
              if (lastMcqPicks[i]) saveQCacheEntry(qCacheKeyFor(q, poolNow2), lastMcqPicks[i]);
            });
          }
          rawAnswer = rawAnswer.replace(/\[MCQ_ANSWERS:\s*[^\]]+\]/i, "").trim();
          lastAnswerParsed = lastMcqPicks.map((v, i) => `${i + 1}. ${v || "?"}`).join(", ");
          const mqChips = lastMcqPicks.map((v, idx) => `
            <span class="ioe-slot-chip" style="${v ? "background:#dcfce7; border-color:#10b981;" : "background:#fee2e2; border-color:#ef4444;"}">
              Câu ${idx + 1}: <strong>${v || "?"}</strong>
            </span>
          `).join("");
          bannerHtml = `
            <div class="ioe-ans-banner">
              <div class="ioe-ans-label"><span>🎯 KẾT QUẢ TRẮC NGHIỆM (${lastMcqPicks.length} CÂU)</span></div>
              <div class="ioe-slot-chips">${mqChips}</div>
            </div>
          `;
        } else {
        // Check for MULTI True/False tag FIRST: [TF_ANSWERS: 1. True, 2. False, ...]
        const tfTag = rawAnswer.match(/\[TF_ANSWERS:\s*([^\]]+)\]/i);
        if (tfTag) {
          isMultiTf = true;
          const inner = tfTag[1];
          lastTrueFalseAnswers = [];
          // Accept both "1. True", "1: True", "1 - True" and bare "True, False, ..." lists
          let bareListCount = 0;
          const numbered = inner.match(/(\d+)\s*[.\):-]\s*(true|false)/gi);
          if (numbered && numbered.length) {
            for (const tok of numbered) {
              const m = tok.match(/(\d+)\s*[.\):-]\s*(true|false)/i);
              const idx = parseInt(m[1]);
              const val = m[2].toLowerCase() === "true";
              lastTrueFalseAnswers[idx - 1] = val;
            }
          } else {
            const toks = inner.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
            bareListCount = toks.length;
            toks.forEach((t, i) => { lastTrueFalseAnswers[i] = t.toLowerCase().startsWith("t"); });
          }
          // Compact sparse array & validate — pad back to the FULL question count
          // from the game API so a partially-numbered AI answer (e.g. 8 of 10)
          // still leaves slots for every question. Missing slots default to True
          // (listening statements are usually correct assertions).
          const totalQuestions = Math.max(apiQuestions.length, lastTrueFalseAnswers.length, 1);
          const padded = [];
          for (let k = 0; k < totalQuestions; k++) {
            padded.push(typeof lastTrueFalseAnswers[k] === "boolean" ? lastTrueFalseAnswers[k] : true);
          }
          lastTrueFalseAnswers = padded;

          rawAnswer = rawAnswer.replace(/\[TF_ANSWERS:\s*[^\]]+\]/i, "").trim();
          lastAnswerParsed = lastTrueFalseAnswers.map((v, i) => `${i + 1}. ${v ? "True" : "False"}`).join(", ");

          // Count how many slots the AI actually answered (for the note below)
          const aiAnsweredCount = (numbered && numbered.length) ? numbered.length : bareListCount;

          const tfChips = lastTrueFalseAnswers.map((v, idx) => `
            <span class="ioe-slot-chip" style="${v ? "background:#dcfce7; border-color:#10b981;" : "background:#fee2e2; border-color:#ef4444;"}">
              Câu ${idx + 1}: <strong>${v ? "True" : "False"}</strong>
            </span>
          `).join("");

          const missingNote = (aiAnsweredCount < lastTrueFalseAnswers.length)
            ? `<div style="margin-top:6px; font-size:11.5px; color:#b45309; font-weight:600;">⚠️ AI trả lời ${aiAnsweredCount}/${lastTrueFalseAnswers.length} câu — câu thiếu mặc định True (khẳng định nghe thường đúng)</div>`
            : "";

          bannerHtml = `
            <div class="ioe-ans-banner">
              <div class="ioe-ans-label">
                <span>🎧 KẾT QUẢ TRUE/FALSE (${lastTrueFalseAnswers.length} CÂU)</span>
              </div>
              <div class="ioe-slot-chips">${tfChips}</div>
              ${missingNote}
            </div>
          `;
        } else {
          // Check for MATCH_PAIRS tag
          const matchPairTag = rawAnswer.match(/\[MATCH_PAIRS:\s*([^\]]+)\]/i);
          if (matchPairTag) {
          isMatching = true;
          const pairsStr = matchPairTag[1].trim();
          const pairTokens = pairsStr.split(/[,;\s]+/).filter(Boolean);
          lastMatchingPairs = pairTokens.map(p => p.split("-")).filter(p => p.length === 2);
          lastAnswerParsed = pairsStr;

          rawAnswer = rawAnswer.replace(/\[MATCH_PAIRS:\s*[^\]]+\]/i, "").trim();

          const pairChips = lastMatchingPairs.map((p, idx) => `
            <span class="ioe-slot-chip" data-act="match" data-a="${p[0]}" data-b="${p[1]}" title="Click để tự bấm cặp này" style="cursor:pointer;">
              Cặp ${idx+1}: <strong>Ô ${p[0]} ↔ Ô ${p[1]}</strong>
            </span>
          `).join("");

          bannerHtml = `
            <div class="ioe-ans-banner">
              <div class="ioe-ans-label">
                <span>🧩 KẾT QUẢ GHÉP CẶP (${lastMatchingPairs.length} CẶP)</span>
                <span>(Click ô để tự bấm)</span>
              </div>
              <div class="ioe-slot-chips">${pairChips}</div>
            </div>
          `;
        } else {
          // Normal ANSWER tag
          const match = rawAnswer.match(/\[ANSWER:\s*([^\]]+)\]/i);
          if (match) {
            lastAnswerParsed = match[1].trim();
            rawAnswer = rawAnswer.replace(/\[ANSWER:\s*[^\]]+\]/i, "").trim();
          } else {
            lastAnswerParsed = "";
          }

          if (lastAnswerParsed.toLowerCase() === "true" || lastAnswerParsed.toLowerCase() === "false") {
            isTrueFalse = true;
          }

          const mcqCheck = lastAnswerParsed.match(/^([A-D])(?:\.\s*|\s+)?(.*)$/i);
          if (mcqCheck) {
            isMcq = true;
          }

          let slotChipsHtml = "";
          if (isMcq) {
            const optLetter = mcqCheck[1].toUpperCase();
            const optText = mcqCheck[2] ? mcqCheck[2].trim() : "";
            slotChipsHtml = `
              <div class="ioe-slot-chips">
                <span class="ioe-slot-chip" style="background: #4f46e5; color: #ffffff; border-color: #4338ca; cursor: pointer;" data-act="autofill" title="Click để tự động chọn đáp án này">
                  🎯 Tự chọn đáp án: <strong>[${optLetter}]</strong> ${optText ? `(${escapeHtml(optText)})` : ''}
                </span>
              </div>
            `;
          } else if (!isTrueFalse && lastAnswerParsed && lastAnswerParsed.includes(" ")) {
            const words = lastAnswerParsed.split(/\s+/);
            const chips = words.map((w, idx) => `
              <span class="ioe-slot-chip" data-act="copyword" data-w="${escapeHtml(w)}" style="cursor:pointer;" title="Click để copy từ này">
                Ô ${idx+1}: <strong>${escapeHtml(w)}</strong> (${w.length} ký tự)
              </span>
            `).join("");
            slotChipsHtml = `<div class="ioe-slot-chips">${chips}</div>`;
          }

          if (lastAnswerParsed) {
            bannerHtml = `
              <div class="ioe-ans-banner">
                <div class="ioe-ans-label">
                  <span>✨ ${isMcq ? 'ĐÁP ÁN TRẮC NGHIỆM' : (isTrueFalse ? 'KẾT QUẢ TRUE / FALSE' : 'ĐÁP ÁN CHÍNH XÁC')}</span>
                </div>
                <div class="ioe-ans-value">${escapeHtml(lastAnswerParsed)}</div>
                ${slotChipsHtml}
              </div>
            `;
          }
        }
        }
        }

        qBox.textContent = isMultiTf ? `🎧 Đã giải xong ${lastTrueFalseAnswers.length} câu True/False — đang tự click...` : (lastFillWords.length ? `✍️ Đã có ${lastFillWords.filter(Boolean).length} từ điền — đang tự gõ...` : (lastMcqPicks.length ? `🎯 Đã có ${lastMcqPicks.filter(Boolean).length} đáp án trắc nghiệm — đang tự chọn...` : (isTrueFalse ? `🎧 Đáp án: ${lastAnswerParsed}` : (isMatching ? "🧩 Đã nhận diện & ghép xong các cặp thẻ!" : (isMcq ? `🎯 Đáp án trắc nghiệm: ${lastAnswerParsed}` : "✅ Đã giải xong câu hỏi!")))));

        const parsedHtml = (window.marked && window.marked.parse) ? window.marked.parse(rawAnswer) : rawAnswer;

        contentBox.innerHTML = `
          ${bannerHtml}
          <div class="ioe-md-content">
            ${parsedHtml}
          </div>
        `;

        if (lastAnswerParsed) {
          navigator.clipboard.writeText(lastAnswerParsed);
        }

        if (cb) cb(true, lastAnswerParsed, resp.hasAudio, isMatching, isTrueFalse, isMcq, isMultiTf); else releaseLock();
      } else {
        contentBox.innerHTML = `
          <div style="color: #b91c1c; background: #fef2f2; padding: 12px; border-radius: 8px; line-height: 1.5;">
            <strong>⚠️ Lỗi:</strong> ${escapeHtml(resp.error)}
          </div>
        `;
        if (cb) cb(false, null, false, false, false, false, false); else releaseLock();
      }
    });
  }

  window.clickMatchingPairDirectly = function (cellA, cellB) {
    clickMatchingCell(cellA);
    setTimeout(() => clickMatchingCell(cellB), 350);
    showToast(`🧩 Đã bấm cặp: Ô ${cellA} ↔ Ô ${cellB}!`);
  };

  function showToast(msg) {
    const toast = document.createElement("div");
    toast.style.cssText = "position: fixed; bottom: 24px; right: 24px; background: #0f172a; color: #fff; padding: 10px 18px; border-radius: 8px; z-index: 2147483647; font-size: 13.5px; font-weight: 600; box-shadow: 0 6px 16px rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.15); pointer-events: none; animation: ioe-fade-down 0.2s;";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Keyboard Shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "F2" || (e.ctrlKey && e.code === "Space")) {
      e.preventDefault();
      if (window.__IOE_SOLVE_AND_AUTOCLICK__) window.__IOE_SOLVE_AND_AUTOCLICK__("");
      else executeScreenAndAudioSolve();
    }
    if (e.key === "F4") {
      e.preventDefault();
      toggleAutoPilot();
    }
    if (e.key === "Escape" && isAutoRunning) {
      stopAutoPilot();
    }
  });

  function initIOE() {
    createIOEUI();
    setTimeout(createIOEUI, 500);
    setTimeout(createIOEUI, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initIOE);
  } else {
    initIOE();
  }

})();

