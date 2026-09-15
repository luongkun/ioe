/**
 * English Master AI - Background Service Worker v2.11.0
 * Universal Game Type Classifier: True/False Listening • Matching Pairs • MCQ • Fill Blanks
 */

const DEFAULT_CONFIG = {
  geminiApiKey: "YOUR_API_KEY_HERE",
  model: "gemini-3.7-flash",
  autoShowToolbar: true,
  targetLanguage: "vi"
};

const FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-pro-latest"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPTS = {
  ioe_auto: `Bạn là trợ lý giải đề thi Olympic Tiếng Anh IOE (ioe.vn) siêu tốc và chính xác 100%.
Nhiệm vụ của bạn là nhận diện chính xác LOẠI BÀI THI trong hình ảnh và đưa ra ĐÁP ÁN ĐÚNG THEO ĐỊNH DẠNG TƯƠNG ỨNG.

CÁC DẠNG BÀI THI IOE VÀ QUY TẮC ĐỊNH DẠNG DÒNG ĐẦU TIÊN:

1. DẠNG 1: BÀI NGHE CHỌN TRUE / FALSE (Ví dụ: Game Dọn rác bãi biển)
- Hãy đọc CHÍNH XÁC câu khẳng định tiếng Anh hiển thị trong khung đồ họa của game (nằm cạnh vòng tròn số thứ tự câu 1/10, 5/10... và nút Play/Replay). BỎ QUA bất kỳ bảng nổi (popup) nào.
- QUAN TRỌNG: Nghe kỹ file âm thanh (Audio) đính kèm, chép Transcript và đối chiếu với câu khẳng định trên màn hình:
  + Nếu bài nghe khớp / đúng với câu khẳng định: Dòng đầu BẮT BUỘC là: [ANSWER: True]
  + Nếu bài nghe mâu thuẫn / sai so với câu khẳng định: Dòng đầu BẮT BUỘC là: [ANSWER: False]
- Phía dưới ghi rõ câu khẳng định bạn đã đọc được từ khung game, Transcript bài nghe và giải thích vì sao chọn True hay False.

2. DẠNG 2: BÀI GHÉP CẶP (Matching Pairs - 12 ô thẻ bài)
- Dòng đầu tiên BẮT BUỘC:
[MATCH_PAIRS: <ô_A>-<ô_B>, <ô_C>-<ô_D>, ...]
(Ví dụ: [MATCH_PAIRS: 1-4, 2-9, 3-6, 5-12, 7-8, 10-11])

3. DẠNG 3: BÀI TRẮC NGHIỆM CHỌN 1 TRONG 4 ĐÁP ÁN (MCQ A, B, C, D - Tái tạo san hô, Fansipan, Leo núi)
- Dù là câu hỏi trắc nghiệm bình thường hay câu chọn 1 đáp án A/B/C/D để điền vào chỗ trống trong câu:
- Dòng đầu tiên BẮT BUỘC BẮT ĐẦU BẰNG CHỮ CÁI ĐÁP ÁN:
[ANSWER: A] hoặc [ANSWER: A. word] hoặc [ANSWER: D. comes]
- TUYỆT ĐỐI KHÔNG coi bài trắc nghiệm là bài điền nhiều ô.

4. DẠNG 4: BÀI ĐIỀN TỪ / VIẾT LẠI CÂU BẰNG BÀN PHÍM (Hành tinh tím / Missing letters / Không có 4 nút A B C D)
- Dòng đầu tiên BẮT BUỘC:
[ANSWER: <từ_ô_1 từ_ô_2 ...>] (Ví dụ: [ANSWER: had such])

5. DẠNG 5: BÀI NGHE TRUE/FALSE NHIỀU CÂU (nhiều file audio đính kèm, đánh số theo thứ tự câu)
- Mỗi file audio đính kèm tương ứng 1 câu theo đúng nhãn [AUDIO CÂU 1], [AUDIO CÂU 2], ... Đề bài liệt kê câu khẳng định của từng câu.
- Nghe TỪNG file, đối chiếu với câu khẳng định tương ứng của câu đó, chọn True/False cho từng câu.
- TUYỆT ĐỐI KHÔNG BỎ SÓT: đếm tổng số câu trong đề (ví dụ 10) thì phải trả về ĐỦ 10 kết quả. Nếu một câu không có file audio hoặc nghe không rõ, VẪN PHẢI đoán True/False dựa trên câu khẳng định (câu khẳng định thường đúng → True), KHÔNG ĐƯỢC bỏ câu đó.
- Dòng đầu tiên BẮT BUỘC:
[TF_ANSWERS: 1. True, 2. False, 3. True, ...] (liệt kê ĐỦ TẤT CẢ các câu theo đúng thứ tự, không bỏ sót câu nào, số câu phải bằng đúng tổng số câu trong đề)

Trình bày ngắn gọn, súc tích, dịch nghĩa và giải thích rõ ràng.`,

  mcq: `Bạn là chuyên gia khảo thí và giáo viên Tiếng Anh. Giải bài trắc nghiệm chính xác 100%.`,
  fill_blank: `Bạn là giáo viên Tiếng Anh chuyên sâu. Giải bài tập điền từ vào chỗ trống.`,
  grammar_check: `Bạn là chuyên gia ngữ pháp và biên tập viên Tiếng Anh.`,
  translate_analyze: `Bạn là chuyên gia ngôn ngữ học Tiếng Anh.`
};

