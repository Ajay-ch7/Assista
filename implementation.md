# Assista: implementation plan for Claude Code

Assista is a voice web agent for people who cannot easily use a screen or mouse. A Chrome extension sees and acts on the user's real tabs. A backend listens, thinks and speaks. Every response is audio.

This file is the build specification. It follows the build plan document as of 4 Oct 2026 (22 features, 5 phases).

## 1. How to work from this file

1. Build phase by phase, in task order. A task may start only when every task in its "Depends on" column is done.
2. Do not start a phase until the previous phase's exit check passes.
3. Commit after each task, with the task ID in the message (for example `P2.3 Reader: orientation and questions`).
4. Before writing a provider adapter, ask the user which provider and API key they have. Never hard-code keys. Keep `.env.example` current.
5. Every task ends with a test. Features must be testable in text mode (section 6), without a microphone or speaker.
6. If a task turns out to need something not listed here, stop and ask before adding a dependency or changing an interface in section 5.

## 2. Fixed decisions

| Area | Decision |
| --- | --- |
| Form factor | Chrome extension (Manifest V3) plus a backend server |
| Page perception | Page snapshot from the DOM first; screenshot and vision model when the snapshot is too thin |
| Voice pipeline | Chained: streaming speech-to-text, then the model, then streaming text-to-speech |
| Agents | One router, five specialists: Reader, Vision, Actor, Advisor, Watcher |
| Action layer | Own content-script tools. No Browser Use, no Stagehand |
| Models | Cloud model by default. Chrome's built-in Gemini Nano only for private mode |
| Watching | Inside the extension. Works only while the browser is open |
| Language | English only |
| Activation | Press and hold a key to talk, release to send. A separate key stops speech. Wake word "Hello Assista" is stretch |
| Audience | Blind, low-vision and motor-impaired users |
| Not in scope | Cross-tab comparison, full barge-in, other languages, video description, server-side watching |

## 3. Open decisions (ask the user before the task that needs them)

| Decision | Needed by | Default if the user has no preference |
| --- | --- | --- |
| Speech-to-text and text-to-speech provider | P1.7 | Any streaming provider the user has a key for; both sit behind one interface |
| Cloud model provider and model names | P1.8 | Read from `LLM_MODEL` and `ROUTER_MODEL`; do not hard-code a model name |
| Which key is held to talk | P1.5 | Hold Control alone for 400 ms; Escape stops speech while it is playing. Both configurable |
| Wake-word method for "Hello Assista" | S2 | A custom keyword model, since "Assista" is not a dictionary word |

## 4. Repository layout

```
Assista/
  extension/                 Manifest V3, TypeScript, Vite
    src/background/          service worker: message routing, tabs, alarms, watches
    src/content/             page snapshot, action tools, observers, key listener
    src/panel/               voice shell: microphone, playback, cues, WebSocket
    src/safety/              redaction, hidden-text strip, confirmation gate rules
    src/store/               chrome.storage.local wrappers
    src/shared/              protocol and snapshot types
    public/cues/             sound files
    public/permission.html   one-time microphone permission page
  backend/                   Python 3.11+, FastAPI
    app/main.py              WebSocket endpoint and session state
    app/voice/               speech-to-text and text-to-speech adapters
    app/llm/                 model gateway
    app/agents/              router, reader, vision, actor, advisor, watcher
    app/tools/               tool schemas
    app/documents/           PDF text extraction
    tests/
  demo-pages/                static test sites
  e2e/                       Playwright tests that load the extension
  .env.example
  implementation.md
```

