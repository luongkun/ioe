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
  targetLanguage: "vi",
  // BUG#46 (22/09/2026): Gemini free tier chỉ 20 request/PHÚT (đo thực tế:
  // `generate_content_free_tier_requests, limit: 20`), mà mỗi bài thi solver gọi
  // AI 5-10 lần + retry → cạn quota liên tục giữa bài. Gói Google AI Pro KHÔNG
  // nâng hạn mức API (hạn mức tính theo PROJECT, muốn lên phải bật billing).
  // Groq free tier: 30 RPM + 1000 request/NGÀY, không cần thẻ tín dụng.
  //   - `openai/gpt-oss-120b`  → suy luận (text-only, không có vision)
  //   - `whisper-large-v3-turbo` → nghe audio (20 RPM, 2000 request/ngày)
  // Vì Groq không có vision, đường có ẢNH vẫn phải dùng Gemini; đường chỉ có
  // CHỮ/AUDIO thì Groq chạy trước, Gemini là dự phòng.
  groqApiKey: "",
  groqModel: "openai/gpt-oss-120b",
  groqWhisperModel: "whisper-large-v3-turbo",
  // BUG#48 (22/09/2026): Cloudflare Workers AI làm provider thứ BA. Đây là vendor
  // KHÁC hẳn Groq và Google nên hạn mức độc lập — Groq cạn thì vẫn còn đường.
  // Free: 10.000 Neurons/ngày, KHÔNG cần thẻ tín dụng.
  //   - chat:  OpenAI-compatible THẬT → /ai/v1/chat/completions
  //   - audio: KHÔNG nằm trong bộ OpenAI-compatible → phải gọi REST run endpoint
  //            /ai/run/<model>, body là BYTES thô, trả về {result:{text}}.
  // Account ID: dash.cloudflare.com → Workers & Pages → cột phải (hex 32 ký tự).
  cfApiKey: "",
  cfAccountId: "",
  cfModel: "@cf/openai/gpt-oss-120b",
  cfWhisperModel: "@cf/openai/whisper-large-v3-turbo",
  // Provider chạy TRƯỚC: "groq" | "cloudflare" | "gemini". Sau nó là chuỗi mặc
  // định groq → cloudflare → gemini (provider thiếu key bị loại khỏi chuỗi).
  preferProvider: "groq"
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

// BUG#49 (22/09/2026): 429 của Google có HAI loại rất khác nhau, bản cũ gộp làm
// một nên vừa đốt quota vừa báo sai cho người dùng.
//
//   (a) QUOTA THEO PROJECT — thông điệp chứa metric dạng
//       `generate_content_free_tier_requests`. Hạn mức này tính theo PROJECT và
//       MỌI model dùng CHUNG một rổ, nên chuyển model KHÔNG cứu được gì — mà mỗi
//       lần thử còn ăn thêm 1 request vào đúng cái rổ đang cạn. Đo thực tế 22/09/2026
//       (Vòng 7 Bài 4): retry-after của Google tăng dần 14.7s → 45.5s → 41.7s → 38.0s
//       chính vì các lần thử trước đang tiêu hạn mức. Gặp loại này phải DỪNG NGAY.
//   (b) 429 theo RIÊNG model (RPM/TPM của model đó) — chuyển model là ĐÚNG.
function isProjectQuotaError(err) {
  if (!err || err.status !== 429) return false;
  const msg = String(err.message || "");
  return /quota exceeded for metric/i.test(msg) && /free[\s_-]?tier/i.test(msg);
}

// Google trả kèm thời gian chờ trong CHÍNH thông điệp lỗi, ví dụ
// "... Please retry in 14.751975244s." — dùng số thật của server thay vì đoán
// "chờ 1-2 phút" như bản cũ.
function parseRetryAfterSeconds(err) {
  const msg = String((err && err.message) || "");
  const m = msg.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i)
         || msg.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!m) return null;
  const n = Math.ceil(parseFloat(m[1]));
  return Number.isFinite(n) && n > 0 ? n : null;
}

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

