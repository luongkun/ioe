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
  const preferGroqToggle = document.getElementById("opt-prefer-groq");

  // Load config
  const config = await chrome.storage.local.get({
    geminiApiKey: DEFAULT_KEY,
    model: DEFAULT_MODEL,
    autoShowToolbar: true,
    groqApiKey: "",
    preferProvider: "groq"
  });

  apiKeyInput.value = config.geminiApiKey || DEFAULT_KEY;
  modelSelect.value = config.model || DEFAULT_MODEL;
  autoToolbarToggle.checked = config.autoShowToolbar !== false;
  groqKeyInput.value = config.groqApiKey || "";
  preferGroqToggle.checked = (config.preferProvider || "groq") !== "gemini";

  toggleKeyBtn.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  toggleGroqBtn.addEventListener("click", () => {
    groqKeyInput.type = groqKeyInput.type === "password" ? "text" : "password";
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
      preferProvider: preferGroqToggle.checked ? "groq" : "gemini"
    });

    showMsg("Đã lưu cài đặt thành công!", "success");
  });

  groqTestBtn.addEventListener("click", () => {
    const key = groqKeyInput.value.trim();
    if (!key) {
      showGroqMsg("Vui lòng nhập Groq API Key trước khi kiểm tra.", "error");
      return;
    }
    groqTestBtn.disabled = true;
    groqTestBtn.textContent = "⏳ Đang kiểm tra...";
    chrome.runtime.sendMessage({ action: "TEST_API_KEY", provider: "groq", apiKey: key }, (resp) => {
      groqTestBtn.disabled = false;
      groqTestBtn.textContent = "⚡ Kiểm Tra Groq";
      if (resp && resp.success) {
        showGroqMsg("Groq hoạt động! Từ giờ extension sẽ ưu tiên Groq.", "success");
      } else {
        showGroqMsg("Lỗi: " + (resp?.error || "Không kết nối được."), "error");
      }
    });
  });

  function showGroqMsg(text, type) {
    groqMsgEl.textContent = text;
    groqMsgEl.className = `info-msg ${type}`;
    groqMsgEl.classList.remove("hidden");
    setTimeout(() => groqMsgEl.classList.add("hidden"), 6000);
  }

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
