/**
 * English Master AI - Options Page Logic
 */
const DEFAULT_KEY = "YOUR_API_KEY_HERE"; // TODO: replace with real key
const DEFAULT_MODEL = "gemini-3.7-flash";

document.addEventListener("DOMContentLoaded", async () => {
  const apiKeyInput = document.getElementById("opt-api-key");
  const toggleKeyBtn = document.getElementById("opt-toggle-key");
  const saveBtn = document.getElementById("opt-save-btn");
  const testBtn = document.getElementById("opt-test-btn");
  const modelSelect = document.getElementById("opt-model");
  const autoToolbarToggle = document.getElementById("opt-auto-toolbar");
  const msgEl = document.getElementById("opt-msg");
  // BUG#46: Groq provider (free tier 1000 req/ngày) — xem service_worker.js.
  const groqKeyInput = document.getElementById("opt-groq-key");
  const toggleGroqBtn = document.getElementById("opt-toggle-groq");
  const groqTestBtn = document.getElementById("opt-groq-test-btn");
  const groqMsgEl = document.getElementById("opt-groq-msg");
  // BUG#48: Cloudflare Workers AI — provider thứ ba, cần CẢ token lẫn Account ID
  // vì URL của Cloudflare có account trong đường dẫn.
  const cfKeyInput = document.getElementById("opt-cf-key");
  const toggleCfBtn = document.getElementById("opt-toggle-cf");
  const cfAccountInput = document.getElementById("opt-cf-account");
  const cfTestBtn = document.getElementById("opt-cf-test-btn");
  const cfMsgEl = document.getElementById("opt-cf-msg");
  const preferProviderSelect = document.getElementById("opt-prefer-provider");

  // Load config
  const config = await chrome.storage.local.get({
    geminiApiKey: DEFAULT_KEY,
    model: DEFAULT_MODEL,
    autoShowToolbar: true,
    groqApiKey: "",
    cfApiKey: "",
    cfAccountId: "",
    preferProvider: "groq"
  });

  apiKeyInput.value = config.geminiApiKey || DEFAULT_KEY;
  modelSelect.value = config.model || DEFAULT_MODEL;
  autoToolbarToggle.checked = config.autoShowToolbar !== false;
  groqKeyInput.value = config.groqApiKey || "";
  cfKeyInput.value = config.cfApiKey || "";
  cfAccountInput.value = config.cfAccountId || "";
  // Bản cũ lưu preferProvider dạng nhị phân ("groq"/"gemini"). Nếu gặp giá trị lạ
  // thì rơi về "groq" thay vì để select trống.
  const savedPrefer = String(config.preferProvider || "groq").toLowerCase();
  preferProviderSelect.value = ["groq", "cloudflare", "gemini"].includes(savedPrefer) ? savedPrefer : "groq";

  toggleKeyBtn.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  toggleGroqBtn.addEventListener("click", () => {
    groqKeyInput.type = groqKeyInput.type === "password" ? "text" : "password";
  });

  toggleCfBtn.addEventListener("click", () => {
    cfKeyInput.type = cfKeyInput.type === "password" ? "text" : "password";
  });

  saveBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    const model = modelSelect.value;
    const autoToolbar = autoToolbarToggle.checked;

    await chrome.storage.local.set({
      geminiApiKey: key,
      model: model,
      autoShowToolbar: autoToolbar,
      groqApiKey: groqKeyInput.value.trim(),
      cfApiKey: cfKeyInput.value.trim(),
      cfAccountId: cfAccountInput.value.trim(),
      preferProvider: preferProviderSelect.value
    });

    showMsg(msgEl, "Đã lưu cài đặt thành công!", "success");
  });

  groqTestBtn.addEventListener("click", () => {
    const key = groqKeyInput.value.trim();
    if (!key) {
      showMsg(groqMsgEl, "Vui lòng nhập Groq API Key trước khi kiểm tra.", "error");
      return;
    }
    runKeyTest(groqTestBtn, "⚡ Kiểm Tra Groq", { provider: "groq", apiKey: key }, groqMsgEl,
      "Groq hoạt động! Extension sẽ dùng Groq theo thứ tự ưu tiên bạn chọn.");
  });

  cfTestBtn.addEventListener("click", () => {
    const key = cfKeyInput.value.trim();
    const accountId = cfAccountInput.value.trim();
    if (!key || !accountId) {
      showMsg(cfMsgEl, "Cần ĐỦ CẢ API Token và Account ID mới kiểm tra được Cloudflare.", "error");
      return;
    }
    runKeyTest(cfTestBtn, "⚡ Kiểm Tra Cloudflare", { provider: "cloudflare", apiKey: key, accountId }, cfMsgEl,
      "Cloudflare hoạt động! Đây là provider dự phòng thứ ba khi Groq và Gemini cạn quota.");
  });

  testBtn.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    const model = modelSelect.value;
    if (!key) {
      showMsg(msgEl, "Vui lòng nhập API Key trước khi kiểm tra.", "error");
      return;
    }
    runKeyTest(testBtn, "⚡ Kiểm Tra Kết Nối", { apiKey: key, model }, msgEl,
      "Kết nối thành công! Key hoạt động bình thường.");
  });

  // Chung cho cả 3 nút kiểm tra: khoá nút trong lúc chờ, nhãn nút phải khôi phục
  // đúng như ban đầu nên nhận label qua tham số (bản cũ hardcode từng nút).
  function runKeyTest(btn, label, payload, msgTarget, successText) {
    btn.disabled = true;
    btn.textContent = "⏳ Đang kiểm tra...";
    chrome.runtime.sendMessage(Object.assign({ action: "TEST_API_KEY" }, payload), (resp) => {
      btn.disabled = false;
      btn.textContent = label;
      if (resp && resp.success) {
        showMsg(msgTarget, successText, "success");
      } else {
        showMsg(msgTarget, "Lỗi: " + ((resp && resp.error) || "Không kết nối được."), "error");
      }
    });
  }

  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = `info-msg ${type}`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 6000);
  }
});
