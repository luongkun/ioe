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

  // Load config
  const config = await chrome.storage.local.get({
    geminiApiKey: DEFAULT_KEY,
    model: DEFAULT_MODEL,
    autoShowToolbar: true
  });

  apiKeyInput.value = config.geminiApiKey || DEFAULT_KEY;
  modelSelect.value = config.model || DEFAULT_MODEL;
  autoToolbarToggle.checked = config.autoShowToolbar !== false;

  toggleKeyBtn.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  saveBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    const model = modelSelect.value;
    const autoToolbar = autoToolbarToggle.checked;

    await chrome.storage.local.set({
      geminiApiKey: key,
      model: model,
      autoShowToolbar: autoToolbar
    });

    showMsg("Đã lưu cài đặt thành công!", "success");
  });

  testBtn.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    const model = modelSelect.value;
    if (!key) {
      showMsg("Vui lòng nhập API Key trước khi kiểm tra.", "error");
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = "⏳ Đang kiểm tra...";

    chrome.runtime.sendMessage({
      action: "TEST_API_KEY",
      apiKey: key,
      model: model
    }, (resp) => {
      testBtn.disabled = false;
      testBtn.textContent = "⚡ Kiểm Tra Kết Nối";
      if (resp && resp.success) {
        showMsg("Kết nối thành công! Key hoạt động bình thường.", "success");
      } else {
        showMsg("Lỗi: " + (resp?.error || "Không kết nối được."), "error");
      }
    });
  });

  function showMsg(text, type) {
    msgEl.textContent = text;
    msgEl.className = `info-msg ${type}`;
    msgEl.classList.remove("hidden");
    setTimeout(() => {
      msgEl.classList.add("hidden");
    }, 4000);
  }
});