// ===== BUG#46: Groq provider =====
// Groq dùng API kiểu OpenAI (/openai/v1/chat/completions) — KHÁC Gemini ở 3 điểm
// quan trọng khi chuyển đổi:
//   1. System prompt là một message riêng (role:"system"), không nhồi vào user.
//   2. Ảnh đi dạng content part {type:"image_url", image_url:{url:"data:..."}},
//      và model chữ của Groq KHÔNG nhận ảnh (xem groqSupportsImages).
//   3. AUDIO KHÔNG đi kèm chat completion — Groq tách riêng endpoint
//      /openai/v1/audio/transcriptions (Whisper). Vì vậy audio được phiên âm
//      TRƯỚC, rồi bản transcript được nhồi vào prompt chữ.
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

// Groq chat models trong danh sách free đều là TEXT-ONLY. Nếu sau này thêm model
// có vision thì khai báo ở đây; mặc định false để không gửi ảnh vào model chữ
// (Groq trả 400 "content must be a string").
function groqSupportsImages(model) {
  return /vision|llava|llama-4-(scout|maverick)/i.test(String(model || ""));
}

async function groqTranscribe(apiKey, audioObj, whisperModel) {
  if (!audioObj || !audioObj.base64) return null;
  try {
    const bin = atob(audioObj.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = /wav/i.test(audioObj.mimeType || "") ? "wav" : (/ogg/i.test(audioObj.mimeType || "") ? "ogg" : "mp3");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: audioObj.mimeType || "audio/mp3" }), "audio." + ext);
    form.append("model", whisperModel || DEFAULT_CONFIG.groqWhisperModel);
    form.append("response_format", "text");
    const res = await fetch(GROQ_WHISPER_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey.trim() },
      body: form,
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j.error?.message || ("Whisper HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    const txt = await res.text();
    return String(txt || "").trim() || null;
  } catch (e) {
    console.warn("[English Master AI] Groq Whisper lỗi:", e && e.message);
    return null;
  }
}

async function callGroqChat(apiKey, model, systemPrompt, userPrompt, imageBase64) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  if (imageBase64 && groqSupportsImages(model)) {
    const imgs = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
    const content = [{ type: "text", text: userPrompt }];
    for (const img of imgs) {
      if (!img) continue;
      const clean = img.replace(/^data:image\/[a-z]+;base64,/, "");
      content.push({ type: "image_url", image_url: { url: "data:image/png;base64," + clean } });
    }
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: userPrompt });
  }

  const res = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey.trim() },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 8192 }),
    signal: AbortSignal.timeout(60000)
  }).catch((e) => {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      const err = new Error("Hết giờ 60s chờ Groq phản hồi.");
      err.status = 0;
      throw err;
    }
    throw e;
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.error?.message || ("HTTP " + res.status));
    err.status = res.status;
    throw err;
  }
  const txt = j.choices?.[0]?.message?.content;
  if (!txt) throw new Error("Groq không trả về kết quả hợp lệ.");
  return txt;
}

// ===== BUG#48: Cloudflare Workers AI =====
// Hai điểm khác Groq phải nhớ khi sửa file này:
//   1. URL có thêm ACCOUNT ID trong đường dẫn (Groq không có).
//   2. Audio dùng REST run endpoint chứ không phải OpenAI-compatible.
const CF_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

function cfUrl(accountId, path) {
  const acc = String(accountId || "").trim();
  if (!acc) {
    throw new Error("Chưa có Cloudflare Account ID. Lấy tại dash.cloudflare.com → Workers & Pages → cột phải (chuỗi hex 32 ký tự) → dán vào trang Cài đặt của extension.");
  }
  return `${CF_API_BASE}/${encodeURIComponent(acc)}/ai${path}`;
}

// Phần lớn model Workers AI là TEXT-ONLY. Khai báo model có vision ở đây để
// không gửi content part dạng ảnh vào model chữ (Cloudflare trả lỗi 400).
function cfSupportsImages(model) {
  return /llama-4-(scout|maverick)|llava|llama-3\.2-11b|vision/i.test(String(model || ""));
}

