// ===== TEST-ONLY MOCK MODE =====
// Khi true: không gọi Gemini thật mà trả đáp án định sẵn theo từ khoá trong prompt.
// Cho phép test toàn bộ pipeline (parse tag → auto-click/typing) mà không cần API key.
const MOCK_GEMINI = true;

function mockGeminiAnswer(promptText) {
  const p = (promptText || "").toLowerCase();
  // DẠNG 6: Nghe điền từ (fillword) — mock thông minh:
  //  - đếm số câu thật từ dòng "Tổng số câu cần giải: N" trong prompt
  //  - ưu tiên lấy từ trong "KHO TỪ GỢI Ý" (answerPool) nếu có → giả lập AI hoàn hảo
  //  - nếu không có pool, dùng từ mặc định xoay vòng
  if (p.includes("nghe điền từ") || p.includes("[fill_words") || p.includes("sup****")) {
    // 0. PERFECT-AI MODE: test data có thể đặt đáp án đúng vào gameDesc
    //    ("Hướng dẫn game: ... ANSWERS: w1, w2, ...") → mock trả NGUYÊN VẸN danh
    //    sách đó, mô phỏng AI thật đã NGHE audio (audio phân biệt được các câu
    //    có mask giống hệt nhau — mask matching thuần thì không).
    const mA = p.match(/hướng dẫn game:[^\n]*\banswers:\s*([a-z' -]+(?:,\s*[a-z' -]+)*)/);
    if (mA) {
      const fixed = mA[1].split(/,\s*/).map(w => w.trim()).filter(Boolean);
      if (fixed.length) {
        return `[FILL_WORDS: ${fixed.map((w, i) => `${i + 1}. ${w}`).join(", ")}]\n\n**Giải thích:** (mock v4-perfect) nghe audio từng câu → điền từ bị che: ${fixed.join(", ")}.`;
      }
    }
    // Parse pool từ "KHO TỪ GỢI Ý..."
    let pool = [];
    const mP = p.match(/kho từ gợi ý[^:]*:\s*([^\n]+)/);
    if (mP) pool = mP[1].split(/,\s*/).map(w => w.trim().replace(/\.$/, "")).filter(w => w && w.length && !/ưu tiên/.test(w.toLowerCase()));
    const defaults = ["supposed", "computer", "views", "meets", "research", "biggest", "posed", "level", "turtles", "damage", "fast", "worrying", "forests", "lose"];
    // Parse từng mask: [từ bị che: "pref***" — N chữ cái bị ẩn(, tiền tố đã biết "pref")]
    const reMask = /\[từ bị che:\s*"([^"]*)"\s*[—-]\s*(\d+)\s*chữ cái bị ẩn/g;
    const words = [];
    let mm;
    while ((mm = reMask.exec(p)) !== null) {
      const full = mm[1];
      const stars = (full.match(/\*/g) || []).length;
      const prefix = full.replace(/\*+$/, "");
      const needLen = prefix.length + parseInt(mm[2], 10);
      const cand = pool.concat(defaults).filter(w => w.toLowerCase().startsWith(prefix.toLowerCase()) && w.length === needLen);
      words.push(cand[0] || (prefix + "x".repeat(Math.max(0, parseInt(mm[2], 10)))));
    }
    if (!words.length) {
      let n = 5;
      const mN = p.match(/tổng số câu cần giải:\s*(\d+)/) || p.match(/gồm\s*(\d+)\s*câu/);
      if (mN) n = parseInt(mN[1], 10);
      if (n < 1) n = 1;
      for (let i = 0; i < n; i++) words.push(pool.length ? pool[i % pool.length] : defaults[i % defaults.length]);
    }
    return `[FILL_WORDS: ${words.map((w, i) => `${i + 1}. ${w}`).join(", ")}]\n\n**Giải thích:** (mock v3) nghe audio điền từ bị che — ${words.length} từ, pool=${pool.length}: ${pool.join("/")}.`;
  }
  // DẠNG 7: Trắc nghiệm nhiều câu — test mock_mcqgame.html
  if (p.includes("trắc nghiệm nhiều câu") || p.includes("[mcq_answers")) {
    return "[MCQ_ANSWERS: 1. B, 2. A, 3. C]\n\n**Giải thích:** chọn theo ngữ pháp.";
  }
  // Dạng MCQ trên trang giả lập
  if (p.includes("will cancel") || p.includes("camping trip")) {
    return "[ANSWER: A. will cancel]\n\n**Giải thích:** Câu điều kiện loại 1 (If + hiện tại, will + V) → chọn A.";
  }
  // Dạng điền chữ thiếu fam_ _s
  if (p.includes("fam_") || p.includes("singer")) {
    return "[ANSWER: ou]\n\n**Giải thích:** famous = nổi tiếng.";
  }
  // Dạng sắp xếp từ
  if (p.includes("sắp xếp") || p.includes("always")) {
    return "[ANSWER: She always gets up early in the morning]\n\n**Giải thích:** Trạng từ tần suất đứng sau chủ ngữ.";
  }
  // Ghép cặp
  if (p.includes("ghép") || p.includes("ghep")) {
    return "[MATCH_PAIRS: 1-4, 2-9, 3-6, 5-12, 7-8, 10-11]\n\n**Giải thích:** các cặp từ đồng nghĩa.";
  }
  // True/False đơn
  if (p.includes("true/false") || p.includes("đúng sai")) {
    return "[ANSWER: True]\n\n**Giải thích:** câu khẳng định khớp audio.";
  }
  // Multi True/False
  if (p.includes("tf") || p.includes("nhiều câu")) {
    return "[TF_ANSWERS: 1. True, 2. False, 3. True, 4. True, 5. False, 6. True, 7. False, 8. True, 9. True, 10. False]";
  }
  return "[ANSWER: A]\n\n**Giải thích:** (mock mặc định)";
}

