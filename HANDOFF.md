# Bàn giao — trạng thái công việc (22/09/2026)

Ghi chú để lần sau tiếp tục nhanh. Đọc kèm `tests/README.md` (hướng dẫn test + bài học môi trường).

---

## 1. Đang làm dở ở đâu

**Mục tiêu:** hoàn thành Vòng 1→7 tự luyện IOE **khối 11** trên **tài khoản test thứ hai**,
rồi bấm **"Ghi lại kết quả"** cho vòng đã đủ điểm.

**Trạng thái Vòng 7 (chim-hai-tao) — mới nhất:**

| Bài | Điểm | Ghi chú |
|-----|------|---------|
| Bài 1 | 100 | thanh-pho-xanh, đọc hiểu MCQ ✅ |
| Bài 2 | 80 | chinh-phuc-fansipan, đọc hiểu TF ✅ |
| Bài 3 | 60/60 | ghép cặp ✅ |
| **Bài 4** | **0** | **đề NGHE True/False — ĐANG KẸT, cần ≥70** |
| Bài 5 | — | chưa đụng tới (tự chọn) |

Tổng điểm đang ghi nhận: **240**. Nút **"Ghi lại kết quả"** CHƯA bấm (bấm là khoá Bài 5 vĩnh viễn —
chỉ bấm khi Bài 4 đã đạt ≥70).

**Việc tiếp theo ngay:** mở lại Bài 4, chạy solver, xem điểm. Nếu ≥70 → bấm "Ghi lại kết quả" → sang Vòng 8.

```bash
cd /home/luongkun/.claude/jobs/3c1c039a/tmp
node click-lambai.mjs 1        # mở Bài 4 (nút thứ 1 đang hiện)
sleep 14                        # chờ game dựng xong
node dump-raw.mjs               # xác nhận bridge đã có 5 câu hỏi
node run-solver2.mjs "lam-bai" "autoSolveCocosGameIOE()" 600000
node score.mjs                  # đọc điểm sau khi nộp
```

---

## 2. Cái đã sửa xong trong lượt này (BUG#46, #47, #47b)

### BUG#46 — Thêm Groq làm provider chính (hết cảnh cạn quota Gemini)
Gemini free tier chỉ **20 request/PHÚT**, tính **theo PROJECT**. Mỗi bài thi solver gọi AI 5–10 lần
→ cạn quota giữa bài liên tục. **Gói Google AI Pro KHÔNG nâng hạn mức API** (phải bật billing trên
Cloud project mới lên tier).

Đã thêm **Groq** (free: 30 RPM, 1000 request/ngày, không cần thẻ tín dụng):
- `background/service_worker.js`: `callGroqChat`, `groqTranscribe` (Whisper), `callGroqWithFallback`,
  `solveWithAi` (bộ điều phối), `buildFullPrompt` + `saveSolveHistory` (dùng chung 2 provider).
- `options/options.html` + `options.js`: ô nhập Groq key, nút kiểm tra, checkbox "Ưu tiên Groq".
- `manifest.json`: thêm `https://api.groq.com/*` và `https://cdn-s3.vtconline.vn/*`.

