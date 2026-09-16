/**
 * English Master AI - Popup Logic
 */

// BUG#16: bỏ placeholder "YOUR_API_KEY_HERE" — bản cũ prefill nó vào ô nhập,
// lưu vào storage khi user bấm Lưu mà chưa nhập, và badge dài >10 ký tự nên
// hiện "AI Sẵn sàng" dù KHÔNG có key thật → user tưởng đã cấu hình xong.
const DEFAULT_KEY = "";
// BUG#18: gemini-2.5-flash đã bị Google retire → mặc định model mới nhất đã verify
const DEFAULT_MODEL = "gemini-3.6-flash";

document.addEventListener("DOMContentLoaded", async () => {
  // Elements
  const navTabs = document.querySelectorAll(".nav-tab");
  const tabContents = document.querySelectorAll(".tab-content");
  const statusBadge = document.getElementById("api-status-badge");
  const statusText = document.getElementById("status-text");

  // Solve Tab elements
  const taskTypeSelect = document.getElementById("task-type-select");
  const questionInput = document.getElementById("question-input");
  const solveBtn = document.getElementById("solve-btn");
  const clearInputBtn = document.getElementById("clear-input-btn");
  const quickResultCard = document.getElementById("quick-result-card");
  const quickResultBody = document.getElementById("quick-result-body");
  const copyResultBtn = document.getElementById("copy-result-btn");
  const ttsResultBtn = document.getElementById("tts-result-btn");

  // Settings Tab elements
  const apiKeyInput = document.getElementById("api-key-input");
  const toggleKeyVisibilityBtn = document.getElementById("toggle-key-visibility");
  const saveKeyBtn = document.getElementById("save-key-btn");
  const testKeyBtn = document.getElementById("test-key-btn");
  const testKeyMsg = document.getElementById("test-key-msg");
  const modelSelect = document.getElementById("model-select");
  const autoToolbarToggle = document.getElementById("auto-toolbar-toggle");

  // History Tab elements
  const historyList = document.getElementById("history-list");
  const historySearch = document.getElementById("history-search");
  const clearAllHistoryBtn = document.getElementById("clear-all-history-btn");

  let currentRawResult = "";

  // 1. Tab Switching
  navTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const targetId = tab.getAttribute("data-tab");
      navTabs.forEach(t => t.classList.remove("active"));
      tabContents.forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(targetId)?.classList.add("active");

      if (targetId === "history-tab") {
        renderHistory();
      }
    });
  });

  // 2. Load stored settings & status
  async function loadSettings() {
    const config = await chrome.storage.local.get({
      geminiApiKey: DEFAULT_KEY,
      model: DEFAULT_MODEL,
      autoShowToolbar: true
    });

    const savedKey = normalizeKey(config.geminiApiKey);
    // KHÔNG prefill placeholder vào ô nhập — để trống, placeholder HTML hướng dẫn
    apiKeyInput.value = savedKey;
    modelSelect.value = config.model || DEFAULT_MODEL;
    autoToolbarToggle.checked = config.autoShowToolbar !== false;

    updateStatusBadge(savedKey);
  }

  // Coi placeholder của bản cũ ("YOUR_API_KEY_HERE") như CHƯA CÓ key
  function normalizeKey(k) {
    const s = String(k || "").trim();
    return /^your[_-]?api[_-]?key/i.test(s) ? "" : s;
  }

  function updateStatusBadge(key) {
    const k = normalizeKey(key);
    // BUG#19: Google phát hành key định dạng MỚI "AQ.xxxx..." (48+ ký tự sau dấu
    // chấm) song song với dạng cũ "AIza...". Regex cũ /^AIza[\w-]{20,}$/ từ chối
    // key mới hợp lệ → badge hiện "định dạng lạ" khiến user tưởng key hỏng.
    const isOldFormat = /^AIza[\w-]{20,}$/.test(k.trim());
    const isNewFormat = /^AQ\.[\w-]{20,}$/.test(k.trim());
    if (k && k.trim().length > 10 && (isOldFormat || isNewFormat)) {
      statusBadge.className = "status-indicator ready";
      statusText.textContent = "AI Sẵn sàng (Đã kích hoạt)";
    } else if (k && k.trim().length > 10) {
      statusBadge.className = "status-indicator missing";
      statusText.textContent = "Key đã lưu nhưng định dạng lạ (key Gemini bắt đầu bằng AIza... hoặc AQ....) — bấm Kiểm tra kết nối";
    } else {
      statusBadge.className = "status-indicator missing";
      statusText.textContent = "Chưa có API Key — dán key vào bên dưới rồi bấm Lưu";
    }
  }

  await loadSettings();

  // 3. Settings Tab Events
  toggleKeyVisibilityBtn.addEventListener("click", () => {
    if (apiKeyInput.type === "password") {
      apiKeyInput.type = "text";
      toggleKeyVisibilityBtn.textContent = "🙈";
    } else {
      apiKeyInput.type = "password";
      toggleKeyVisibilityBtn.textContent = "👁️";
    }
  });

  saveKeyBtn.addEventListener("click", async () => {
    const key = normalizeKey(apiKeyInput.value.trim());
    const model = modelSelect.value;
    const autoToolbar = autoToolbarToggle.checked;

    await chrome.storage.local.set({
      geminiApiKey: key,
      model: model,
      autoShowToolbar: autoToolbar
    });

    updateStatusBadge(key);
    if (!key) {
      showTestMsg("Đã lưu nhưng CHƯA có API Key — AI sẽ không giải được. Lấy key miễn phí tại aistudio.google.com/app/apikey, dán vào rồi bấm Lưu & Kiểm tra.", "error");
    } else {
      showTestMsg("Đã lưu cài đặt thành công! Khuyên dùng: bấm 'Kiểm tra kết nối' để chắc chắn key hoạt động.", "success");
    }
  });

  modelSelect.addEventListener("change", async () => {
    await chrome.storage.local.set({ model: modelSelect.value });
  });

  autoToolbarToggle.addEventListener("change", async () => {
    await chrome.storage.local.set({ autoShowToolbar: autoToolbarToggle.checked });
  });

  testKeyBtn.addEventListener("click", () => {
    const key = normalizeKey(apiKeyInput.value.trim());
    const model = modelSelect.value;
    if (!key) {
      showTestMsg("Vui lòng nhập API Key trước khi kiểm tra (lấy miễn phí tại aistudio.google.com/app/apikey).", "error");
      return;
    }

    testKeyBtn.disabled = true;
    testKeyBtn.textContent = "⏳ Đang kiểm tra...";
    testKeyMsg.classList.add("hidden");

    chrome.runtime.sendMessage({
      action: "TEST_API_KEY",
      apiKey: key,
      model: model
    }, (resp) => {
      testKeyBtn.disabled = false;
      testKeyBtn.textContent = "⚡ Kiểm tra kết nối";
      if (resp && resp.success) {
        showTestMsg("Kết nối Gemini API thành công! Key hoạt động hoàn hảo.", "success");
        updateStatusBadge(key);
      } else {
        showTestMsg("Lỗi: " + (resp?.error || "Không thể kết nối."), "error");
      }
    });
  });

  function showTestMsg(text, type) {
    testKeyMsg.textContent = text;
    testKeyMsg.className = `info-msg ${type}`;
    testKeyMsg.classList.remove("hidden");
    setTimeout(() => {
      testKeyMsg.classList.add("hidden");
    }, 4000);
  }

  // 4. Quick Solve Tab Events
  clearInputBtn.addEventListener("click", () => {
    questionInput.value = "";
    quickResultCard.classList.add("hidden");
    currentRawResult = "";
  });

  solveBtn.addEventListener("click", async () => {
    const text = questionInput.value.trim();
    if (!text) {
      alert("Vui lòng nhập đề bài hoặc câu hỏi tiếng Anh.");
      return;
    }

    const taskType = taskTypeSelect.value;
    solveBtn.disabled = true;
    solveBtn.innerHTML = '<span class="spinner-inline"></span> Đang giải bài...';
    quickResultCard.classList.remove("hidden");
    quickResultBody.innerHTML = '<p style="color: #64748b;">AI đang xử lý câu hỏi của bạn...</p>';

    chrome.runtime.sendMessage({
      action: "SOLVE_QUESTION",
      text: text,
      taskType: taskType
    }, (resp) => {
      solveBtn.disabled = false;
      solveBtn.innerHTML = "<span>✨ Giải bài ngay</span>";

      if (resp && resp.success) {
        currentRawResult = resp.data;
        const html = (window.marked && window.marked.parse) ? window.marked.parse(resp.data) : resp.data;
        quickResultBody.innerHTML = html;
      } else {
        quickResultBody.innerHTML = `
          <div style="color: #b91c1c; background: #fef2f2; padding: 10px; border-radius: 6px;">
            <strong>Lỗi:</strong> ${resp?.error || "Không thể kết nối đến AI."}
          </div>
        `;
      }
    });
  });

  copyResultBtn.addEventListener("click", () => {
    if (!currentRawResult && !quickResultBody.innerText) return;
    navigator.clipboard.writeText(quickResultBody.innerText);
    const original = copyResultBtn.textContent;
    copyResultBtn.textContent = "✅";
    setTimeout(() => { copyResultBtn.textContent = original; }, 1500);
  });

  ttsResultBtn.addEventListener("click", () => {
    const text = questionInput.value.trim();
    if (!text) return;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      window.speechSynthesis.speak(utterance);
    }
  });

  // 5. History Tab Logic
  const TASK_LABELS = {
    mcq: "🎯 Trắc nghiệm",
    fill_blank: "✏️ Điền từ",
    grammar_check: "🛠️ Ngữ pháp",
    translate_analyze: "📖 Dịch & Phân tích",
    ioe_auto: "🏆 Giải IOE"
  };

  async function renderHistory(filterText = "") {
    const data = await chrome.storage.local.get({ history: [] });
    const items = data.history || [];
    historyList.innerHTML = "";

    const filtered = items.filter(it => {
      if (!filterText) return true;
      const q = (it.question || "").toLowerCase();
      const a = (it.answer || "").toLowerCase();
      const f = filterText.toLowerCase();
      return q.includes(f) || a.includes(f);
    });

    if (filtered.length === 0) {
      historyList.innerHTML = '<div class="history-empty">Chưa có lịch sử giải bài nào.</div>';
      return;
    }

    filtered.forEach(item => {
      const card = document.createElement("div");
      card.className = "history-item";
      const dateStr = new Date(item.timestamp).toLocaleString("vi-VN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });

      card.innerHTML = `
        <div class="history-meta">
          <span>${TASK_LABELS[item.taskType] || "Giải bài"}</span>
          <span>${dateStr}</span>
        </div>
        <div class="history-question">${escapeHtml(item.question)}</div>
        <div class="history-preview">${escapeHtml(item.answer.slice(0, 150))}...</div>
      `;

      card.addEventListener("click", () => {
        navTabs[0].click();
        questionInput.value = item.question;
        if (taskTypeSelect.querySelector(`option[value="${item.taskType}"]`)) {
          taskTypeSelect.value = item.taskType;
        }
        currentRawResult = item.answer;
        quickResultCard.classList.remove("hidden");
        const html = (window.marked && window.marked.parse) ? window.marked.parse(item.answer) : item.answer;
        quickResultBody.innerHTML = html;
      });

      historyList.appendChild(card);
    });
  }

  historySearch.addEventListener("input", (e) => {
    renderHistory(e.target.value.trim());
  });

  clearAllHistoryBtn.addEventListener("click", async () => {
    if (confirm("Bạn có chắc chắn muốn xóa toàn bộ lịch sử đã giải?")) {
      await chrome.storage.local.set({ history: [] });
      renderHistory();
    }
  });

  function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
});
