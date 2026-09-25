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