async function cfTranscribe(apiKey, accountId, audioObj, whisperModel) {
  if (!audioObj || !audioObj.base64) return null;
  // cfUrl nằm NGOÀI try: thiếu Account ID là lỗi cấu hình của người dùng, phải
  // hiện nguyên văn hướng dẫn dẫn thay vì bị nuốt thành "không phiên âm được".
  const url = cfUrl(accountId, "/run/" + encodeURIComponent(whisperModel || DEFAULT_CONFIG.cfWhisperModel));
  try {
    const bin = atob(audioObj.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey.trim(),
        "Content-Type": audioObj.mimeType || "audio/mp3"
      },
      body: bytes,
      signal: AbortSignal.timeout(120000)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) {
      const msg = j.errors?.[0]?.message || j.error?.message || ("Cloudflare Whisper HTTP " + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    // Cloudflare trả {result:{text}}; một số biến thể trả thẳng {result:"..."}.
    const txt = typeof j.result === "string" ? j.result : (j.result && j.result.text) || "";
    return String(txt || "").trim() || null;
  } catch (e) {
    console.warn("[English Master AI] Cloudflare Whisper lỗi:", e && e.message);
    return null;
  }
}

async function callCfChat(apiKey, accountId, model, systemPrompt, userPrompt, imageBase64) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  if (imageBase64 && cfSupportsImages(model)) {
    const imgs = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
    const content = [{ type: "text", text: userPrompt }];
    for (const img of imgs) {
      if (!img) continue;
      const clean = img.replace(/^data:image\/[a-z]+;base64,/, "");
      content.push({ type: "image_url", image_url: { url: "data:image/png;base64," + clean } });
    }
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: userPrompt });
  }

  const res = await fetch(cfUrl(accountId, "/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey.trim() },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 8192 }),
    signal: AbortSignal.timeout(60000)
  }).catch((e) => {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      const err = new Error("Hết giờ 60s chờ Cloudflare phản hồi.");
      err.status = 0;
      throw err;
    }
    throw e;
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    const msg = j.errors?.[0]?.message || j.error?.message || ("HTTP " + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const txt = j.choices?.[0]?.message?.content;
  if (!txt) throw new Error("Cloudflare không trả về kết quả hợp lệ.");
  return txt;
}

// Dựng prompt dùng chung cho CẢ hai provider (tách khỏi callGeminiWithFallback để
// không phải viết lại toàn bộ khối chỉ thị examKind cho Groq).
function buildFullPrompt(text, taskType, customHint, audioObj, audioList, examKind, transcript) {
  const systemPrompt = PROMPTS[taskType] || PROMPTS.ioe_auto;
  let fullPrompt = systemPrompt;

  if (customHint && customHint.trim()) {
    fullPrompt += `\n\n[GỢI Ý / RÀNG BUỘC CỦA NGƯỜI DÙNG]: ${customHint.trim()}`;
  }
  if (audioObj) {
    fullPrompt += "\n\n[CHÚ Ý: BÀI THI NGHE AUDIO. Hãy nghe file âm thanh đính kèm kết hợp hình ảnh màn hình!]";
  }
  if (Array.isArray(audioList) && audioList.length > 0) {
    if (examKind === "fillword") {
      fullPrompt += `\n\n[CHÚ Ý: BÀI THI NGHE ĐIỀN TỪ GỒM ${audioList.length} CÂU. Có ${audioList.length} file audio đính kèm theo đúng thứ tự câu (AUDIO CÂU 1, AUDIO CÂU 2, ...). Hãy nghe TỪNG file, tìm TỪ BỊ CHE (dấu ***) trong câu khẳng định tương ứng và trả về ĐỦ ${audioList.length} kết quả theo định dạng [FILL_WORDS: 1. từ_1, 2. từ_2, ...] — mỗi câu ĐÚNG 1 từ!]`;
    } else if (examKind === "mcq_multi") {
      fullPrompt += `\n\n[CHÚ Ý: BÀI THI NGHE TRẮC NGHIỆM GỒM ${audioList.length} CÂU. Có ${audioList.length} file audio đính kèm theo đúng thứ tự câu (AUDIO CÂU 1, AUDIO CÂU 2, ...). Hãy nghe TỪNG file, đối chiếu với câu hỏi + các lựa chọn A/B/C/D của câu tương ứng rồi chọn 1 đáp án đúng. Trả về dòng đầu tiên ĐÚNG định dạng: [MCQ_ANSWERS: 1. B, 2. A, ...] với ĐỦ ${audioList.length} kết quả!]`;
    } else if (examKind === "listening_tf") {
      // BUG#47b (live 22/09/2026, chim-hai-tao — Vòng 7 Bài 4): đề NGHE TF dùng
      // MỘT file audio CHUNG cho cả bài (mọi câu hỏi cùng nghe một đoạn). Khối này
      // đếm theo SỐ FILE nên với 1 file nó dặn "GỒM 1 CÂU ... trả về ĐỦ 1 kết quả"
      // — mâu thuẫn trực tiếp với chỉ thị listening_tf bên dưới ("ĐỦ mọi câu"),
      // model trả 1 đáp án cho bài 5 câu. Số file ≠ số câu ở dạng đề này.
      if (audioList.length === 1) {
        fullPrompt += `\n\n[CHÚ Ý: BÀI THI NGHE TRUE/FALSE — MỘT FILE AUDIO DÙNG CHUNG CHO TOÀN BỘ CÁC CÂU. File đính kèm là bài nghe của CẢ BÀI (KHÔNG phải của riêng một câu). Hãy nghe hết file rồi đối chiếu TỪNG câu khẳng định trong đề với nội dung bài nghe.]`;
      } else {
        fullPrompt += `\n\n[CHÚ Ý: BÀI THI NGHE TRUE/FALSE GỒM ${audioList.length} CÂU. Có ${audioList.length} file audio đính kèm theo đúng thứ tự câu (AUDIO CÂU 1, AUDIO CÂU 2, ...). Hãy nghe TỪNG file, đối chiếu với câu khẳng định của câu tương ứng và trả về ĐỦ ${audioList.length} kết quả theo định dạng [TF_ANSWERS: 1. True, 2. False, ...]!]`;
      }
    } else {
      fullPrompt += `\n\n[CHÚ Ý: BÀI THI NGHE TRUE/FALSE GỒM ${audioList.length} CÂU. Có ${audioList.length} file audio đính kèm theo đúng thứ tự câu (AUDIO CÂU 1, AUDIO CÂU 2, ...). Hãy nghe TỪNG file, đối chiếu với câu khẳng định của câu tương ứng và trả về ĐỦ ${audioList.length} kết quả theo định dạng [TF_ANSWERS: 1. True, 2. False, ...]!]`;
    }
  }
  // BUG#46: đường Groq không gửi được file audio cho model chữ → audio đã được
  // Whisper phiên âm TRƯỚC, transcript nhồi thẳng vào prompt kèm chỉ thị rõ ràng.
  if (transcript) {
    fullPrompt += `\n\n[BÀI NGHE ĐÃ ĐƯỢC PHIÊN ÂM TỰ ĐỘNG — dùng CHÍNH XÁC bản transcript này làm nội dung bài nghe, KHÔNG suy đoán ngoài nó]:\n"""\n${transcript}\n"""`;
  }

  if (examKind === "mcq_multi") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI TRẮC NGHIỆM NHIỀU CÂU. Hãy giải TỪNG câu trong đề và trả về dòng đầu tiên theo định dạng [MCQ_ANSWERS: 1. B, 2. A, ...] với ĐỦ mọi câu!]";
  }
  if (examKind === "reading_tf") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI ĐỌC HIỂU TRUE/FALSE. Đối chiếu TỪNG câu khẳng định với ĐOẠN VĂN đã cung cấp: đúng theo đoạn văn → True, trái hoặc bịa thêm → False. Trả về dòng đầu tiên theo định dạng [TF_ANSWERS: 1. True, 2. False, ...] với ĐỦ mọi câu theo đúng thứ tự!]";
  }
  // BUG#46: đề NGHE True/False. Trước đây chỉ có nhánh reading_tf nên đề nghe rơi
  // vào prompt ioe_auto chung → AI trả [ANSWER: True] một câu thay vì đủ N câu.
  if (examKind === "listening_tf") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI NGHE TRUE/FALSE. Đối chiếu TỪNG câu khẳng định với NỘI DUNG BÀI NGHE (transcript đính kèm nếu có): đúng theo bài nghe → True, trái → False. Trả về dòng đầu tiên theo định dạng [TF_ANSWERS: 1. True, 2. False, ...] với ĐỦ mọi câu theo đúng thứ tự!]";
  }
  if (examKind === "word_order") {
    fullPrompt += "\n\n[CHÚ Ý: BÀI SẮP XẾP TỪ (word ordering). Sắp xếp các mảnh từ của TỪNG câu thành câu tiếng Anh đúng ngữ pháp, đúng nghĩa. Dùng CHÍNH XÁC từng mảnh từ như đề bài (giữ nguyên chính tả và dấu câu, KHÔNG sửa, KHÔNG thêm từ mới). Trả về dòng đầu tiên theo định dạng [WORD_ORDER: 1. mảnh | mảnh | mảnh, 2. mảnh | mảnh | mảnh, ...] với ĐỦ mọi câu, các mảnh của mỗi câu phân cách bằng dấu | !]";
  }
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
  return fullPrompt;
}