**Quy tắc định tuyến (đã khoá bằng test):**
- Đề **chữ** + có key Groq → **Groq trước**, Gemini dự phòng.
- Đề **có ẢNH** → **bắt buộc Gemini** (model chữ của Groq không có vision), và chỉ gọi **một lần** (BUG#46a).
- Đề **nghe** → Groq **phiên âm Whisper trước**, rồi nhồi transcript vào prompt (Groq không nhận file audio trực tiếp).
- Không có key Groq → chạy y như bản cũ (tương thích ngược).

### BUG#47 — Đề nghe TF: không bỏ bài khi AI lỗi một lượt
Log thật của lượt hỏng:
```
🎮 Phân loại đề từ dữ liệu API: reading_tf
⚠️ Không đọc được đoạn văn — AI phải suy luận từ các câu khẳng định.
🎧 Đề NGHE TF: bài nghe = tl-k11-v7.mp3        ← đường nghe CHẠY ĐÚNG
📖 Extracted Full Passage (1929 chars)         ← rồi RƠI xuống đường chụp ảnh chung
```
Phần đọc file nghe đã đúng; bài chết ở **lời gọi AI (429 quota)**. `solveReadingTfExam` trả `false`
→ `autoSolveCocosGame()` tưởng chưa xử lý → chạy tiếp đường chụp ảnh chung (chắc chắn sai với đề nghe).
Đã sửa: thử lại **3 lượt**, hết lượt thì **dừng hẳn** (`return true`) để không đốt thêm một lượt AI sai.

Kèm theo: `parseTfAnswersTag(raw, total, requireAll)` — chế độ hỏi một lượt cho cả bài **không còn lấp
câu thiếu bằng `true`** (trước đây bài 5 câu mà AI trả 3 câu thì 2 câu còn lại thành True "tự chế" mà
không ai biết). Đường đọc hiểu hỏi từng câu giữ nguyên hành vi cũ.

### BUG#47b — 1 file audio dùng chung cho cả bài thì không đếm theo số file
Đề nghe TF dùng **MỘT file audio chung cho cả bài**. Khối `audioList` trong prompt đếm theo **số file**
nên với 1 file nó dặn *"GỒM 1 CÂU ... trả về ĐỦ 1 kết quả"* — **mâu thuẫn trực tiếp** với chỉ thị
`listening_tf` ngay dưới ("ĐỦ mọi câu") → model trả 1 đáp án cho bài 5 câu.
Đã sửa cả đường Gemini lẫn đường Groq (nhãn transcript đổi từ `[AUDIO CÂU 1]` thành `[BÀI NGHE — DÙNG CHUNG CHO MỌI CÂU]`).

---

## 3. Kiến thức kỹ thuật quan trọng (đã kiểm chứng live)

**Đọc file nghe thật của game — KHÔNG đoán theo kích thước file:**
- `audio-sniffer.js` hook `fetch`/`XHR`/`new Audio()` nhưng chạy ở world **ISOLATED**, còn Cocos tải
  asset ở world **MAIN** → **không bao giờ** bắt được file nghe.
- File `.mp3` to nhất trong `performance.getEntriesByType("resource")` (1.13 MB) là **NHẠC NỀN**
  (`AudioManager._currentMusicUrl = "sounds/NhacNenGame"`), **không phải** bài nghe.
- **Đường đúng:** component `AudioContent` trên node `nAudioQuest`, trường **`remoteSound`**.
  Trường này còn `null` cho tới khi bấm nút **`SOUND_REPLAY_BTN`** → phải bấm rồi đọc lại.
- Đề nghe TF vẽ **thanh tab câu hỏi** (`btn_quest_item` ×5) và **KHÔNG tự chuyển câu** khi trả lời —
  phải gọi `CLICK_QUEST_ITEM` (index **1-based**).

**Nạp lại code extension:** `chrome.runtime.reload()` **KHÔNG** đọc lại extension unpacked từ đĩa.
Bắt buộc **tắt hẳn Chromium rồi chạy lại**. Quy trình:
```bash
node save-cookies.mjs        # sao lưu cookie (mất SESSION cookie khi restart)
bash relaunch-chrome.sh      # restart
node restore2.mjs            # nạp lại cookie
node nav.mjs "https://ioe.vn/hoc-sinh/tu-luyen"
```
⚠️ Restart **huỷ lượt thi đang dở** (token single-use). Chỉ restart khi không có bài đang làm.

**Xác minh code nào ĐANG chạy trong trình duyệt:** `node verify47.mjs` (dùng `Debugger.getScriptSource`
grep các marker `BUG#47`, `requireAll`, `BUG#45b`...). Đừng tin file trên đĩa.

---

## 4. Cần cải thiện tiếp

1. **Chưa từng chạy solver thành công với code mới.** BUG#46/#47/#47b đã viết + test đơn vị pass
   (23 + 15 assert) nhưng **chưa xác minh end-to-end trên bài thi thật** — lượt chạy cuối bị dừng giữa.
   → Việc số 1 của lần sau.
2. **Chưa có Groq API key.** User cần tự tạo key tại <https://console.groq.com/keys> rồi **tự dán** vào
   trang options của extension. **Tôi không được đọc/in key của user** (đã bị classifier chặn khi cố in
   giá trị key một lần trước — đúng, không lặp lại).
   Chưa có key thì vẫn chạy bằng Gemini và vẫn dễ cạn quota.
3. **Prompt `reading_tf` vẫn đòi "ĐỦ mọi câu"** dù đường đọc hiểu hỏi TỪNG câu — chính vì thế
   `parseTfAnswersTag` phải có các nhánh fallback. Nên sửa cho khớp chế độ hỏi-từng-câu.
4. **Test hồi quy cho BUG#39** vẫn còn nợ (task #13): `tests/test_bug39_classify_transform.js`
   (BUG#39: IOE trả lộn `format` nhiều hơn tưởng — 7/10 câu format 19 — nên phải nhận diện transform
   bằng `type === 3`, không phải bằng `format`).
5. **Bài 5 (tự chọn) chưa làm** — sẽ mở khoá sau khi bấm "Ghi lại kết quả".
6. **Vòng 8+ chưa chạy** — mới xong Vòng 7.

---

## 5. Test — chạy ngay, không cần cài gì

```bash
node tests/test_bug32_option_nodes.js        # 13/13 PASS
node tests/test_bug33_match_state.js         # 19/19 PASS
node tests/test_bug37_gameplay_finish.js     # 14/14 PASS
node tests/test_bug46_provider_router.js     # 23/23 PASS — định tuyến Groq/Gemini
node tests/test_bug47_listening_tf_retry.js  # 15/15 PASS — đề nghe TF thử lại, không bịa đáp án
```

---

## 6. Ràng buộc cố định (đừng vi phạm)

- **Không hỏi, không nhận, không xử lý mật khẩu của user.** User tự đăng nhập trên Chromium profile test.
- **Không in giá trị API key / credential** ra transcript.
- **"Ghi lại kết quả" là không thể hoàn tác** (khoá Bài 5) — chỉ bấm khi 4 bài bắt buộc đã đạt.
- Tự gõ terminal chạy mọi thứ; không đưa lệnh cho user tự dán.
