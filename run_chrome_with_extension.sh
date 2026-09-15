#!/usr/bin/env bash
# =============================================================================
# English Master AI & IOE - Test launcher
# Mở Chrome/Chromium với extension đã nạp sẵn (unpacked) để test trực tiếp.
#
# Cách dùng:
#   bash run_chrome_with_extension.sh
#
# LƯU Ý QUAN TRỌNG:
#  - Từ Chrome 137 (2025), Google Chrome bản chính thức ĐÃ BỎ hỗ trợ cờ
#    --load-extension. Nếu chrome://extensions KHÔNG thấy "English Master AI"
#    thì bạn phải nạp thủ công (xem bước ở cuối file).
#  - Tab đầu tiên có thể tải trang TRƯỚC khi extension kịp nạp -> hãy nhấn
#    F5 tải lại trang ioe.vn một lần rồi mới kiểm tra.
# =============================================================================
set -uo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$EXT_DIR/.test-profile"

BROWSERS=(
  "chromium"
  "chromium-browser"
  "google-chrome"
  "google-chrome-stable"
  "brave-browser"
  "brave"
  "microsoft-edge"
  "microsoft-edge-stable"
)

BIN=""
for b in "${BROWSERS[@]}"; do
  if command -v "$b" >/dev/null 2>&1; then
    BIN="$b"
    break
  fi
done

if [ -z "$BIN" ]; then
  echo "❌ Không tìm thấy Chrome/Chromium/Edge trong PATH."
  echo "👉 Nạp thủ công: chrome://extensions -> Developer mode -> 'Load unpacked'"
  echo "   -> chọn thư mục: $EXT_DIR"
  exit 1
fi

echo "🌐 Trình duyệt : $BIN"
echo "🧩 Extension   : $EXT_DIR"
echo "🗂  Profile     : $PROFILE_DIR"

"$BIN" \
  --load-extension="$EXT_DIR" \
  --disable-extensions-except="$EXT_DIR" \
  --user-data-dir="$PROFILE_DIR" \
  "chrome://extensions" \
  "https://ioe.vn/tu-luyen" >/dev/null 2>&1 &

echo ""
echo "✅ Đã mở trình duyệt với 2 tab: chrome://extensions và ioe.vn/tu-luyen."
echo ""
echo "🔎 KIỂM TRA NGAY Ở TAB chrome://extensions:"
echo "   1) Nếu CÓ thẻ 'English Master AI - Trợ Lý Giải Bài Tiếng Anh & IOE'"
echo "      và đang bật (toggle xanh) -> OK. Chuyển sang tab ioe.vn, NHẤN F5"
echo "      để tải lại trang -> tìm thanh nổi 'English Master v2.11.0'."
echo "   2) Nếu KHÔNG thấy thẻ extension nào -> Chrome của bạn đã bỏ hỗ trợ"
echo "      --load-extension. Hãy nạp THỦ CÔNG:"
echo "        • Bấm 'Developer mode' (góc trên phải) nếu chưa bật"
echo "        • Bấm 'Load unpacked' -> chọn thư mục: $EXT_DIR"
echo "        • Quay lại tab ioe.vn, nhấn F5"
echo "   3) Nếu thẻ extension có nút đỏ 'Errors' -> bấm vào và gửi nội dung lỗi."
echo ""
echo "ℹ️  Xem log nền: trên thẻ extension bấm 'service worker';"
echo "    Xem log trang: trên tab ioe.vn nhấn F12 -> tab Console."