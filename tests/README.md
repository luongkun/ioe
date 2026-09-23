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
| `test_bug48_cf_provider.js` | **Chạy được bằng `node` thuần.** Nạp thẳng `service_worker.js` với `chrome` API giả + `fetch` ghi lại lời gọi. Khoá BUG#48 — Cloudflare Workers AI là **provider thứ ba** với hạn mức độc lập: URL chat phải có Account ID trong đường dẫn, **Whisper phải đi REST run endpoint `/ai/run/<model>` với body BYTES THÔ** (Cloudflare không có audio trong bộ OpenAI-compatible), thiếu Account ID thì provider bị loại khỏi chuỗi chứ không gọi mạng, model text-only thì bị bỏ khi đề có ẢNH, `preferProvider='cloudflare'` chạy trước Groq, lỗi shape `{errors:[{message}]}` phải hiện thông điệp thật, và cả 3 provider lỗi thì thông báo nêu đủ tên. 30 assert. |
| `test_bug49_project_quota.js` | **Chạy được bằng `node` thuần.** Khoá BUG#49 — 429 quota **theo PROJECT** không được thử tiếp các model Gemini khác (mọi model dùng chung metric `generate_content_free_tier_requests`, nên thử thêm chỉ ăn thêm request vào chính hạn mức đang cạn — log thật cho thấy retry-after tăng dần 14.7s → 45.5s). Test khoá: chỉ gọi ĐÚNG 1 lần khi gặp loại 429 đó, VẪN thử hết 5 model với 429 theo riêng model và với 503 high-demand, thông báo hiện thời gian chờ THẬT của Google, phân biệt đúng metric free tier (requests lẫn tokens), và Gemini hết quota thì nhường cho provider có hạn mức riêng. 23 assert. |
| `test_bug22_reentry.js` | **E2E — cần Playwright/Xvfb.** Chống giải lồng nhau (BUG#22, v3.5): bấm Tự Làm giữa lúc đang gõ từ, spam Tự Làm/F2 đồng loạt, và kiểm tra khoá `data-ema-busy` nhả đúng lúc. 5 case T1–T5. |
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
node tests/test_bug46_provider_router.js # 23/23 PASS — định tuyến Groq/Gemini
node tests/test_bug47_listening_tf_retry.js # 15/15 PASS — đề nghe TF: thử lại, không bịa đáp án
node tests/test_bug48_cf_provider.js    # 30/30 PASS — chuỗi 3 provider, Cloudflare/Whisper
node tests/test_bug49_project_quota.js  # 23/23 PASS — 429 quota theo project: dừng chuỗi model
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

7. **TẮT HẲN Chrome VẪN CÓ THỂ CHẠY SERVICE WORKER CŨ — kiểm tra `ScriptCache` trong profile.**
   Chrome cache script của service worker ở `<profile>/Default/Service Worker/ScriptCache`, và cache này
   **không bị vô hiệu khi file trên đĩa đổi**. Hậu quả đo được ngày 22/09/2026: file
   `background/service_worker.js` trên đĩa 57.026 ký tự, nhưng SW đang chạy chỉ **27.941 ký tự** —
   bản từ **trước cả v3.8**, không có `groqApiKey` trong `DEFAULT_CONFIG`. Nghĩa là toàn bộ code Groq
   của BUG#46 **chưa từng chạy** trong profile đó, dù đã tắt/mở Chrome nhiều lần (bài học #6 ở trên
   chỉ đúng phần `chrome.runtime.reload()`, chưa đủ).
   Sau đó profile còn vào trạng thái hỏng hơn: Chrome ghi `DidStartWorkerFail <id>: 5`
   (`kErrorScriptEvaluationFailed`) ra stderr mà **extension vẫn hiện bình thường, không có badge lỗi**
   — rất dễ chẩn đoán sai thành "code mới bị lỗi". Chứng minh code không phải nguyên nhân: dựng 2
   extension nguyên bản ở profile sạch (`git archive HEAD` cho bản cũ, working tree cho bản mới),
   cả hai đều `DidStartWorkerFail=0`.

   Cách xử lý: **chuyển `<profile>/Default/Service Worker` (ScriptCache + Database) sang một bên rồi
   khởi động lại.** TUYỆT ĐỐI không xoá cả profile — `<profile>/Default/Local Extension Settings/<id>/`
   là nơi chứa API key của người dùng (Gemini/Groq/Cloudflare) và `history`, `ioe_qcache`.

   Xác minh code nào ĐANG chạy (đừng tin file trên đĩa): đánh thức SW từ một **trang extension**
   (`chrome.runtime.sendMessage` từ trang options — gọi từ content script có thể không đủ), rồi đọc
   `Debugger.getScriptSource` và grep các marker. Lưu ý SW MV3 tự tắt khi rảnh nên phải làm trong
   cùng một script, đừng "đánh thức rồi sleep rồi kiểm tra". Số ký tự trên đĩa tính bằng BYTE sẽ lớn
   hơn độ dài JS string (tiếng Việt là 2-3 byte/ký tự) — đừng lấy chênh lệch đó làm bằng chứng sai bản.

## Test trên ioe.vn THẬT

- Đăng nhập → Vào luyện/tu luyện → mở game; bridge bắt `api-edu.go.vn/ioe-service/v2/game/getinfo` (XHR path) → badge "🎮 API N câu" hiện trên pill.
- Bấm **Tự Làm**: classifier đọc dữ liệu API (không đoán theo URL) → dispatch đúng executor (ghép cặp / MCQ / nghe điền từ / trắc nghiệm nhiều câu / nghe True-False).
- Đã verify trực tiếp trên game thật `tai-tao-san-ho` (nghe điền từ, 10 câu): controller path `onEditTextChange` + `onKeyEnterPress` ghi 10/10 câu đúng.