async function fetchAudioAsBase64(audioUrl) {
  if (!audioUrl) return null;
  try {
    const res = await fetch(audioUrl);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    // Convert in 32KB chunks — building the binary string one byte at a time is
    // extremely slow (and can hit the JS string-length limit) for large audio files.
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const base64 = btoa(binary);
    const mimeType = audioUrl.endsWith(".wav") ? "audio/wav" : (audioUrl.endsWith(".ogg") ? "audio/ogg" : "audio/mp3");
    return { base64, mimeType };
  } catch (err) {
    console.warn("Failed to fetch audio file:", err);
    return null;
  }
}

async function callSingleModel(modelName, apiKey, promptText, imageBase64 = null, audioObj = null, audioList = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

  const parts = [{ text: promptText }];

  if (imageBase64) {
    if (Array.isArray(imageBase64)) {
      imageBase64.forEach((img, idx) => {
        if (img) {
          const cleanBase64 = img.replace(/^data:image\/[a-z]+;base64,/, "");
          parts.push({
            text: `[HÌNH ẢNH PHẦN ${idx + 1}${idx === 0 ? ' (Màn hình phía trên)' : ' (Màn hình đã cuộn xuống dưới)'}]:`
          });
          parts.push({
            inline_data: {
              mime_type: "image/png",
              data: cleanBase64
            }
          });
        }
      });
    } else {
      const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");
      parts.push({
        inline_data: {
          mime_type: "image/png",
          data: cleanBase64
        }
      });
    }
  }

  if (audioObj && audioObj.base64) {
    parts.push({
      inline_data: {
        mime_type: audioObj.mimeType || "audio/mp3",
        data: audioObj.base64
      }
    });
  }

  // Multiple audio files (True/False listening exam with N questions).
  // Each entry is labeled so the AI knows exactly which question it belongs to.
  if (Array.isArray(audioList) && audioList.length > 0) {
    audioList.forEach((a, idx) => {
      if (a && a.base64) {
        parts.push({ text: `[AUDIO CÂU ${a.qIndex || (idx + 1)}]:` });
        parts.push({
          inline_data: {
            mime_type: a.mimeType || "audio/mp3",
            data: a.base64
          }
        });
      }
    });
  }

  const payload = {
    contents: [{ role: "user", parts: parts }],
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      maxOutputTokens: 2048
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const resJson = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = resJson.error?.message || `HTTP ${response.status}`;
    const err = new Error(errorMsg);
    err.status = response.status;
    throw err;
  }

  const candidate = resJson.candidates?.[0];
  if (!candidate || !candidate.content?.parts?.[0]?.text) {
    throw new Error("AI không trả về kết quả hợp lệ.");
  }

  return candidate.content.parts[0].text;
}