// Lưu lịch sử giải (dùng chung cho cả 2 provider).
async function saveSolveHistory(taskType, audioObj, audioList, text, answer) {
  try {
    const historyData = await chrome.storage.local.get({ history: [] });
    const isAudio = !!(audioObj || (audioList && audioList.length));
    const newHistory = [
      {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        taskType: isAudio ? "ioe_listening" : taskType,
        question: (isAudio ? "[🎧 Bài thi nghe Audio + Hình ảnh]" : (text || "[Ảnh chụp màn hình Game IOE]")).trim(),
        answer: answer
      },
      ...historyData.history.slice(0, 99)
    ];
    await chrome.storage.local.set({ history: newHistory });
  } catch (e) {}
}

// BUG#48: quy tắc phiên âm + gắn nhãn tách ra dùng CHUNG cho Groq và Cloudflare.
// Trước đây khối này viết thẳng trong callGroqWithFallback; thêm provider thứ ba
// mà copy nguyên khối thì chỉ cần sửa nhãn ở một bên là hai bên lệch nhau ngay.
// BUG#47b (đề nghe TF dùng MỘT file cho cả bài): nhãn phải nói rõ file phục vụ
// MỌI CÂU — gắn "[AUDIO CÂU 1]" khiến model tưởng file chỉ ứng với câu 1.
async function buildTranscript(transcribeFn, audioObj, audioList, providerName) {
  let transcript = null;
  if (audioObj && audioObj.base64) {
    transcript = await transcribeFn(audioObj);
    if (!transcript) throw new Error(providerName + " Whisper không phiên âm được file nghe.");
  }
  if (Array.isArray(audioList) && audioList.length) {
    const parts = [];
    for (const a of audioList) {
      let label;
      if (a && a.base64) {
        const t = await transcribeFn(a);
        label = audioList.length === 1 ? "[BÀI NGHE — DÙNG CHUNG CHO MỌI CÂU]"
                                      : "[AUDIO CÂU " + (a.qIndex || parts.length + 1) + "]";
        parts.push(label + ": " + (t || "(không phiên âm được)"));
      } else {
        label = audioList.length === 1 ? "[BÀI NGHE — DÙNG CHUNG CHO MỌI CÂU]"
                                      : "[AUDIO CÂU " + (a && a.qIndex || parts.length + 1) + "]";
        parts.push(label + ": (thiếu file audio)");
      }
    }
    transcript = parts.join("\n\n");
  }
  return transcript;
}

