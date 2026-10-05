# Deploying Assista

This guide covers three setups:

1. [Local development](#1-local-development): backend and extension on your own machine.
2. [Backend on a server](#2-running-the-backend-on-a-server): a hosted backend reached over a secure WebSocket (`wss://`).
3. [Distributing the extension](#3-distributing-the-extension): sharing a packaged build or publishing to the Chrome Web Store.

Assista has two parts, and they are deployed separately:

| Part | What it is | Where it runs |
| --- | --- | --- |
| Backend | Python FastAPI server with one WebSocket endpoint (`/ws`) and a health check (`/health`) | Your machine or a server |
| Extension | Chrome Manifest V3 extension, built with Vite into `extension/dist` | The user's Chrome browser |

The extension finds the backend through `BACKEND_WS_URL`, which is **baked in when the extension is built**. Whenever the backend address changes, rebuild the extension.

---

## Prerequisites

| Tool | Version | Install |
| --- | --- | --- |
| Google Chrome | 120 or later | <https://www.google.com/chrome/> |
| Node.js and npm | 22 or later | <https://nodejs.org/> |
| Python | 3.11 or later | <https://www.python.org/downloads/> |
| uv | latest | <https://docs.astral.sh/uv/getting-started/installation/> |
| Git | any | <https://git-scm.com/> |

API keys:

- **Gemini** (model): <https://aistudio.google.com/apikey>. Pick model ids from <https://ai.google.dev/gemini-api/docs/models>.
- **Deepgram** (speech-to-text and text-to-speech; one key covers both): <https://console.deepgram.com/>

Check your tools:

```bash
node --version
python --version
uv --version
```

---

## 1. Local development

### Step 1: Get the code

```bash
git clone https://github.com/kritikarunam30/Assista.git
cd Assista
```

### Step 2: Create the environment file

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Fill in `.env`:

```ini
LLM_PROVIDER=gemini
LLM_API_KEY=<your Gemini key>
LLM_MODEL=<main Gemini model id>
ROUTER_MODEL=<smaller, faster Gemini model id>

STT_PROVIDER=deepgram
STT_API_KEY=<your Deepgram key>
TTS_PROVIDER=deepgram
TTS_API_KEY=<your Deepgram key>

BACKEND_WS_URL=ws://127.0.0.1:8000/ws
```

`.env` is listed in `.gitignore`. Never commit it.

> To try Assista without any keys, set `LLM_PROVIDER=mock`, `STT_PROVIDER=mock` and `TTS_PROVIDER=mock`. You get canned answers and silent audio, which is enough to check that the extension and backend are wired together.

### Step 3: Install and start the backend

```bash
cd backend
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`uv sync` creates `backend/.venv` and installs the locked dependencies from `uv.lock`. The backend reads `.env` from the repository root, so you do not need to copy it into `backend/`.

For automatic reloads while editing code, add `--reload`.

Check it in a second terminal:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}
```

### Step 4: Build the extension

```bash
cd extension
npm install
npm run build
```

This writes the unpacked extension to `extension/dist/`, using `BACKEND_WS_URL` from the root `.env`.

### Step 5: Load the extension in Chrome

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `extension/dist`.
4. Optional: pin Assista to the toolbar from the puzzle-piece menu.

After each rebuild, click the **reload** icon on the Assista card in `chrome://extensions`, then reload any open tabs so the new content script is injected.

### Step 6: Grant microphone access and test

1. Open a normal web page (not `chrome://` or the new-tab page).
2. Click the Assista icon. The side panel opens and should say **Ready.**
3. The first time you talk, Assista opens a permission tab. Choose **Allow** for the microphone.
4. Hold **Control** for about half a second, ask "What is this page?", and release.

If the panel says **Not connected to the Assista server**, see [Troubleshooting](#troubleshooting).

### Step 7: Run the tests (optional but recommended)

```bash
# Backend
cd backend
uv run pytest
uv run ruff check .

# Extension
cd ../extension
npm test
npm run typecheck
npm run lint

# End to end (needs a fresh extension build)
npm run build
cd ../e2e
npm install
npx playwright install chromium
npm test
```

The end-to-end suite starts its own mock backend on port 8765 and a demo-page server on port 8787, so stop anything already using those ports first. It needs no API keys.

---

## 2. Running the backend on a server

Use this when users should not have to run Python themselves. The extension then connects to your server instead of `127.0.0.1`.

### 2.1 Requirements

- A Linux server (or any host that runs Python 3.11+), such as a small VM on any cloud provider.
- A domain name pointing at the server, for example `assista.example.com`.
- TLS. Chrome extensions should talk to a remote server over `wss://`, not plain `ws://`.

### 2.2 Install the backend

```bash
# On the server
curl -LsSf https://astral.sh/uv/install.sh | sh
git clone https://github.com/kritikarunam30/Assista.git /opt/assista
cd /opt/assista
cp .env.example .env
nano .env                  # add the keys; BACKEND_WS_URL is not used by the server
cd backend
uv sync --no-dev
```

Test that it starts:

```bash
uv run --no-dev uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Keep it bound to `127.0.0.1` and put a reverse proxy in front for TLS (next step). Uvicorn runs one worker here; each WebSocket is one session held in memory, so do not put multiple workers behind a load balancer without sticky connections.

### 2.3 Run it as a service (systemd)

Create `/etc/systemd/system/assista.service`:

```ini
[Unit]
Description=Assista backend
After=network-online.target

[Service]
WorkingDirectory=/opt/assista/backend
ExecStart=/root/.local/bin/uv run --no-dev uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
```

Adjust the `uv` path (`which uv`) and run as a non-root user if you prefer. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now assista
sudo systemctl status assista
journalctl -u assista -f        # live logs
```

### 2.4 Add TLS with a reverse proxy

**Option A: Caddy** (fetches certificates automatically). `/etc/caddy/Caddyfile`:

```
assista.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

```bash
sudo systemctl reload caddy
```

Caddy proxies WebSockets with no extra settings.

**Option B: Nginx** with a Let's Encrypt certificate (`certbot --nginx`):

```nginx
server {
    listen 443 ssl;
    server_name assista.example.com;

    # ssl_certificate and ssl_certificate_key are added by certbot

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_read_timeout 3600s;
    }
}
```

The `Upgrade` and `Connection` headers are required for WebSockets, and the long `proxy_read_timeout` stops idle sessions being cut after 60 seconds. Keep the `Origin` header intact: the backend uses it to accept only the extension.

Check it from your own machine:

```bash
curl https://assista.example.com/health
```

### 2.5 Optional: run in Docker

The repository does not ship a Dockerfile yet. A minimal one, placed in `backend/`, looks like this:

```dockerfile
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --frozen
COPY app ./app
EXPOSE 8000
CMD ["uv", "run", "--no-dev", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
```

```bash
cd backend
docker build -t assista-backend .
docker run -d --name assista -p 127.0.0.1:8000:8000 --env-file ../.env --restart unless-stopped assista-backend
```

Pass keys with `--env-file` or your platform's secret store. Do not copy `.env` into the image.

Any container platform that supports WebSockets (for example Google Cloud Run, Fly.io, Render or Azure Container Apps) can run this image. Set the same environment variables there and use the HTTPS address it gives you.

### 2.6 Point the extension at the server

On your build machine, set the address in the root `.env`:

```ini
BACKEND_WS_URL=wss://assista.example.com/ws
```

Rebuild and reload:

```bash
cd extension
npm run build
```

Then reload the extension in `chrome://extensions`.

### 2.7 Security notes for a public backend

- **The `/ws` endpoint has no user authentication yet.** It rejects connections from web pages (any browser `Origin` that is not `chrome-extension://`), but a script that sends no `Origin` header can still connect and use your API keys. Before exposing it publicly, restrict access: put it behind a VPN or IP allowlist, add an auth token at the proxy, or keep the backend on `localhost` for personal use.
- Set usage limits and billing alerts on your Gemini and Deepgram accounts.
- Keep keys in environment variables or a secret manager. Never commit `.env` or bake keys into an image.
- Sensitive form values are redacted in the browser before they reach the backend, so the server never receives passwords, OTPs, card numbers or PINs.

---

## 3. Distributing the extension

### 3.1 Share a build with testers

```bash
cd extension
npm run build
```

Zip the **contents** of `extension/dist` (so `manifest.json` is at the top level of the zip):

```bash
cd dist && zip -r ../assista-extension.zip . && cd ..
```

On Windows PowerShell:

```powershell
Compress-Archive -Path extension\dist\* -DestinationPath assista-extension.zip -Force
```

Testers unzip it and use **Load unpacked** in `chrome://extensions` with Developer mode on. Make sure `BACKEND_WS_URL` pointed at a backend they can reach when you built it.

### 3.2 Publish to the Chrome Web Store

1. Bump `version` in [extension/public/manifest.json](extension/public/manifest.json) (and in `extension/package.json` to keep them in step).
2. Build against your production backend (`BACKEND_WS_URL=wss://...`) and zip `extension/dist` as above.
3. Register at the Chrome Web Store Developer Dashboard: <https://chrome.google.com/webstore/devconsole> (one-time fee).
4. Upload the zip, then complete the store listing: description, screenshots, icon, category, and a privacy policy.
5. Fill in the privacy and permission justifications. Assista requests:
   - `sidePanel`: the voice shell lives in the side panel.
   - `tabs`, `scripting`: read and act on the user's current tab.
   - `storage`: save key and voice preferences on the device.
   - `<all_urls>` host access and a content script on all pages: Assista must read whatever page the user asks about.
   - Microphone use, through the permission page, for voice input.
6. Submit for review. Broad host permissions usually mean a longer review, so explain the accessibility purpose clearly.

Notes:

- The manifest does not yet include toolbar icons. Add `icons` (16, 32, 48 and 128 px) before publishing.
- Once published, the extension id is fixed. Users of the store version and of unpacked builds have different ids; the backend accepts both because it checks only for the `chrome-extension://` prefix.

---

## Updating a deployment

```bash
git pull

# Backend
cd backend
uv sync --no-dev
sudo systemctl restart assista          # or: docker build ... && docker restart assista

# Extension
cd ../extension
npm install
npm run build
# reload in chrome://extensions, or upload a new version to the Web Store
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Panel says **Not connected to the Assista server** | Backend not running, or wrong `BACKEND_WS_URL` in the build | Check `/health`. Fix `.env`, run `npm run build`, reload the extension. |
| Assista says **"The Assista server is not fully set up yet."** | A provider or key is missing from `.env` | Set `LLM_PROVIDER`, `STT_PROVIDER`, `TTS_PROVIDER` and their keys, then restart the backend. The backend log names the missing variable. |
| **"I can't read this page."** | The tab is a `chrome://` page, the new-tab page, the Web Store, or a PDF | Try on a regular web page. Content scripts cannot run on these pages. |
| **"The page did not answer in time."** | The tab was open before the extension was loaded or reloaded | Reload the tab so the content script is injected. |
| Holding Control does nothing | Focus is in the address bar, or another key was pressed during the hold | Click into the page first, or use **Alt+Shift+A**. Hold Control alone for at least 400 ms. |
| **"I could not hear that."** | Microphone blocked, or Deepgram key invalid | Allow the microphone for the extension; check `STT_API_KEY`. |
| Text answers arrive but there is no sound | TTS key invalid, or the tab's audio is muted | Check `TTS_API_KEY` and the system volume. |
| WebSocket drops after about a minute behind Nginx | Default proxy timeout | Set `proxy_read_timeout 3600s` and the `Upgrade`/`Connection` headers. |
| WebSocket closes immediately with code 1008 | The connection came from a web page origin | Only the extension may connect. Do not open `/ws` from a web page. |
| E2E tests fail to start | Ports 8765 or 8787 already in use, or the extension was not built | Free the ports and run `npm run build` in `extension/` first. |

To test the panel against a different backend without rebuilding, open the panel page with a `backend` query parameter, for example `chrome-extension://<extension-id>/src/panel/index.html?backend=ws://127.0.0.1:9000/ws`. The end-to-end tests use this.