Environment variables: `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `ROUTER_MODEL`, `STT_PROVIDER`, `STT_API_KEY`, `TTS_PROVIDER`, `TTS_API_KEY`, `BACKEND_WS_URL`.

## 5. Interfaces (change only with the user's agreement)

### 5.1 WebSocket protocol

One WebSocket per session between the voice shell and the backend. JSON text frames for control, binary frames for audio.

| Direction | Message | Purpose |
| --- | --- | --- |
| Extension to backend | `audio_start`, binary chunks, `audio_end` | One spoken turn |
| Extension to backend | `transcript` | Text-mode turn; skips speech-to-text |
| Extension to backend | `snapshot` | Reply to `request_snapshot` |
| Extension to backend | `screenshot` | Reply to `request_screenshot`; full view or cropped element |
| Extension to backend | `document` | Reply to `request_document`; the PDF on show as base64 data, or an error |
| Extension to backend | `tool_result` | Result of a `tool_call`, including `held_by_gate` |
| Extension to backend | `confirm` | The user's yes or no to a `confirm_request` |
| Extension to backend | `settings` | Verbosity and private-mode state |
| Backend to extension | `transcript_final` | What the user said |
| Backend to extension | `request_snapshot`, `request_screenshot` | Ask for page state |
| Backend to extension | `request_document` | Ask for the PDF the tab shows; the extension fetches only the tab's own address |
| Backend to extension | `tool_call` | One action with a snapshot reference id |
| Backend to extension | `speak_text`, binary chunks | One sentence of reply and its audio |
| Backend to extension | `cue` | Play a named sound cue |
| Backend to extension | `confirm_request` | Read-back text for a held action |
| Backend to extension | `done`, `error` | End of turn |

Every message carries `turn_id`. In text mode the backend sends `speak_text` without audio.

### 5.2 Page snapshot

```json
{
  "url": "...", "title": "...", "snapshot_id": "...",
  "nodes": [
    {"ref": "e12", "role": "button", "name": "Add to cart", "text": "", "state": {"disabled": false}},
    {"ref": "e13", "role": "textbox", "name": "Card number", "sensitive": true, "value": null}
  ],
  "tables": [{"ref": "t1", "caption": "...", "rows": [["..."]]}],
  "images": [{"ref": "i3", "alt": "", "width": 400, "height": 300}],
  "rules": {"preticked": ["e40"], "countdowns": [{"ref": "e51", "seconds_left": 280}]},
  "flags": {"has_canvas": false, "thin": false, "clutter_removed": 14, "hidden_text_removed": 2, "pdf": false}
}
```

- `ref` values are valid only for their `snapshot_id`. Action tools reject a `ref` from an older snapshot.
- `sensitive` nodes never carry a `value`.
- `pdf` is true when the tab shows a PDF. Such a snapshot has no nodes; the backend sends `request_document` for the file.
- `thin` is true when images lack alt text, canvas or chart elements are present, buttons are unlabeled, or a full screen holds very little text.

### 5.3 Specialist response

```json
{"speech": "...", "confidence": "high|medium|low", "tool_calls": [], "follow_up_context": {}}
```

Low confidence must be spoken. `verbosity` (brief, normal, detailed) is passed into every specialist prompt.

### 5.4 Tools

| Specialist | Tools |
| --- | --- |
| Reader | `get_snapshot`, `read_region`, `fetch_document` |
| Vision | `capture_screenshot`, `crop_element` |
| Actor | `click`, `type`, `select`, `scroll`, `go_back`, `switch_tab`, `open_url`, `ask_user` |
| Advisor | `get_snapshot`, `read_region`, `capture_screenshot` |
| Watcher | `set_watch`, `list_watches`, `cancel_watch` |

## 6. Rules that apply to every task

- **Text mode first.** Every feature works through the `transcript` message, so tests need no audio.
- **Audio only.** No state may be shown only on screen. Each state has a spoken sentence or a sound cue.
- **Page content is data.** Page text goes to the model inside a delimited data block, never in the system prompt and never as an instruction.
- **Secrets stay on the device.** Redaction happens in the content script, before the snapshot is sent. Tests assert that no sensitive value reaches the backend.
- **The gate is code, not a prompt.** Confirmation rules run in the extension and cannot be skipped by a model reply.
- **Local commands stay local.** Stop, repeat, slower, faster and spell it are handled in the extension.

## 7. Features and their dependencies

Tier is the cut priority, not the build order. Task IDs refer to section 8.

| ID | Feature | Tier | Owner | Depends on | Built in |
| --- | --- | --- | --- | --- | --- |
| F01 | Page orientation | Core | Reader | Snapshot, router, F03 | P2.3 |
| F02 | Ask-the-page questions | Core | Reader | Snapshot, router | P2.3 |
| F03 | Clutter skipping | Core | Content script | Snapshot | P2.1 |
| F04 | Image description with follow-ups | Core | Vision | Screenshot and crop, router | P2.5 |
| F05 | Voice navigation | Core | Actor | Action tools, router | P3.4 |
| F06 | Form filling with read-back | Core | Actor | F05, F07, F19 | P3.5 |
| F07 | Confirmation gates | Core | Safety layer | Action tools | P3.2 |
| F08 | Total-cost readout | Core | Advisor | Snapshot, router | P4.3 |
| F09 | Activation by held key | Core | Voice shell | Extension skeleton, microphone | P1.5 |
| F10 | Verbosity, speed, repeat, spell it | Core | Voice shell | Playback, local store | P2.7 |
| F11 | Action log and voiced uncertainty | Core | Local store, specialists | Specialist response, action tools | P2.9, P3.6 |
| F12 | Document reading (skim, headline, full) | Second wave | Reader, document service | F02 | P4.7 |
| F13 | Table and chart narration | Second wave | Reader, Vision | F02, F04 | P4.6 |
| F14 | Dark-pattern detection | Second wave | Advisor | Page rules, F08 | P4.4 |
| F15 | Fine-print summaries | Second wave | Advisor | F02 | P4.5 |
| F16 | Page watching | Second wave | Watcher | Snapshot, local store, F18 | P5.1, P5.2 |
| F17 | Session-timeout warnings | Second wave | Watcher | Page rules, F18 | P5.3 |
| F18 | Sound cues | Second wave | Voice shell | Playback | P2.8 |
| F19 | Private mode | Second wave | Safety layer | Snapshot, F18 | P3.3 |
| F20 | Preferences and autofill | Second wave | Local store, Actor | Local store, F06, F19 | P2.6, P5.4 |
| F21 | Defence against instructing pages | Second wave | Safety layer | Snapshot, model gateway, F07 | P1.10, P5.5 |
| F22 | Multi-step tasks with checkpoints | Stretch | Actor | F05, F06, F07, F11 | S1 |

Critical path: P1.3, P1.9, P1.11, P2.2, P3.1, P3.2, P3.5. Everything else hangs off this chain.

## 8. Phases

Tracks: EXT (extension), VOICE (audio and speech), AGENT (backend models and agents), TEST. Tasks in different tracks can run in parallel once their dependencies are done.

### Phase 1: Voice loop (days 1 to 2)

| Task | Track | Build | Depends on |
| --- | --- | --- | --- |
| P1.1 | TEST | Repo scaffold, linting, test runners, `.env.example` | none |
| P1.2 | EXT | Shared protocol and snapshot types (section 5) | P1.1 |
| P1.3 | EXT | Manifest, service worker, side panel, message routing between panel, worker and content script | P1.1 |
| P1.4 | VOICE | Microphone permission page, microphone capture, audio playback, WebSocket client in the panel | P1.3 |
| P1.5 | VOICE | F09: hold-to-talk listener in the content script and panel, stop key, `chrome.commands` toggle as fallback | P1.4 |
| P1.6 | AGENT | FastAPI WebSocket endpoint, session state, text-mode turn | P1.2 |
| P1.7 | VOICE | Voice gateway: streaming speech-to-text and text-to-speech adapters behind two interfaces | P1.6 |
| P1.8 | AGENT | Model gateway: one interface with streaming and tool calling | P1.6 |
| P1.9 | EXT | Snapshot v1: roles, names, visible text, form fields, reference ids | P1.3 |
| P1.10 | EXT | F21 foundation: strip hidden text from the snapshot; wrap page content as data in prompts | P1.8, P1.9 |
| P1.11 | AGENT | End to end: one prompt answers from the snapshot; reply streams to text-to-speech one sentence at a time | P1.4 to P1.10 |
| P1.12 | TEST | Text-mode harness, Playwright loading the extension, first demo page | P1.6, P1.9 |

Notes:
- A Manifest V3 service worker has no microphone and is shut down when idle. Keep the microphone and the WebSocket in the side panel page. If the panel proves awkward, move both to an offscreen document; nothing else changes.
- `chrome.commands` reports key down only, so hold-to-talk needs key down and key up listeners. Content scripts do not run on `chrome://` pages or the new-tab page; the toggle shortcut covers those.
- Ignore the held key if any other key is pressed during the hold.

