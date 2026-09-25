# ComicTranslate（한국어）

**Firefox**와 **Chrome**을 위한 브라우저 확장 프로그램입니다. 페이지의 이미지, 만화, 웹툰에 있는 글자를 찾아 OCR로 읽고 번역한 뒤 원래 글자를 지우고 번역문을 같은 말풍선과 그림자에 다시 그립니다.

## 기능

1. **탐지** — 페이지의 콘텐츠 이미지를 찾고 아이콘과 썸네일은 기본적으로 건너뜁니다.
2. **읽기** — OCR로 글자, 위치, 언어를 인식합니다.
3. **번역** — 읽은 글자를 선택한 언어로 번역합니다.
4. **다시 그리기** — 원래 글자를 지우고 번역문을 말풍선과 그림자 안에 배치합니다.
5. **교체** — 번역된 이미지를 페이지에 표시합니다. 이미지가 전송되는 대상은 사용자가 선택한 번역 엔진뿐입니다.

번역 결과는 캐시되므로 같은 페이지를 다시 읽어도 다시 과금되지 않습니다.

## 설치

### Firefox

1. `about:debugging#/runtime/this-firefox`를 엽니다
2. **Load Temporary Add-on…**을 선택합니다
3. 프로젝트 루트의 `manifest.json`을 선택합니다
4. 번역할 페이지를 새로고침합니다

### Chrome

```bash
python3 tools/build.py
```

1. `chrome://extensions`를 엽니다
2. 오른쪽 위의 **Developer mode**를 켭니다
3. **Load unpacked**를 선택합니다
4. 프로젝트 루트가 아니라 `dist/chrome`을 선택합니다
5. 확장 프로그램과 페이지를 새로고침합니다

## 인터페이스 언어

**설정 → 언어 → 인터페이스 언어**에서 English、简体中文、繁體中文、日本語、한국어 중 하나를 선택하세요. **브라우저와 일치**를 선택하면 브라우저 언어를 사용합니다.

## 번역 엔진

| 엔진 | 설명 |
|---|---|
| **Google Lens(무료)** | 익명 OCR와 번역이며 계정이 필요 없습니다. |
| **Lens OCR + 내 로컬 AI** | Lens가 글자를 읽고 추출한 문자열만 사용자의 로컬 서버로 보냅니다. |
| **Lens + Lara 텍스트** | 실제 전송한 문자 수로 과금되며 Lara 자격 증명이 필요합니다. |
| **Lara 이미지(공식)** | Lara가 전체 번역 이미지를 생성하며 이미지당 10,000문자입니다. |

## 개인정보 보호

무료 Lens와 로컬 AI는 OCR을 위해 이미지를 Google에 전송합니다. 로컬 AI 엔진은 원본 이미지가 아니라 OCR로 읽은 문자열만 전송합니다. 요청에는 쿠키나 계정 정보가 포함되지 않습니다. Lara 요청에는 `X-No-Trace`가 포함됩니다.

## 로컬 AI

설정에서 **Lens OCR + your own local AI**를 선택하고 서버 URL을 입력한 뒤 **로컬 서버 테스트**를 누르세요. LM Studio, Ollama, vLLM, llama.cpp의 OpenAI 호환 Chat 경로를 지원합니다. 서버는 입력과 같은 순서의 JSON 번역 배열을 반환해야 합니다.

## 검증

```bash
./tools/verify.sh
python3 tools/build.py
```

언어: [English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)
