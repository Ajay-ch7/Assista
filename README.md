# Assista

**An accessible voice web agent.** Browse the web by speaking, and hear every answer.

Assista is built for people who cannot easily use a screen or a mouse: blind, low-vision and motor-impaired users. A Chrome extension sees the user's real tabs, and a backend server listens, thinks and speaks. You hold a key, ask a question about the page in front of you, release the key, and Assista answers out loud.

> **Status:** Phase 1 (the voice loop) is complete. Assista can answer spoken or typed questions about the current page. Later phases add image description, voice navigation, safe form filling, cost and dark-pattern checks, and page watching. See [implementation.md](implementation.md) for the full roadmap.

---

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Using Assista](#using-assista)
- [Configuration](#configuration)
- [Testing](#testing)
- [Design principles](#design-principles)
- [Roadmap](#roadmap)
- [Deployment](#deployment)

---

## How it works

```
 ┌──────────────────────── Chrome extension (MV3) ────────────────────────┐
 │                                                                         │
 │  Content script            Service worker           Side panel          │
 │  - page snapshot     ◄──►  - message routing  ◄──►  (voice shell)       │
 │  - hidden-text strip       - tabs                   - microphone        │
 │  - redaction               - shortcuts              - audio playback    │
 │  - hold-to-talk key                                  - WebSocket client  │
 └──────────────────────────────────────────────────────────┬──────────────┘
                                                            │ JSON control frames
                                                            │ + binary PCM audio
                                                            ▼
 ┌──────────────────────────── Backend (FastAPI) ─────────────────────────┐
 │  /ws session ──► speech-to-text ──► model (answers from the snapshot)   │
 │                   (Deepgram)          (Gemini)                          │
 │                                          │ streamed one sentence at a   │
 │                                          ▼ time                         │
 │                                     text-to-speech ──► audio back       │
 │                                       (Deepgram)                        │
 └─────────────────────────────────────────────────────────────────────────┘
```

1. The user holds the talk key (Control, by default). The side panel records the microphone and streams 16-bit PCM audio to the backend over one WebSocket.
2. The backend transcribes the speech, then asks the extension for a **page snapshot**: a compact, structured view of the page (roles, names, visible text, form fields, tables, images), built in the content script.
3. Before the snapshot leaves the browser, **sensitive fields are redacted** and **hidden text is stripped**, so secrets and invisible prompt-injection text never reach the server.
4. The model answers from the snapshot. Page content is passed as a delimited data block, never as instructions.
5. The reply streams to text-to-speech **one sentence at a time**, so the user hears the start of the answer while the rest is still being generated.

Every feature also works in **text mode** (typed questions, spoken replies skipped), which is how the automated tests run without a microphone or speakers.

## Features

Available now (Phase 1):

- **Ask about the page.** "What is this page?", "What does this cost?", "Is there a size chart?"
- **Hold-to-talk.** Hold Control for 400 ms to talk, release to send. Escape stops speech. Both keys are configurable.
- **Keyboard shortcuts as a fallback.** `Alt+Shift+A` starts or stops listening and `Alt+Shift+S` stops speech. These also work on pages where content scripts cannot run, such as `chrome://` pages and the new-tab page.
- **Streaming voice replies.** Speech-to-text, then the model, then text-to-speech, streamed end to end.
- **Privacy by default.** Password, OTP, card and PIN fields are redacted on the device.
- **Prompt-injection defence (foundation).** Hidden page text is removed from the snapshot, and page content is always treated as data.
- **Spoken errors.** Every failure ends with a sentence the user hears, never a silent error.

Planned (see [Roadmap](#roadmap)): image and chart description, voice navigation, form filling with read-back, confirmation gates on purchases and submissions, total-cost readout, dark-pattern detection, fine-print summaries, PDF reading, page watching, session-timeout warnings, and a private mode using Chrome's on-device Gemini Nano.

## Tech stack

| Part | Technology |
| --- | --- |
| Extension | Chrome Manifest V3, TypeScript, Vite, Vitest, ESLint, Prettier |
| Backend | Python 3.11+, FastAPI, Uvicorn, Pydantic, managed with [uv](https://docs.astral.sh/uv/) |
| Model | Google Gemini via `google-genai` (swappable behind one interface) |
| Speech | Deepgram streaming speech-to-text (`nova-3`) and text-to-speech (`aura-2`) |
| End-to-end tests | Playwright, loading the real extension against the real backend |

The model and speech providers sit behind small gateway interfaces ([backend/app/llm/gateway.py](backend/app/llm/gateway.py), [backend/app/voice/gateway.py](backend/app/voice/gateway.py)). A `mock` provider exists for each, so tests need no API keys.

## Repository layout

```
Assista/
├── extension/              Chrome extension (Manifest V3, TypeScript, Vite)
│   ├── public/             manifest.json, microphone permission page, audio worklet, cues
│   └── src/
│       ├── background/     service worker: message routing, tabs, shortcuts
│       ├── content/        page snapshot and hold-to-talk key listener
│       ├── panel/          voice shell: microphone, playback, WebSocket client
│       ├── safety/         redaction and hidden-text stripping
│       ├── store/          chrome.storage.local wrappers
│       └── shared/         protocol and snapshot types
├── backend/                Python backend (FastAPI)
│   ├── app/
│   │   ├── main.py         WebSocket endpoint and session state
│   │   ├── agents/         answering from the page snapshot
│   │   ├── llm/            model gateway (Gemini, mock)
│   │   └── voice/          speech gateway (Deepgram, mock), sentence splitter
│   └── tests/              pytest suite and text-mode harness
├── demo-pages/             static test sites
├── e2e/                    Playwright tests that load the built extension
├── .env.example            environment variable template
├── implementation.md       build specification and roadmap
└── DEPLOYMENT.md           setup and deployment guide
```

## Quick start

### Prerequisites

- **Google Chrome** 120 or later
- **Node.js** 22 or later, with npm
- **Python** 3.11 or later
- **uv** (Python package manager): <https://docs.astral.sh/uv/getting-started/installation/>
- API keys:
  - **Gemini**: <https://aistudio.google.com/apikey>
  - **Deepgram**: <https://console.deepgram.com/>

### 1. Clone and configure

```bash
git clone https://github.com/kritikarunam30/Assista.git
cd Assista
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env` and fill in your keys and model names:

```ini
LLM_PROVIDER=gemini
LLM_API_KEY=your-gemini-key
LLM_MODEL=gemini-model-id      # from https://ai.google.dev/gemini-api/docs/models
ROUTER_MODEL=gemini-model-id   # a smaller, faster model

STT_PROVIDER=deepgram
STT_API_KEY=your-deepgram-key
TTS_PROVIDER=deepgram
TTS_API_KEY=your-deepgram-key

BACKEND_WS_URL=ws://127.0.0.1:8000/ws
```

### 2. Start the backend

```bash
cd backend
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Check it is running: <http://127.0.0.1:8000/health> should return `{"status":"ok"}`.

### 3. Build and load the extension

```bash
cd extension
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/dist` folder.

### 4. Try it

1. Open any web page and click the Assista icon in the toolbar. The side panel opens and should say **Ready.**
2. The first time, Assista opens a tab asking for microphone access. Choose **Allow**.
3. Hold **Control**, ask "What is this page?", and release. Assista answers out loud.

You can also type a question in the side panel's text box.

For running on a server, publishing the extension, and troubleshooting, see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Using Assista

| Action | How |
| --- | --- |
| Open Assista | Click the toolbar icon (opens the side panel) |
| Talk | Hold **Control** for 400 ms, speak, then release |
| Cancel a recording | Press any other key while holding the talk key |
| Stop speech | **Escape** |
| Toggle listening (fallback) | **Alt+Shift+A** |
| Stop speech (fallback) | **Alt+Shift+S** |
| Ask by typing | Use the text box in the side panel |

Shortcut keys can be changed at `chrome://extensions/shortcuts`.

## Configuration

All settings come from environment variables, normally set in `.env` at the repository root. Keys are never hard-coded.

| Variable | Used by | Description |
| --- | --- | --- |
| `LLM_PROVIDER` | backend | `gemini`, or `mock` for tests |
| `LLM_API_KEY` | backend | Model provider API key |
| `LLM_MODEL` | backend | Main model id |
| `ROUTER_MODEL` | backend | Smaller, faster model id for routing |
| `STT_PROVIDER` | backend | `deepgram`, or `mock` for tests |
| `STT_API_KEY` | backend | Speech-to-text API key |
| `TTS_PROVIDER` | backend | `deepgram`, or `mock` (silence) for tests |
| `TTS_API_KEY` | backend | Text-to-speech API key (Deepgram can use the same key) |
| `BACKEND_WS_URL` | extension build | WebSocket address the extension connects to. Read **at build time**, so rebuild the extension after changing it. |

## Testing

```bash
# Backend: unit tests and lint
cd backend
uv run pytest
uv run ruff check .

# Extension: unit tests, types and lint
cd extension
npm test
npm run typecheck
npm run lint

# End to end: build the extension first, then run Playwright
cd extension && npm run build
cd ../e2e
npm install
npx playwright install chromium
npm test
```

The end-to-end tests start their own backend (with the mock providers) and a static server for [demo-pages/](demo-pages/), load the built extension into Chromium, and run full text-mode turns. They need no API keys, microphone or speakers.

## Design principles

- **Audio only.** No state is shown only on screen. Every state has a spoken sentence or a sound cue.
- **Text mode first.** Every feature works through typed transcripts, so it can be tested automatically.
- **Page content is data.** Page text goes to the model inside a delimited data block, never as an instruction.
- **Secrets stay on the device.** Redaction happens in the content script, before anything is sent.
- **The gate is code, not a prompt.** Confirmation rules for risky actions run in the extension and cannot be skipped by a model reply.
- **Local commands stay local.** Stop, repeat, slower, faster and spell it are handled in the extension.

## Roadmap

| Phase | Theme | Highlights |
| --- | --- | --- |
| 1 ✅ | Voice loop | Hold-to-talk, streaming speech in and out, page snapshot, answers from the page |
| 2 | Understand | Clutter skipping, page orientation, image description, verbosity and speed, sound cues |
| 3 | Act safely | Voice navigation, form filling with read-back, confirmation gates, private mode, action log |
| 4 | Advise and read | Total-cost readout, dark patterns, fine print, tables and charts, PDF reading |
| 5 | Watch and harden | Page watching, session-timeout warnings, saved details, injection attack tests, Gemini Nano |

Full details, including task dependencies and exit checks, are in [implementation.md](implementation.md).

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for local setup, running the backend on a server with TLS, packaging and publishing the extension, and troubleshooting.