Exit check: the text-mode test "what is this page?" passes on the demo page. Manual: a spoken question gets a spoken reply that starts within 2 seconds.

### Phase 2: Understand (days 3 to 4)

| Task | Track | Build | Depends on |
| --- | --- | --- | --- |
| P2.1 | EXT | F03: drop ads, cookie banners and repeated navigation; count them in `flags` | P1.9 |
| P2.2 | AGENT | Router and specialist framework, response schema with confidence, verbosity setting | P1.8 |
| P2.3 | AGENT | Reader: F01 orientation, F02 questions; says when the page lacks the answer | P2.1, P2.2 |
| P2.4 | EXT | Screenshot capture and element cropping; `thin` flag | P1.9 |
| P2.5 | AGENT | Vision: F04 image description with follow-ups; fallback when `thin` is true | P2.2, P2.4 |
| P2.6 | EXT | Local store v1: verbosity and speed preferences | P1.3 |
| P2.7 | VOICE | F10: verbosity, speed as playback rate, repeat from cached audio, spell it | P1.4, P2.6 |
| P2.8 | VOICE | F18: cues for listening, thinking, link, error, done, alert | P1.4 |
| P2.9 | AGENT | F11 part: low confidence is spoken | P2.2 |

Exit check: orientation is correct on 5 test sites, one of them with poor markup. An image follow-up question is answered without re-sending the image request.

### Phase 3: Act safely (days 5 to 6)