async function callGeminiWithFallback(text, taskType, customApiKey, customModel, imageBase64 = null, audioObj = null, customHint = "", audioList = null) {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  const apiKey = customApiKey || config.geminiApiKey || DEFAULT_CONFIG.geminiApiKey;
  const primaryModel = customModel || config.model || DEFAULT_CONFIG.model;

  if (!apiKey || !apiKey.trim()) {
    throw new Error("Chưa cấu hình Gemini API Key. Hãy mở popup extension để nhập API Key miễn phí từ Google AI Studio.");
  }

  const systemPrompt = PROMPTS[taskType] || PROMPTS.ioe_auto;
  let fullPrompt = systemPrompt;

  if (customHint && customHint.trim()) {
    fullPrompt += `\n\n[GỢI Ý / RÀNG BUỘC CỦA NGƯỜI DÙNG]: ${customHint.trim()}`;
  }

  if (audioObj) {
    fullPrompt += "\n\n[CHÚ Ý: BÀI THI NGHE AUDIO. Hãy nghe file âm thanh đính kèm kết hợp hình ảnh màn hình!]";
  }

  if (Array.isArray(audioList) && audioList.length > 0) {
    fullPrompt += `\n\n[CHÚ Ý: BÀI THI NGHE TRUE/FALSE GỒM ${audioList.length} CÂU. Có ${audioList.length} file audio đính kèm theo đúng thứ tự câu (AUDIO CÂU 1, AUDIO CÂU 2, ...). Hãy nghe TỪNG file, đối chiếu với câu khẳng định của câu tương ứng và trả về ĐỦ ${audioList.length} kết quả theo định dạng [TF_ANSWERS: 1. True, 2. False, ...]!]`;
  }

  if (text) {
    fullPrompt += "\n\n--- ĐỀ BÀI CẦN GIẢI ---\n" + text;
  } else {
    fullPrompt += "\n\nHãy quan sát thật kỹ hình ảnh chụp màn hình bài thi, tự động nhận diện dạng bài (True/False Nghe / Ghép cặp / Trắc nghiệm / Điền từ) và giải chính xác 100%.";
  }

  const modelQueue = [primaryModel, ...FALLBACK_MODELS.filter(m => m !== primaryModel)];

  let lastError = null;
  for (const model of modelQueue) {
    try {
      console.log(`[English Master AI] Trying model: ${model}...`);
      const answer = await callSingleModel(model, apiKey, fullPrompt, imageBase64, audioObj, audioList);
      console.log(`[English Master AI] Success with model: ${model}`);

      try {
        const historyData = await chrome.storage.local.get({ history: [] });
        const newHistory = [
          {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            taskType: audioObj ? "ioe_listening" : taskType,
            question: (audioObj ? "[🎧 Bài thi nghe Audio + Hình ảnh]" : (text || "[Ảnh chụp màn hình Game IOE]")).trim(),
            answer: answer
          },
          ...historyData.history.slice(0, 99)
        ];
        await chrome.storage.local.set({ history: newHistory });
      } catch (e) {}

      return answer;
    } catch (err) {
      console.warn(`[English Master AI] Model ${model} failed (${err.message}). Trying fallback...`);
      lastError = err;
      if (err.status === 400 && err.message.includes("API_KEY_INVALID")) {
        throw new Error("API Key không hợp lệ. Vui lòng kiểm tra lại trong Popup Extension.");
      }
      // Rate-limit (429) or server-side (5xx) errors are usually transient — pause
      // briefly so the next fallback model isn't hit instantly while the quota is
      // still exhausted / the outage is ongoing.
      if (err.status === 429 || (err.status >= 500 && err.status < 600)) {
        await sleep(500);
      }
    }
  }

  throw new Error(`Tất cả các model AI đang quá tải: ${lastError?.message || "Vui lòng thử lại sau giây lát."}`);
}