// BUG#46: Groq trước (không tốn quota Gemini). Ảnh luôn phải qua provider có
// vision vì model chữ của Groq không có vision.
async function callGroqWithFallback(text, taskType, groqKey, model, imageBase64, audioObj, customHint, audioList, examKind) {
  const transcript = await buildTranscript(
    (a) => groqTranscribe(groqKey, a, DEFAULT_CONFIG.groqWhisperModel),
    audioObj, audioList, "Groq"
  );

  const fullPrompt = buildFullPrompt(text, taskType, customHint, audioObj, audioList, examKind, transcript);
  const answer = await callGroqChat(groqKey, model, null, fullPrompt, imageBase64);
  await saveSolveHistory(taskType, audioObj, audioList, text, answer);
  return answer;
}

// BUG#48: đường Cloudflare. Cùng hình dạng với Groq (audio phiên âm TRƯỚC rồi
// nhồi transcript vào prompt chữ) nhưng dùng endpoint và vendor khác.
async function callCfWithFallback(text, taskType, cfKey, accountId, model, imageBase64, audioObj, customHint, audioList, examKind) {
  const transcript = await buildTranscript(
    (a) => cfTranscribe(cfKey, accountId, a, DEFAULT_CONFIG.cfWhisperModel),
    audioObj, audioList, "Cloudflare"
  );

  const fullPrompt = buildFullPrompt(text, taskType, customHint, audioObj, audioList, examKind, transcript);
  const answer = await callCfChat(cfKey, accountId, model, null, fullPrompt, imageBase64);
  await saveSolveHistory(taskType, audioObj, audioList, text, answer);
  return answer;
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

  // BUG#46: khối dựng prompt đã tách thành buildFullPrompt() để Groq và Gemini
  // dùng CHUNG một bộ chỉ thị examKind — trước đây viết inline ở đây nên khi thêm
  // provider thứ hai rất dễ lệch nhau (một bên dặn [TF_ANSWERS], bên kia [ANSWER]).
  const fullPrompt = buildFullPrompt(text, taskType, customHint, audioObj, audioList, examKind, null);

  const modelQueue = [primaryModel, ...FALLBACK_MODELS.filter(m => m !== primaryModel)];

  let lastError = null;
  let projectQuotaError = null;
  for (const model of modelQueue) {
    try {
      console.log(`[English Master AI] Trying model: ${model}...`);
      const answer = await callSingleModel(model, apiKey, fullPrompt, imageBase64, audioObj, audioList);
      console.log(`[English Master AI] Success with model: ${model}`);
      await saveSolveHistory(taskType, audioObj, audioList, text, answer);
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
      // BUG#49: quota tính theo PROJECT → MỌI model dùng chung một rổ. Thử model
      // kế tiếp không cứu được gì, chỉ ăn thêm 1 request vào đúng cái rổ đang cạn
      // và đẩy chính retry-after của mình lên cao hơn. Dừng hẳn chuỗi NGAY.
      if (isProjectQuotaError(err)) {
        projectQuotaError = err;
        console.warn("[English Master AI] Hết quota Gemini theo PROJECT — dừng chuỗi model tại " + model + " (mọi model dùng chung hạn mức, thử thêm chỉ làm cạn nhanh hơn).");
        break;
      }
      if (err.status === 429 || (err.status >= 500 && err.status < 600)) {
        await sleep(500);
      }
    }
  }

  // BUG#49: hết quota theo project — thông báo phải NÓI RÕ vì sao không thử tiếp
  // các model còn lại (người dùng sẽ tưởng extension bỏ sót model nào đó), kèm
  // thời gian chờ THẬT của Google và cách chữa gốc.
  if (projectQuotaError) {
    const wait = parseRetryAfterSeconds(projectQuotaError);
    throw new Error(
      "Hết quota Gemini free tier (429). Hạn mức này tính theo PROJECT và TẤT CẢ model dùng CHUNG một rổ, nên extension DỪNG ngay chứ không thử " + modelQueue.length + " model — thử thêm chỉ ăn thêm request vào chính hạn mức đang cạn."
      + (wait ? " Google nói thử lại sau khoảng " + wait + " giây." : " Chờ 1-2 phút rồi bấm giải lại.")
      + " Cách chữa gốc: thêm key Groq (console.groq.com/keys) hoặc Cloudflare (dash.cloudflare.com) ở trang Cài đặt — hai provider này có hạn mức RIÊNG, không dùng chung với Gemini. Chi tiết Google: " + String(projectQuotaError.message)
    );
  }

  // BUG#16: thông điệp cuối trung thực theo loại lỗi thật — chỉ 429 mới là "quá tải"
  const lastMsg = String(lastError?.message || "Vui lòng thử lại sau giây lát.");
  if (lastError && lastError.status === 429) {
    throw new Error("Hết quota / quá tải toàn bộ " + modelQueue.length + " model AI (429). Chờ 1-2 phút rồi bấm giải lại. Chi tiết: " + lastMsg);
  }
  throw new Error(`Không gọi được AI (đã thử ${modelQueue.length} model): ${lastMsg}`);
}