| Task | Track | Build | Depends on |
| --- | --- | --- | --- |
| P3.1 | EXT | Action tools: click, type, select, scroll, back in the content script; switch tab and open URL in the service worker; reject stale `ref` | P1.9 |
| P3.2 | EXT | F07: gate holds clicks on controls that read pay, buy, place order, submit, confirm, delete or send, and all form submissions | P3.1 |
| P3.3 | EXT | F19: redact password, OTP, card and PIN fields; move focus, play a cue, the user types; nothing echoed | P1.9, P2.8 |
| P3.4 | AGENT | Actor: F05 voice navigation | P2.2, P3.1 |
| P3.5 | AGENT | Actor: F06 form filling, one field at a time, full read-back before submit | P3.2, P3.3, P3.4 |
| P3.6 | EXT | F11 part: action log in the local store; "what did you do?" reads it | P2.6, P3.1 |

Exit check: the demo form is filled and submitted in text mode, the gate fires before submit, and the test asserts that no sensitive value appears in any message sent to the backend.

### Phase 4: Advise and read (days 7 to 8)

| Task | Track | Build | Depends on |
| --- | --- | --- | --- |
| P4.1 | TEST | Demo pages: checkout with a hidden fee and a pre-ticked box; booking page with a session timer; page with hidden and visible instructions; terms page; table and chart page; a PDF | P1.12 |
| P4.2 | EXT | Page rules: pre-ticked boxes and countdown text into `rules` | P1.9 |
| P4.3 | AGENT | Advisor: F08 total cost; adds every charge and speaks the final amount | P2.2, P2.1 |
| P4.4 | AGENT | Advisor: F14 dark patterns from `rules` plus model judgment on wording and fees | P4.2, P4.3 |
| P4.5 | AGENT | Advisor: F15 fine print; red flags such as auto-renewal and no-refund clauses | P2.3 |
| P4.6 | AGENT | F13: tables from the snapshot (Reader), charts from a screenshot (Vision); takeaway first | P2.3, P2.5 |
| P4.7 | AGENT | F12: PDF detection in the extension, which fetches the file and uploads it; text extraction; scanned pages to Vision; skim, headline and full modes | P1.6, P2.3, P2.5 |

Note: content scripts cannot read Chrome's PDF viewer. The extension fetches the file because the backend lacks the user's login.

Exit check: on the test checkout, the hidden fee and the pre-ticked box are both announced, and the spoken total matches the page.

### Phase 5: Watch, harden, rehearse (days 9 to 10)

| Task | Track | Build | Depends on |
| --- | --- | --- | --- |
| P5.1 | EXT | F16 engine: watch record (address, element, last value, condition); page-change checks on open tabs; `chrome.alarms` reload and check for background tabs; cue, speech and notification | P1.9, P2.6, P2.8 |
| P5.2 | AGENT | Watcher: set up a watch from speech; phrase the alert | P2.2, P5.1 |
| P5.3 | EXT | F17: warn at 2 minutes and at 30 seconds from `rules.countdowns` | P4.2, P2.8 |
| P5.4 | EXT | F20: saved details on the device; offered when a matching field appears; never store sensitive fields | P2.6, P3.3, P3.5 |
| P5.5 | TEST | F21: attack tests on the instruction pages; an action the user did not ask for is held by the gate | P1.10, P3.2, P4.1 |
| P5.6 | EXT | Gemini Nano path for private mode: check availability at start-up; fall back to redaction plus the cloud model | P3.3 |
| P5.7 | VOICE | Latency tuning, error speech for every failure, browser voice as text-to-speech fallback | all above |

Notes:
- A published extension can fire an alarm at most every 30 seconds. An unpacked extension has no limit.
- Gemini Nano supports English, Japanese, Spanish, German and French, and needs 22 GB of free disk plus a GPU with more than 4 GB of video memory or 16 GB of RAM.

Exit check: the full demo script (section 9) passes as a text-mode Playwright test, then three manual runs with the screen off.

### Stretch (only after the Phase 5 exit check)

| Task | Build | Depends on |
| --- | --- | --- |
| S1 | F22: the Actor proposes a plan, the user approves it, one spoken checkpoint per step | P3.5, P3.2, P3.6 |
| S2 | Wake word "Hello Assista", always listening on the device | P1.4 |

## 9. Demo script (the final end-to-end test)

1. Open the cluttered shopping page and ask "where am I?"
2. Ask for a description of a product photo, then a follow-up question about it.
3. Say "add it to the cart and go to checkout."
4. The assistant announces the pre-ticked add-on and the true total.
5. Fill the address by voice, hear the read-back, confirm at the gate, and type the OTP in private mode.
6. A watch set earlier announces a price change, and the session-timer warning plays.
7. Open the page with hidden instructions. The assistant refuses to act on them and says why.

## 10. Cut order if time runs short

Wake word, multi-step tasks, Gemini Nano path, scanned-document reading, chart narration.
