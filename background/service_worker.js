/**
 * English Master AI - Background Service Worker v3.8
 * Universal Game Type Classifier: True/False Listening • Matching Pairs • MCQ • Fill Blanks
 */

const DEFAULT_CONFIG = {
  // BUG#16: KHÔNG ship placeholder "YOUR_API_KEY_HERE" — chuỗi không rỗng nên
  // vượt qua check rỗng, được gửi thẳng lên Google → 400 "API key not valid".
  // Default rỗng → check ở callGeminiWithFallback bắn hướng dẫn nhập key ngay.
  geminiApiKey: "",
  // BUG#18: "gemini-2.5-flash" đã bị Google khai tử (404 "no longer available
  // to new users") → mọi request fail ngay cả key hợp lệ. Chuỗi model mới được
  // xác minh trực tiếp trên Generative Language API (16/09/2026):
  //   SỐNG: gemini-3.6-flash (mặc định — Google recommend, ổn định nhất),
  //         gemini-3.7-flash (mới nhất, thỉnh thoảng 503 high-demand),
  //         gemini-3.5-flash, gemini-flash-latest, gemini-flash-lite-latest
  //   CHẾT: gemini-2.5-flash, gemini-2.0-flash, gemini-2.5-flash-lite,
  //         gemini-2.5-pro, gemini-3-pro-preview
  model: "gemini-3.6-flash",
  autoShowToolbar: true,
  targetLanguage: "vi"
};

// Real, publicly available Gemini model IDs (aliases first — they track the
// current generation without breaking when versions rotate).
// BUG#18: toàn bộ chuỗi 2.x đã bị retire — thay bằng chuỗi 3.x đã verify.
// Thứ tự: 3.6 ổn định nhất lên đầu; 3.7 & flash-latest hay dính 503 high-demand
// nhưng vẫn là dự phòng tốt (fallback chỉ mất ~1s mỗi lần chuyển).
const FALLBACK_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// BUG#31: các tab đã attach debugger cho trusted click (giữ nguyên suốt phiên)
const TRUSTED_CLICK_ATTACHED = new Set();

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

6. DẠNG 6: BÀI NGHE ĐIỀN TỪ (Listen & fill in the blank — câu bị che dấu *** )
- Mỗi câu có 1 file audio [AUDIO CÂU N] và 1 câu tiếng Anh có TỪ BỊ CHE bằng dấu * (số dấu * = số chữ cái bị che, có thể có tiền tố như "sup*****" = sup + 5 chữ cái).
- Nghe TỪNG file audio, xác định chính xác TỪ BỊ CHE và viết lại ĐÚNG DẠNG ngữ pháp (chia động từ, danh từ số nhiều, so sánh hơn...). Ví dụ "sup*****" → "supposed" (8 chữ cái, bắt đầu bằng "sup").
- Nếu đề có KHO TỪ GỢI Ý, ưu tiên từ khớp cả NGHĨA lẫn ĐỘ DÀI (số chữ cái); nếu không từ nào khớp thì dùng từ nghe được từ audio.
- TUYỆT ĐỐI KHÔNG BỎ SÓT câu nào: trả về ĐỦ theo đúng số câu trong đề.
- Dòng đầu tiên BẮT BUỘC:
[FILL_WORDS: 1. từ_câu_1, 2. từ_câu_2, ...] (mỗi câu ĐÚNG 1 từ, viết thường không dấu cách)

