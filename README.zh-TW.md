> [!CAUTION]
> This project has moved. It is now maintained as
> **[comic-translate-4-free](https://github.com/jameslee0623/comic-translate-4-free)** —
> please download the latest builds and report issues there. This repo is archived and will not receive updates.

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
| **Lens OCR + 微軟翻譯** | 免費額度：每月 2,000,000 字元（約 1,300 頁），需要微軟帳戶免費層。 |

免費額度大約能翻譯多少頁？

- **Google Lens：無限制。**免費匿名，無帳戶、無配額、無帳單。預設引擎。
- **Lens OCR + 微軟翻譯：每月約 1,300 頁。**免費（F0）層每月包含 **2,000,000 字元**，按月重置。額度用盡後服務會停止到下個月；除非將資源升級為付費層，否則不會產生費用。
- **Lens OCR + 本機 AI：無限制。**

### 申請 Microsoft Translator 金鑰（免費 F0 層）

`lens-azure` 引擎將免費匿名 Lens OCR 與微軟官方 Translator API 組合使用。免費（F0）層每月包含 **2,000,000 字元（約 1,300 頁漫畫）**，按月重置，用完即停——除非升級資源，否則不會收費。

1. 開啟 [Azure 入口網站](https://portal.azure.com/) 並登入（新帳戶需要一個 Azure 訂用帳戶，免費帳戶即可）。
2. **建立資源** → 搜尋 **Translator** → **建立**。也可以建立 **Azure AI services** 多服務資源，兩種都可用。
3. 選擇訂用帳戶、資源群組和**區域（Region）**。就近選擇即可（例如 `japaneast`、`westus2`），記下準確的區域值——擴充功能需要原樣填寫。
4. **定價層（Pricing tier）** 選擇 **Free F0**（每月 200 萬字元）。完成建立並等候部署成功。
5. 開啟資源 → **金鑰與端點（Keys and Endpoint）**（左側「資源管理」下）。複製**金鑰 1（KEY 1）**（兩個金鑰都可用）和**位置/區域（Location/Region）**。
   - Translator 單一服務資源：使用顯示的 **Location**，例如 `japaneast`。
   - 多服務（Azure AI services）資源：填寫 **`global`**。
6. 在本擴充功能中：設定 → 引擎 → **Lens OCR + 微軟翻譯**，貼上金鑰和區域，然後按一下**測試微軟金鑰**。測試只翻譯 1 個字元（`'a'` → `'es'`），僅消耗每月額度中的 1 個字元。
7. 正常翻譯即可。只有辨識出的字串會離開瀏覽器——圖片只傳送給 Google 做 OCR，不會傳送給微軟。

如果測試回報 **401**，表示金鑰和區域來自不同資源，或區域拼寫錯誤——請從同一個**金鑰與端點**頁面重新複製兩者。額度用盡後會提示配額訊息並停止，直到下個月恢復。

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
