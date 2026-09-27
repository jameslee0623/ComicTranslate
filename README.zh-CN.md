# ComicTranslate（简体中文）

一个适用于 **Firefox 和 Chrome** 的浏览器扩展，用于翻译图片、漫画和条漫中的文字。它会在页面中查找图片，识别文字，翻译后擦除原字，并将译文重新绘制到原来的位置。

## 功能

1. **检测** — 扫描页面中的内容图片，默认跳过图标、头像和缩略图。
2. **识别** — 发送图片进行 OCR，取得文字、位置和检测到的语言。
3. **翻译** — 将识别出的文字翻译为目标语言。
4. **重绘** — 擦除原文字，并将译文排版到原来的气泡和画框中。
5. **替换** — 页面显示翻译后的图片；只有用户选择的翻译引擎会收到图片数据。

翻译结果会缓存，重复阅读同一页面不会再次产生费用。

## 安装

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`
2. 选择 **Load Temporary Add-on…**
3. 选择项目根目录中的 `manifest.json`
4. 重新加载要翻译的页面

### Chrome

Chrome 使用构建目录中的 manifest：

```bash
python3 tools/build.py
```

1. 打开 `chrome://extensions`
2. 开启右上角的 **Developer mode**
3. 选择 **Load unpacked**
4. 选择 `dist/chrome`，不要选择项目根目录
5. 重新加载扩展和网页

## 界面语言

在 **设置 → 语言 → 界面语言** 中选择：

- English
- 简体中文
- 繁體中文
- 日本語
- 한국어

选择“跟随浏览器”时，扩展会使用浏览器的界面语言。

## 翻译引擎

| 引擎 | 说明 |
|---|---|
| **Google Lens（免费）** | 匿名 OCR 与翻译，不需要账户。 |
| **Lens OCR + 本地 AI** | Google Lens 识别文字，只有文字发送到您自己的本地服务器。 |
| **Lens + Lara 文本** | 按发送字符数计费，需要 Lara 凭据。 |
| **Lara 图片（官方）** | Lara 生成整张翻译图片；每张图片固定消耗 10,000 字符。 |
| **Lens OCR + 微软翻译** | 免费额度：每月 2,000,000 字符（约 1,300 页），需要微软账户免费层。 |

免费额度大约能翻译多少页？

- **Google Lens：无限制。**免费匿名，无账户、无配额、无账单。默认引擎。
- **Lens OCR + 微软翻译：每月约 1,300 页。**免费（F0）层每月包含 **2,000,000 字符**，按月重置。额度用尽后服务会停止到下个月；除非把资源升级为付费层，否则不会产生费用。
- **Lens OCR + 本地 AI：无限制。**

### 申请 Microsoft Translator 密钥（免费 F0 层）

`lens-azure` 引擎把免费匿名 Lens OCR 与微软官方 Translator API 组合使用。免费（F0）层每月包含 **2,000,000 字符（约 1,300 页漫画）**，按月重置，用完即停——除非升级资源，否则不会收费。

1. 打开 [Azure 门户](https://portal.azure.com/) 并登录（新账户需要一个 Azure 订阅，免费账户即可）。
2. **创建资源** → 搜索 **Translator** → **创建**。也可以创建 **Azure AI services** 多服务资源，两种都可用。
3. 选择订阅、资源组和**区域（Region）**。就近选择即可（例如 `japaneast`、`westus2`），记下准确的区域值——扩展需要原样填写。
4. **定价层（Pricing tier）** 选择 **Free F0**（每月 200 万字符）。完成创建并等待部署成功。
5. 打开资源 → **密钥和终结点（Keys and Endpoint）**（左侧“资源管理”下）。复制**密钥 1（KEY 1）**（两个密钥都可用）和**位置/区域（Location/Region）**。
   - Translator 单服务资源：使用显示的 **Location**，例如 `japaneast`。
   - 多服务（Azure AI services）资源：填写 **`global`**。
6. 在本扩展中：设置 → 引擎 → **Lens OCR + 微软翻译**，粘贴密钥和区域，然后点击**测试微软密钥**。测试只翻译 1 个字符（`'a'` → `'es'`），仅消耗每月额度中的 1 个字符。
7. 正常翻译即可。只有识别出的字符串会离开浏览器——图片只发给 Google 做 OCR，不会发给微软。

如果测试报 **401**，说明密钥和区域来自不同资源，或区域拼写错误——请从同一个**密钥和终结点**页面重新复制两者。额度用尽后会提示配额消息并停止，直到下个月恢复。

## 隐私

使用免费 Lens 或本地 AI 时，页面图片会发送到 Google 进行 OCR；本地 AI 引擎不会把原图发送到本地服务器，只发送识别出的文字。请求不包含 Cookie 或账户数据。Lara 请求带有 `X-No-Trace`。

## 本地 AI

在设置中选择 **Lens OCR + your own local AI**，填写服务器 URL，然后点击 **测试本地服务器**。支持 LM Studio、Ollama、vLLM 和 llama.cpp 的 OpenAI 兼容 Chat 路由。服务器应返回与输入一一对应的 JSON 翻译数组。

## 验证

```bash
./tools/verify.sh
python3 tools/build.py
```

语言版本： [English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)
