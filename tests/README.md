# Test Suite — English Master AI (IOE Extension)

Hạ tầng test E2E cho extension trên Chromium thật (không headless-new vì nó **không inject content script**).

## Cấu trúc

| File | Mục đích |
|------|----------|
| `test_bug32_option_nodes.js` | **Chạy được bằng `node` thuần, KHÔNG cần Playwright/Xvfb/mạng.** Nạp thẳng các hàm thật từ `game-api-bridge.js` rồi chạy trên cây Cocos giả lập đúng cấu trúc live của `an-khe-tra-vang` (BUG#32: text đáp án và nút bấm là ANH EM, `AnswerButton` tuỳ biến, nút D tên `btnd` chữ thường). 13 assert. |
| `test_bug33_match_state.js` | **Chạy được bằng `node` thuần.** Mô phỏng lại ĐÚNG máy trạng thái của game `ghep-cap` chép từ bundle đã tải (`assets/resources/index.*.js` → `Game12.onHandlerChooseAnswerCross` + `GamePlay.submit`/`failAnswer`/`continue`), rồi chạy `autoMatch` thật trên đó. Khoá: thứ tự nộp `[prompt, answer]`, guard tự đảo khi API trả ngược, bỏ qua cặp đã ghép, DỪNG trước ngân sách sai (4 lần sai = hết ván), và ghép CHỮ↔ẢNH (BUG#34). 19 assert. |
| `test_bug37_gameplay_finish.js` | **Chạy được bằng `node` thuần.** Nạp thẳng `findGamePlay` + `finishGameDirect` từ `game-api-bridge.js` rồi chạy trên cây Cocos giả lập. Khoá BUG#37: nhận diện GamePlay bằng BỘ ĐÔI field (`questComs` + `currentQuestionId` + `endGame`) chứ KHÔNG bằng tên class (bị minify thành `"t"`), bỏ qua node inactive, chờ bất đồng bộ `isEndGame`, không báo thành công giả khi POST hỏng, và không nộp đôi. 14 assert. |
| `test_bug46_provider_router.js` | **Chạy được bằng `node` thuần.** Nạp thẳng `background/service_worker.js` với `chrome` API giả + `fetch` ghi lại lời gọi. Khoá BUG#46: Groq đi trước cho đề chữ (không đốt quota Gemini), audio phải qua Whisper rồi transcript được nhồi vào prompt, đề có ẢNH bắt buộc đi Gemini và **chỉ gọi một lần** (BUG#46a), `preferProvider` đảo được thứ tự, thiếu key Groq thì tương thích ngược, nhiều file audio được phiên âm từng file và gắn nhãn theo câu, và BUG#47b: 1 file audio dùng chung cho cả bài thì prompt không được đếm theo số file ("GỒM 1 CÂU"). 23 assert. |
| `test_bug47_listening_tf_retry.js` | **Chạy được bằng `node` thuần.** Trích thẳng `parseTfAnswersTag` từ `ioe.js` rồi chạy trên vòng thử lại mô phỏng đúng khối code trong `solveReadingTfExam`. Khoá BUG#47: AI trả THIẾU câu không còn bị lấp bằng `true` (`requireAll`), lượt AI lỗi giữa bài nghe được thử lại 3 lượt thay vì bỏ cả bài, và hết lượt thì DỪNG HẲN — không rơi xuống đường chụp ảnh chung (`Extracted Full Passage`). 15 assert. |
| `test_extension.js` | Suite 12 test trên trang giả lập (pill inject, bridge inject, anti-copy, MCQ solve+autoclick, F2, fill, reorder, mixed, pageerror) |
| `test_fillword.js` | Suite 11 test E2E dạng **nghe điền từ** (EditBox Cocos) + **trắc nghiệm nhiều câu** + cache câu hỏi + chip click không ReferenceError |
| `test_ai_key_failure.js` | Suite 14 test E2E **đường AI Gemini THẬT khi key chưa nhập / sai / placeholder** (BUG#16/#17): không gán nhãn "quá tải" cho key sai, không render bảng "1.? 2.? 3.?", có hướng dẫn lấy key, thoát nhanh. Cần bản extension `ioe-bugtest` (copy ioe-test rồi `MOCK_GEMINI = false`) — chạy `node tests/test_ai_key_failure.js before|after` |
| `debug_fillword_e2e.js` | Debug 1 trang fillword: dump console, bridge state, panel chips, game state — dùng khi cần soi pipeline từng bước |
| `mock-pages/` | Trang giả lập IOE + runtime Cocos giả (`mock_cocos_runtime.js`) — phục vụ từ file server test |
| `mock_gemmai_snippet.js` | Block `MOCK_GEMINI` chèn vào service worker bản test — mô phỏng Gemini trả đáp án theo từ khoá prompt, không cần API key |

## Test chạy ngay (không cần cài gì)

```bash
node tests/test_bug32_option_nodes.js    # 13/13 PASS — logic tra node đáp án
node tests/test_bug33_match_state.js     # 19/19 PASS — máy trạng thái ghép cặp
node tests/test_bug37_gameplay_finish.js # 14/14 PASS — nộp bài qua GamePlay.endGame()
node tests/test_bug46_provider_router.js # 20/20 PASS — định tuyến Groq/Gemini
node tests/test_bug47_listening_tf_retry.js # 15/15 PASS — đề nghe TF: thử lại, không bịa đáp án
```

## Tái lập môi trường test (từ repo trống)

1. **Bản extension test**: copy toàn bộ repo sang `<workdir>/ioe-test`, rồi:
   - `manifest.json`: thêm `http://localhost/*` vào `matches` của mọi content_scripts; **version PHẢI là số thuần** (vd `2.12.1`) — chuỗi kiểu `"2.12.1-test"` làm Chrome từ chối khởi động DevTools/extension.
   - `background/service_worker.js`: chèn block trong `mock_gemmai_snippet.js` ngay sau `const sleep = ...` (dòng ~24), và trong handler `SOLVE_CURRENT_SCREEN` thay lời gọi `callGeminiWithFallback(...)` bằng:
     ```js
     const result = MOCK_GEMINI ? mockGeminiAnswer(fullPrompt || request.text || "")
       : await callGeminiWithFallback(request.text || "", "ioe_auto", request.apiKey, request.model, imagePayload, audioObj, request.hint, audioList, request.examKind);
     ```
2. **Yêu cầu môi trường**: `Xvfb`, Playwright (`chromium.connectOverCDP`), Chromium có đường dẫn giống script (hoặc sửa hằng `CHROME`).
3. **Chạy**:
   ```bash
   node tests/test_extension.js     # 12/12 PASS
   node tests/test_fillword.js      # 11/11 PASS
   node tests/test_ai_key_failure.js after   # 14/14 PASS (cần ioe-bugtest: copy ioe-test + MOCK_GEMINI=false)
   ```

## Bài học môi trường (ĐÃ VỠ TÊN, ĐỪNG LẶP LẠI)

1. **`browser.close()` với `connectOverCDP` chỉ DISCONNECT — Chrome vẫn sống.** Phải `pkill` Chrome/Xvfb stale trước mỗi lần chạy, nếu không CDP sẽ connect vào Chrome CŨ (extension code cũ + profile cũ) → kết test sai lệch một cách "bí ẩn" (đã xảy ra: mock mới không có tác dụng dù code đúng). Cả 2 script hiện đã tự pkill ở đầu.
2. `headless=new` không inject content script → phải dùng Xvfb headed.
3. Playwright tự chèn `--disable-extensions` → phải `ignoreDefaultArgs: ['--disable-extensions']` (khi launch qua Playwright; script này tự spawn Chrome nên không cần).
4. `/dev/shm` 64MB làm renderer crash → `--disable-dev-shm-usage`; WebGL cho Cocos cần `--use-angle=swiftshader` (nếu test game thật).
5. Token game IOE **single-use**: mở lại tab game cũ → getinfo trả "Bạn không có quyền" (bridge giờ phát sự kiện GETINFO_ERROR và UI báo F5).
6. **`chrome.runtime.reload()` KHÔNG nạp lại extension unpacked chạy bằng `--load-extension`.** Nó gỡ extension khỏi Chrome và KHÔNG đọc lại từ đĩa → `service_worker` target biến mất, content script không còn inject (bridge `undefined`). Muốn nạp code mới: **tắt hẳn Chrome rồi chạy lại lệnh `chromium --load-extension=...`**. (Đã dính 22/09/2026 khi test BUG#32.) Cách ly nhanh không cần nạp lại: trích thẳng hàm từ file bằng `node` rồi chạy trên cây Cocos giả lập — xem `test_bug32_option_nodes.js`.

## Test trên ioe.vn THẬT

- Đăng nhập → Vào luyện/tu luyện → mở game; bridge bắt `api-edu.go.vn/ioe-service/v2/game/getinfo` (XHR path) → badge "🎮 API N câu" hiện trên pill.
- Bấm **Tự Làm**: classifier đọc dữ liệu API (không đoán theo URL) → dispatch đúng executor (ghép cặp / MCQ / nghe điền từ / trắc nghiệm nhiều câu / nghe True-False).
- Đã verify trực tiếp trên game thật `tai-tao-san-ho` (nghe điền từ, 10 câu): controller path `onEditTextChange` + `onKeyEnterPress` ghi 10/10 câu đúng.