// Chrome throttles captureVisibleTab to 2 calls/second. The auto-scroll solver
// takes a "top" and a "bottom" screenshot back-to-back, so the 2nd call can fail
// silently. Retry with a short delay instead of losing the frame.
function captureVisibleTabWithRetry(windowId, format = "png", retries = 2) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      chrome.tabs.captureVisibleTab(windowId, { format }, (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          if (left > 0) setTimeout(() => attempt(left - 1), 650);
          else reject(new Error(chrome.runtime.lastError?.message || "Lỗi chụp ảnh"));
        } else {
          resolve(dataUrl);
        }
      });
    };
    attempt(retries);
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "CAPTURE_TAB_ONLY") {
    const windowId = sender.tab ? sender.tab.windowId : null;
    captureVisibleTabWithRetry(windowId)
      .then((dataUrl) => sendResponse({ success: true, dataUrl }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "SOLVE_CURRENT_SCREEN") {
    const windowId = sender.tab ? sender.tab.windowId : null;

    async function handleSolveWithImages(imagePayload) {
      try {
        let audioObj = null;
        let audioList = null;

        if (request.audioBase64) {
          const match = request.audioBase64.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            audioObj = { mimeType: match[1], base64: match[2] };
          } else {
            audioObj = { mimeType: "audio/mp3", base64: request.audioBase64 };
          }
        } else if (request.audioUrl) {
          audioObj = await fetchAudioAsBase64(request.audioUrl);
        }

        // Multiple audios: True/False listening exam with N questions (one audio per question).
        // CRITICAL: preserve each audio's ORIGINAL question index even when a fetch
        // fails — filtering failed entries out would renumber the survivors onto the
        // wrong questions and the AI would answer only N-2 (and misaligned!) questions.
        if (Array.isArray(request.audioUrls) && request.audioUrls.length > 0) {
          const items = request.audioUrls.map((u, i) => {
            if (typeof u === "string") return { url: u, qIndex: i + 1 };
            return { url: u && u.url, qIndex: (u && u.qIndex) || (i + 1) };
          });
          const results = await Promise.all(items.map(it => fetchAudioAsBase64(it.url)));
          audioList = results.map((a, i) => {
            if (a) return { mimeType: a.mimeType, base64: a.base64, qIndex: items[i].qIndex };
            return { missing: true, qIndex: items[i].qIndex };
          });
        }

        const result = await callGeminiWithFallback(request.text || "", "ioe_auto", request.apiKey, request.model, imagePayload, audioObj, request.hint, audioList);
        sendResponse({ success: true, data: result, hasAudio: !!(audioObj || (audioList && audioList.length)) });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }

    if (request.images && Array.isArray(request.images) && request.images.length > 0) {
      handleSolveWithImages(request.images);
      return true;
    }

    captureVisibleTabWithRetry(windowId)
      .then((dataUrl) => handleSolveWithImages(dataUrl))
      .catch((err) => sendResponse({ success: false, error: "Không thể chụp màn hình tab: " + err.message }));
    return true;
  }

  if (request.action === "SOLVE_QUESTION") {
    callGeminiWithFallback(request.text, request.taskType, request.apiKey, request.model, request.image, null, request.hint)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === "TEST_API_KEY") {
    callGeminiWithFallback("Hello, test connection.", "translate_analyze", request.apiKey, request.model)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// ===== Context menu: right-click any selected text → solve it =====
// The content script already listens for TRIGGER_SOLVE_FROM_CONTEXT_MENU, but
// nothing ever sent it. Register the menus here to make that feature work.
const CONTEXT_MENU_ITEMS = [
  { id: "ema-mcq", title: "🎯 Giải trắc nghiệm", taskType: "mcq" },
  { id: "ema-fill", title: "✏️ Điền từ vào chỗ trống", taskType: "fill_blank" },
  { id: "ema-grammar", title: "🛠️ Sửa lỗi ngữ pháp", taskType: "grammar_check" },
  { id: "ema-translate", title: "📖 Dịch & Phân tích", taskType: "translate_analyze" }
];

function registerContextMenus() {
  if (!chrome.contextMenus || !chrome.contextMenus.create) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ema-root",
      title: "English Master AI",
      contexts: ["selection"]
    });
    CONTEXT_MENU_ITEMS.forEach((item) => {
      chrome.contextMenus.create({
        id: item.id,
        parentId: "ema-root",
        title: item.title,
        contexts: ["selection"]
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  const item = CONTEXT_MENU_ITEMS.find((i) => i.id === info.menuItemId);
  if (!item) return;
  const text = (info.selectionText || "").trim();
  if (!text) return;
  // Ignore "Receiving end does not exist" when the tab has no content script.
  chrome.tabs.sendMessage(
    tab.id,
    { action: "TRIGGER_SOLVE_FROM_CONTEXT_MENU", text, taskType: item.taskType },
    () => void chrome.runtime.lastError
  );
});
