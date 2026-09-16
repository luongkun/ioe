# Test Suite — English Master AI (IOE Extension)

Hạ tầng test E2E cho extension trên Chromium thật (không headless-new vì nó **không inject content script**).

## Cấu trúc

| File | Mục đích |
|------|----------|
| `test_extension.js` | Suite 12 test trên trang giả lập (pill inject, bridge inject, anti-copy, MCQ solve+autoclick, F2, fill, reorder, mixed, pageerror) |
| `test_fillword.js` | Suite 11 test E2E dạng **nghe điền từ** (EditBox Cocos) + **trắc nghiệm nhiều câu** + cache câu hỏi + chip click không ReferenceError |
| `debug_fillword_e2e.js` | Debug 1 trang fillword: dump console, bridge state, panel chips, game state — dùng khi cần soi pipeline từng bước |
| `mock-pages/` | Trang giả lập IOE + runtime Cocos giả (`mock_cocos_runtime.js`) — phục vụ từ file server test |
| `mock_gemmai_snippet.js` | Block `MOCK_GEMINI` chèn vào service worker bản test — mô phỏng Gemini trả đáp án theo từ khoá prompt, không cần API key |

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
   ```

## Bài học môi trường (ĐÃ VỠ TÊN, ĐỪNG LẶP LẠI)

1. **`browser.close()` với `connectOverCDP` chỉ DISCONNECT — Chrome vẫn sống.** Phải `pkill` Chrome/Xvfb stale trước mỗi lần chạy, nếu không CDP sẽ connect vào Chrome CŨ (extension code cũ + profile cũ) → kết test sai lệch một cách "bí ẩn" (đã xảy ra: mock mới không có tác dụng dù code đúng). Cả 2 script hiện đã tự pkill ở đầu.
2. `headless=new` không inject content script → phải dùng Xvfb headed.
3. Playwright tự chèn `--disable-extensions` → phải `ignoreDefaultArgs: ['--disable-extensions']` (khi launch qua Playwright; script này tự spawn Chrome nên không cần).
4. `/dev/shm` 64MB làm renderer crash → `--disable-dev-shm-usage`; WebGL cho Cocos cần `--use-angle=swiftshader` (nếu test game thật).
5. Token game IOE **single-use**: mở lại tab game cũ → getinfo trả "Bạn không có quyền" (bridge giờ phát sự kiện GETINFO_ERROR và UI báo F5).

## Test trên ioe.vn THẬT

- Đăng nhập → Vào luyện/tu luyện → mở game; bridge bắt `api-edu.go.vn/ioe-service/v2/game/getinfo` (XHR path) → badge "🎮 API N câu" hiện trên pill.
- Bấm **Tự Làm**: classifier đọc dữ liệu API (không đoán theo URL) → dispatch đúng executor (ghép cặp / MCQ / nghe điền từ / trắc nghiệm nhiều câu / nghe True-False).
- Đã verify trực tiếp trên game thật `tai-tao-san-ho` (nghe điền từ, 10 câu): controller path `onEditTextChange` + `onKeyEnterPress` ghi 10/10 câu đúng.
