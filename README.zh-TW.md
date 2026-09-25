# ComicTranslate（繁體中文）

一個適用於 **Firefox 和 Chrome** 的瀏覽器擴充功能，用於翻譯圖片、漫畫和條漫中的文字。它會在頁面中尋找圖片、辨識文字，翻譯後擦除原字，並將譯文重新繪製到原本的位置。

## 功能

1. **偵測** — 掃描頁面中的內容圖片，預設略過圖示、縮圖和頭像。
2. **辨識** — 傳送圖片進行 OCR，取得文字、位置和偵測到的語言。
3. **翻譯** — 將辨識出的文字翻譯為目標語言。
4. **重繪** — 擦除原文字，並將譯文排版到原本的對話框和畫框中。
5. **替換** — 頁面顯示翻譯後的圖片；只有您選擇的翻譯引擎會收到圖片資料。

翻譯結果會快取，重複閱讀同一頁面不會再次產生費用。

## 安裝

### Firefox

1. 開啟 `about:debugging#/runtime/this-firefox`
2. 選擇 **Load Temporary Add-on…**
3. 選擇專案根目錄中的 `manifest.json`
4. 重新載入要翻譯的頁面

### Chrome

Chrome 使用建置目錄中的 manifest：

```bash
python3 tools/build.py
```

1. 開啟 `chrome://extensions`
2. 開啟右上角的 **Developer mode**
3. 選擇 **Load unpacked**
4. 選擇 `dist/chrome`，不要選擇專案根目錄
5. 重新載入擴充功能和網頁

## 介面語言

在 **設定 → 語言 → 介面語言** 中選擇 English、繁體中文、日本語或한국어。选择「跟隨瀏覽器」時，擴充功能會使用瀏覽器的介面語言。

## 翻譯引擎

| 引擎 | 說明 |
|---|---|
| **Google Lens（免費）** | 匿名 OCR 與翻譯，不需要帳戶。 |
| **Lens OCR + 本機 AI** | Google Lens 辨識文字，只有文字傳送到您自己的本機伺服器。 |
| **Lens + Lara 文字** | 依實際傳送的字元計費，需要 Lara 憑證。 |
| **Lara 圖片（官方）** | Lara 產生整張翻譯圖片；每張圖片固定消耗 10,000 字元。 |

## 隱私

使用免費 Lens 或本機 AI 時，頁面圖片會傳送到 Google 進行 OCR；本機 AI 引擎不會把原圖傳送到本機伺服器，只傳送辨識出的文字。請求不包含 Cookie 或帳戶資料。Lara 請求帶有 `X-No-Trace`。

## 本機 AI

在設定中選擇 **Lens OCR + your own local AI**，填寫伺服器 URL，然後按一下 **測試本機伺服器**。支援 LM Studio、Ollama、vLLM 和 llama.cpp 的 OpenAI 相容 Chat 路由。伺服器應回傳與輸入一一對應的 JSON 翻譯陣列。

## 驗證

```bash
./tools/verify.sh
python3 tools/build.py
```

語言版本： [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)