// BUG#46 + BUG#48: điều phối provider theo CHUỖI (không còn cứng 2 nhánh).
// Thứ tự: provider người dùng chọn trước, rồi tới chuỗi mặc định
// groq → cloudflare → gemini. Provider thiếu key — hoặc có ảnh mà không có
// vision — bị LOẠI KHỎI chuỗi ngay từ đầu. Đây là bất biến BUG#46a: bản đầu để
// dự phòng trỏ vào chính provider vừa dùng được nên đường có ẢNH gọi Gemini HAI
// lần liên tiếp (lần hai chắc chắn fail y hệt, chỉ tốn thời gian và nhân đôi
// request đốt quota). Live-caught bằng unit test.
async function solveWithAi(text, taskType, opts = {}) {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  const groqKey = String(opts.groqApiKey || config.groqApiKey || "").trim();
  const groqModel = opts.groqModel || config.groqModel || DEFAULT_CONFIG.groqModel;
  const cfKey = String(opts.cfApiKey || config.cfApiKey || "").trim();
  const cfAccountId = String(opts.cfAccountId || config.cfAccountId || "").trim();
  const cfModel = opts.cfModel || config.cfModel || DEFAULT_CONFIG.cfModel;
  const prefer = opts.preferProvider || config.preferProvider || DEFAULT_CONFIG.preferProvider;

  // Cổng này là hàng rào NGỮ NGHĨA, không phải kỹ thuật: callGroqChat/callCfChat
  // vốn đã tự bỏ qua ảnh khi model không có vision, nên nếu chỉ vì kỹ thuật thì cổng
  // là dư. Nó tồn tại để một đề MÀ ĐÁP ÁN CHỈ NẰM TRONG ẢNH không bị model chữ đoán
  // mò rồi trả lời bừa. Vì vậy đừng gỡ cổng — hãy bỏ ẢNH ở nơi sinh ra nó khi ảnh
  // thật sự vô dụng (BUG#50: đề nghe TF nhiều file, xem content/ioe/ioe.js).
  const hasImages = !!(opts.imageBase64 && (Array.isArray(opts.imageBase64) ? opts.imageBase64.length : true));

  const providers = {
    // Gemini luôn nằm trong chuỗi: thiếu key thì chính nó ném hướng dẫn nhập key,
    // giữ đúng hành vi tương thích ngược của bản cũ (chỉ Gemini, không Groq).
    gemini: {
      name: "Gemini",
      usable: true,
      call: () => callGeminiWithFallback(
        text, taskType, opts.apiKey, opts.model,
        opts.imageBase64 || null, opts.audioObj || null, opts.hint || "",
        opts.audioList || null, opts.examKind || null
      )
    },
    groq: {
      name: "Groq",
      usable: !!groqKey && !hasImages,
      call: () => callGroqWithFallback(
        text, taskType, groqKey, groqModel,
        opts.imageBase64 || null, opts.audioObj || null, opts.hint || "",
        opts.audioList || null, opts.examKind || null
      )
    },
    cloudflare: {
      name: "Cloudflare",
      // Cần CẢ token lẫn Account ID (URL có account trong đường dẫn).
      usable: !!cfKey && !!cfAccountId && (!hasImages || cfSupportsImages(cfModel)),
      call: () => callCfWithFallback(
        text, taskType, cfKey, cfAccountId, cfModel,
        opts.imageBase64 || null, opts.audioObj || null, opts.hint || "",
        opts.audioList || null, opts.examKind || null
      )
    }
  };

  const DEFAULT_PROVIDER_ORDER = ["groq", "cloudflare", "gemini"];
  const order = [prefer, ...DEFAULT_PROVIDER_ORDER.filter((p) => p !== prefer)];
  const chain = order.map((k) => providers[k]).filter((p) => p && p.usable);

  if (!chain.length) {
    throw new Error("Chưa có provider AI nào dùng được. Cần ít nhất một key: Gemini (aistudio.google.com/app/apikey), Groq (console.groq.com/keys) hoặc Cloudflare (dash.cloudflare.com).");
  }

  const failures = [];
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    try {
      const r = await p.call();
      console.log("[English Master AI] ✅ Giải bằng " + p.name);
      return r;
    } catch (e) {
      failures.push({ name: p.name, err: e });
      if (i < chain.length - 1) {
        console.warn("[English Master AI] ⚠️ " + p.name + " lỗi (" + (e && e.message) + ") — chuyển provider kế tiếp...");
      }
    }
  }

  // Chỉ một provider dùng được → ném ĐÚNG lỗi gốc (không bọc lại), để các thông
  // báo hướng dẫn dài (thiếu key, bị suspend, geo-block...) hiện nguyên văn.
  if (failures.length === 1) throw failures[0].err;
  throw new Error("Cả " + failures.length + " provider đều lỗi → " + failures.map((f) => f.name + ": " + (f.err && f.err.message)).join(" | "));
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

        const result = await solveWithAi(request.text || "", "ioe_auto", {
          apiKey: request.apiKey,
          model: request.model,
          groqApiKey: request.groqApiKey,
          groqModel: request.groqModel,
          cfApiKey: request.cfApiKey,
          cfAccountId: request.cfAccountId,
          cfModel: request.cfModel,
          preferProvider: request.preferProvider,
          imageBase64: imagePayload,
          audioObj,
          audioList,
          hint: request.hint,
          examKind: request.examKind
        });
        sendResponse({ success: true, data: result, hasAudio: !!(audioObj || (audioList && audioList.length)) });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }

    if (request.images && Array.isArray(request.images) && request.images.length > 0) {
      handleSolveWithImages(request.images);
      return true;
    }

    // BUG#50: đề NGHE True/False nhiều file — content script đã chủ động bỏ ảnh vì
    // đáp án nằm trọn trong audio. Nếu ở đây tự chụp bù thì hasImages lại thành true
    // và Groq bị loại khỏi chuỗi y như cũ. Tôn trọng cờ và đi thẳng, ảnh = null.
    if (request.skipScreenshot) {
      handleSolveWithImages(null);
      return true;
    }

    captureVisibleTabWithRetry(windowId)
      .then((dataUrl) => handleSolveWithImages(dataUrl))
      .catch((err) => sendResponse({ success: false, error: "Không thể chụp màn hình tab: " + err.message }));
    return true;
  }

  if (request.action === "SOLVE_QUESTION") {
    solveWithAi(request.text, request.taskType, {
      apiKey: request.apiKey,
      model: request.model,
      groqApiKey: request.groqApiKey,
      groqModel: request.groqModel,
      cfApiKey: request.cfApiKey,
      cfAccountId: request.cfAccountId,
      cfModel: request.cfModel,
      preferProvider: request.preferProvider,
      imageBase64: request.image,
      hint: request.hint
    })
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === "TEST_API_KEY") {
    // provider: "groq" → chỉ kiểm tra Groq; mặc định kiểm tra Gemini.
    if (request.provider === "groq") {
      (async () => {
        try {
          const config = await chrome.storage.local.get(DEFAULT_CONFIG);
          const key = String(request.apiKey || config.groqApiKey || "").trim();
          if (!key) throw new Error("Chưa có Groq API Key. Lấy MIỄN PHÍ tại console.groq.com/keys");
          const model = request.model || config.groqModel || DEFAULT_CONFIG.groqModel;
          const out = await callGroqChat(key, model, null, "Reply with exactly: OK", null);
          if (!/ok/i.test(String(out))) throw new Error("Groq trả về kết quả bất thường: " + String(out).slice(0, 120));
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
    // BUG#48: provider "cloudflare" cần tới 2 thứ (token + Account ID) nên phải
    // báo thiếu cái nào cụ thể, không được gộp thành "key sai".
    if (request.provider === "cloudflare") {
      (async () => {
        try {
          const config = await chrome.storage.local.get(DEFAULT_CONFIG);
          const key = String(request.apiKey || config.cfApiKey || "").trim();
          const acc = String(request.accountId || config.cfAccountId || "").trim();
          if (!key) throw new Error("Chưa có Cloudflare API Token. Tạo tại dash.cloudflare.com → My Profile → API Tokens → Create Token (chọn quyền 'Workers AI - Read').");
          if (!acc) throw new Error("Chưa có Cloudflare Account ID. Lấy tại dash.cloudflare.com → Workers & Pages → cột phải (chuỗi hex 32 ký tự).");
          const model = request.model || config.cfModel || DEFAULT_CONFIG.cfModel;
          const out = await callCfChat(key, acc, model, null, "Reply with exactly: OK", null);
          if (!/ok/i.test(String(out))) throw new Error("Cloudflare trả về kết quả bất thường: " + String(out).slice(0, 120));
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
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