7. DẠNG 7: BÀI TRẮC NGHIỆM NHIỀU CÂU (đề liệt kê sẵn từng câu với các lựa chọn A/B/C/D)
- Với MỖI câu chọn đúng 1 lựa chọn.
- Dòng đầu tiên BẮT BUỘC:
[MCQ_ANSWERS: 1. B, 2. A, 3. D, ...] (liệt kê ĐỦ tất cả các câu theo đúng thứ tự)

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
      // BUG#18d: model 3.x mặc định "thinking" tiêu tốn budget output — 2048
      // có thể bị thinking ăn hết → text rỗng. Nâng 8192 cho đề dài/ảnh lớn.
      maxOutputTokens: 8192
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // BUG#20: fetch KHÔNG timeout — mạng chậm/proxy treo làm panel đứng vĩnh viễn
    // (user thấy "đang giải..." mãi không xong). 60s đủ cho đề dài + ảnh + audio;
    // hết giờ → throw → chuỗi fallback chuyển model kế tiếp (kết nối mới).
    signal: AbortSignal.timeout(60000)
  }).catch((e) => {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      const err = new Error("Hết giờ 60s chờ Gemini phản hồi (mạng chậm hoặc kết nối bị treo).");
      err.status = 0;
      throw err;
    }
    throw e;
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

async function callGeminiWithFallback(text, taskType, customApiKey, customModel, imageBase64 = null, audioObj = null, customHint = "", audioList = null, examKind = null) {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  let apiKey = customApiKey || config.geminiApiKey || DEFAULT_CONFIG.geminiApiKey;
  apiKey = String(apiKey || "").trim();
  const primaryModel = customModel || config.model || DEFAULT_CONFIG.model;

  // BUG#16: key rỗng hoặc placeholder ("YOUR_API_KEY_HERE" từ bản cũ) → hướng dẫn
  // nhập key NGAY, không gửi request nào lên Google cả.
  if (!apiKey || /^your[_-]?api[_-]?key/i.test(apiKey)) {
    throw new Error("Chưa có Gemini API Key. Bấm biểu tượng extension English Master AI → tab 'Cài đặt API Key' → dán API Key (lấy MIỄN PHÍ tại aistudio.google.com/app/apikey) → bấm Lưu & Kiểm tra.");
  }

  const systemPrompt = PROMPTS[taskType] || PROMPTS.ioe_auto;
  let fullPrompt = systemPrompt;

  if (customHint && customHint.trim()) {
    fullPrompt += `\n\n[GỢI Ý / RÀNG BUỘC CỦA NGƯỜI DÙNG]: ${customHint.trim()}`;
  }

  if (audioObj) {
    fullPrompt += "\n\n[CHÚ Ý: BÀI THI NGHE AUDIO. Hãy nghe file âm thanh đính kèm kết hợp hình ảnh màn hình!]";
  }

  // examKind-aware multi-audio instruction: a listening exam is NOT always
  // True/False — fill-word listening exams must return [FILL_WORDS], not
  // [TF_ANSWERS]. This was the root cause of the "Tái tạo san hô" misclassification.
  if (Array.isArray(audioList) && audioList.length > 0) {
    if (examKind === "fillword") {
      fullPrompt += `\n\n[CHÚ Ý: BÀI THI NGHE ĐIỀN TỪ GỒM ${audioList.length} CÂU. Có ${audioList.length} file audio đính kèm theo đúng thứ tự câu (AUDIO CÂU 1, AUDIO CÂU 2, ...). Hãy nghe TỪNG file, tìm TỪ BỊ CHE (dấu ***) trong câu khẳng định tương ứng và trả về ĐỦ ${audioList.length} kết quả theo định dạng [FILL_WORDS: 1. từ_1, 2. từ_2, ...] — mỗi câu ĐÚNG 1 từ!]`;
    } else {
      fullPrompt += `\n\n[CHÚ Ý: BÀI THI NGHE TRUE/FALSE GỒM ${audioList.length} CÂU. Có ${audioList.length} file audio đính kèm theo đúng thứ tự câu (AUDIO CÂU 1, AUDIO CÂU 2, ...). Hãy nghe TỪNG file, đối chiếu với câu khẳng định của câu tương ứng và trả về ĐỦ ${audioList.length} kết quả theo định dạng [TF_ANSWERS: 1. True, 2. False, ...]!]`;
    }
  }

  if (examKind === "mcq_multi") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI TRẮC NGHIỆM NHIỀU CÂU. Hãy giải TỪNG câu trong đề và trả về dòng đầu tiên theo định dạng [MCQ_ANSWERS: 1. B, 2. A, ...] với ĐỦ mọi câu!]";
  }

  // Dạng mới (live 17/09/2026, chim-hai-tao — Vòng 1): đọc hiểu True/False
  if (examKind === "reading_tf") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI ĐỌC HIỂU TRUE/FALSE. Đối chiếu TỪNG câu khẳng định với ĐOẠN VĂN đã cung cấp: đúng theo đoạn văn → True, trái hoặc bịa thêm → False. Trả về dòng đầu tiên theo định dạng [TF_ANSWERS: 1. True, 2. False, ...] với ĐỦ mọi câu theo đúng thứ tự!]";
  }

  // Dạng mới (live 17/09/2026, bach-tuoc-thu-ngoc — Vòng 1): sắp xếp từ
  if (examKind === "word_order") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI SẮP XẾP TỪ (word ordering). Sắp xếp các mảnh từ của TỪNG câu thành câu tiếng Anh đúng ngữ pháp, đúng nghĩa. Dùng CHÍNH XÁC từng mảnh từ như đề bài (giữ nguyên chính tả và dấu câu, KHÔNG sửa, KHÔNG thêm từ mới). Trả về dòng đầu tiên theo định dạng [WORD_ORDER: 1. mảnh | mảnh | mảnh, 2. mảnh | mảnh | mảnh, ...] với ĐỦ mọi câu, các mảnh của mỗi câu phân cách bằng dấu | !]";
  }

  // Dạng mới Vòng 6 (16/09/2026): biến đổi câu gõ từ + điền từ đoạn văn
  if (examKind === "transform") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI BIẾN ĐỔI CÂU (sentence transformation). Với MỖI câu, điền các từ còn thiếu vào ô trống [B1], [B2]... của câu thứ hai để nghĩa bằng câu thứ nhất, DÙNG ĐÚNG từ trong kho từ cho trước (mỗi từ đúng 1 lần, có thể có từ gây nhiễu). Trả về dòng đầu tiên theo định dạng [TRANSFORM_WORDS: 1. must | be | careful, 2. to | going, ...] — số thứ tự câu, các từ của câu đó phân cách bằng dấu | !]";
  }
  if (examKind === "cloze") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI ĐIỀN TỪ VÀO ĐOẠN VĂN. Điền MỖI từ trong kho từ vào đúng một ô trống (1)____, (2)____... của đoạn văn sao cho đúng ngữ pháp và nghĩa. Trả về dòng đầu tiên theo định dạng [CLOZE_WORDS: 1. every, 2. called, ...] — đúng thứ tự ô trống!]";
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
      // BUG#16: Google từ chối key (400/401/403 "API key not valid..." / "API_KEY_INVALID")
      // → DỪNG NGAY chuỗi fallback: cùng 1 key, 7 model cũng fail y hệt (mất 10-20s
      // vô ích) và lỗi bị gán nhãn sai thành "model quá tải". Bản cũ chỉ khớp chuỗi
      // "API_KEY_INVALID" mà thông điệp thật của Google là "API key not valid.
      // Please pass a valid API key." → không bao giờ khớp.
      const emsg = String(err && err.message || "");
      // BUG#21 (v3.4): Google SUSPEND cả project đứng sau key — 2 signature THẬT
      // bắt được 17/09/2026:
      // (a) 403 PERMISSION_DENIED "Consumer 'api_key:AQ.xxx' has been suspended."
      //     (reason CONSUMER_SUSPENDED) — key ĐÚNG format nhưng project bị đình chỉ.
      // (b) 401 UNAUTHENTICATED "The bound service account is deleted or disabled.
      //     The service account bound to the API key must be active."
      //     (reason ACCOUNT_STATE_INVALID) — service account của project bị xóa/tắt.
      // Cả 2 KHÔNG phải do user gõ sai key: mọi key sinh từ cùng project đều chết
      // (kể cả key vừa tạo mới). Signature (a) chứa "api_key:" nên nếu để SAU sẽ
      // rơi vào nhánh generic "API Key KHÔNG HỢP LỆ" ở dưới → user không biết đường
      // xử lý đúng là tạo key ở PROJECT MỚI.
      if ((err.status === 401 || err.status === 403) &&
          /has been suspended|CONSUMER_SUSPENDED|service account is deleted or disabled|ACCOUNT_STATE_INVALID/i.test(emsg)) {
        throw new Error("Google đã ĐÌNH CHỈ (suspend) toàn bộ Google Cloud project của API Key này. Key bạn nhập vẫn ĐÚNG nhưng không dùng được — mọi key tạo thêm từ project cũ này cũng bị chặn y hệt. Cách xử lý: mở aistudio.google.com/app/apikey → bấm 'Create API key' → chọn 'Create API key in NEW project' (nhất thiết PROJECT MỚI) → copy key mới → dán vào extension → bấm Lưu & Kiểm tra. Xem email Google Cloud để biết lý do suspend và kháng nghị tại console.cloud.google.com nếu cần. Chi tiết Google: " + emsg);
      }
      // BUG#16: Google từ chối key (400/401/403 "API key not valid..." / "API_KEY_INVALID")
      // → DỪNG NGAY chuỗi fallback: cùng 1 key, mọi model cũng fail y hệt (mất 10-20s
      // vô ích) và lỗi bị gán nhãn sai thành "model quá tải". Bản cũ chỉ khớp chuỗi
      // "API_KEY_INVALID" mà thông điệp thật của Google là "API key not valid.
      // Please pass a valid API key." → không bao giờ khớp.
      if ((err.status === 400 || err.status === 401 || err.status === 403) &&
          (/api[\s_-]?key/i.test(emsg) || /API_KEY_INVALID/i.test(emsg))) {
        throw new Error("API Key KHÔNG HỢP LỆ (Google từ chối: " + emsg + "). Mở popup extension → tab 'Cài đặt API Key' → kiểm tra key. Lấy key miễn phí tại aistudio.google.com/app/apikey rồi bấm 'Lưu & Kiểm tra'.");
      }
      // BUG#18b: geo-block — Google chặn API theo vùng IP (400 FAILED_PRECONDITION
      // "User location is not supported for the API use"). Cùng 1 IP nên mọi model
      // đều fail y hệt → dừng chuỗi ngay, không thử 6 model vô ích.
      if (err.status === 400 && /location is not supported|unsupported location|user location/i.test(emsg)) {
        throw new Error("Google đang chặn khu vực mạng/IP của bạn (không hỗ trợ Gemini API tại vùng đó — ví dụ Hong Kong/Trung Quốc). Hãy đổi mạng (VPN qua Mỹ/Nhật/Singapore) rồi thử lại. Key của bạn vẫn HỢP LỆ. Chi tiết Google: " + emsg);
      }
      // BUG#18c: model bị khai tử (404 "no longer available to new users" /
      // "not found for API version") — không phải lỗi key, chỉ cần model kế tiếp.
      if (err.status === 404 && /no longer available|not found for API version/i.test(emsg)) {
        console.warn(`[English Master AI] Model ${model} đã bị Google retire — chuyển model kế tiếp.`);
      }
      if (err.status === 403 && /has not been used|is disabled|Generative Language/i.test(emsg)) {
        throw new Error("API Key hợp lệ nhưng chưa bật 'Generative Language API' trong Google Cloud project. Mở console.cloud.google.com → APIs & Services → Library → tìm 'Generative Language API' → Enable.");
      }
      // Rate-limit (429) or server-side (5xx) errors are usually transient — pause
      // briefly so the next fallback model isn't hit instantly while the quota is
      // still exhausted / the outage is ongoing.
      if (err.status === 429 || (err.status >= 500 && err.status < 600)) {
        await sleep(500);
      }
    }
  }

  // BUG#16: thông điệp cuối trung thực theo loại lỗi thật — chỉ 429 mới là "quá tải"
  const lastMsg = String(lastError?.message || "Vui lòng thử lại sau giây lát.");
  if (lastError && lastError.status === 429) {
    throw new Error("Hết quota / quá tải toàn bộ " + modelQueue.length + " model AI (429). Chờ 1-2 phút rồi bấm giải lại. Chi tiết: " + lastMsg);
  }
  throw new Error(`Không gọi được AI (đã thử ${modelQueue.length} model): ${lastMsg}`);
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
  // BUG#31 (live 17/09/2026, ghep-cap/an-khe-tra-vang — engine Cocos 2.0.0
  // alpha): game CHỈ nhận TRUSTED input — synthetic DOM events bị bỏ qua hoàn
  // toàn (live-verified: chuột thật qua CDP = ăn điểm, synthetic = 0 event).
  // Click qua chrome.debugger Input.dispatchMouseEvent = trusted browser-level.
  if (request.action === "TRUSTED_CLICK") {
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) { sendResponse({ ok: false, error: "no_tab" }); return; }
    const x = Math.round(Number(request.x) || 0), y = Math.round(Number(request.y) || 0);
    (async () => {
      try {
        const target = { tabId };
        // Attach MỘT LẦN mỗi tab (giữ nguyên — tránh infobar debugger nhấp nháy
        // mỗi click). Tab đóng → Chrome tự detach.
        if (!TRUSTED_CLICK_ATTACHED.has(tabId)) {
          try { await chrome.debugger.attach(target, "1.3"); TRUSTED_CLICK_ATTACHED.add(tabId); } catch (e) {
            // "Already attached to target" → vẫn dùng được
            if (/already attached/i.test(String(e && e.message || e))) TRUSTED_CLICK_ATTACHED.add(tabId);
            else { sendResponse({ ok: false, error: String(e && e.message || e) }); return; }
          }
        }
        for (const type of ["mousePressed", "mouseReleased"]) {
          await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
            type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1
          });
        }
        sendResponse({ ok: true, x, y });
      } catch (err) {
        TRUSTED_CLICK_ATTACHED.delete(tabId);
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true;
  }

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

        const result = await callGeminiWithFallback(request.text || "", "ioe_auto", request.apiKey, request.model, imagePayload, audioObj, request.hint, audioList, request.examKind);
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
