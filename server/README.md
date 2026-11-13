# Local sd.cpp inference server

This standalone Node.js service is an Electron-independent port of the sd.cpp behavior in `electron/lib/localInference.js`. Electron files are intentionally left untouched. The copied server modules provide binary discovery/download, model and auxiliary-file management, generation, cancellation, and progress events over HTTP/SSE.

## Requirements and start

- Node.js 18+
- Automatic engine installation supports macOS arm64, Linux x64/arm64, and Windows x64, subject to available upstream release assets. Other platforms can use a compatible existing binary via `SD_CPP_BINARY`.
- Unix installation requires `unzip`; Windows requires PowerShell with `Expand-Archive`. The selected engine may have additional CPU/GPU and system-library requirements.
- Available disk space and compatible CPU/GPU memory for downloaded models.

```sh
export OPEN_GENERATIVE_AI_LOCAL_AI_DIR="$HOME/.local/share/open-generative-ai"
node server/server.js
```

Defaults to loopback `127.0.0.1:3030`; set `HOST` and `PORT` as needed. Set `LOCAL_AI_ALLOWED_ORIGINS` to the exact web app origin (for example `http://localhost:3000`) before starting the server. Open `/local` in the web app, connect to the server, install the engine, download a model, and download both the text encoder and VAE if using Z-Image. Then generate; no Muapi key is required.

The binary and models are stored under the configured data directory (`bin/`, `models/`, `tmp/`). `SD_CPP_BINARY` overrides discovery and is never overwritten; if the override is missing, fix or unset it before installing. The server follows HTTPS redirects for catalog-selected model URLs and release-selected binaries; clients cannot provide download URLs. Downloads resume on retry where supported and failed partial files are removed. A second download of the same target receives HTTP 409.

## HTTP API (parallels Electron IPC)

| HTTP | Electron IPC counterpart | Description |
|---|---|---|
| `GET /health` or `/status` | `local-ai:binary-status` | Binary and storage status |
| `POST /binary/download` | `local-ai:download-binary` | Find/download/extract compatible sd.cpp binary |
| `GET /models` | `local-ai:list-models` | Models and file/auxiliary status |
| `GET /auxiliaries` | — | Z-Image component status |
| `POST /models/{id}/download` | `local-ai:download-model` | Download a catalog model |
| `POST /auxiliaries/{llm|vae}/download` | `local-ai:download-auxiliary` | Download required Z-Image files (the legacy singular `/auxiliary/` route also works) |
| `DELETE /models/{id}` | `local-ai:delete-model` | Remove model and partial file |
| `POST /generate` | `local-ai:generate` | Run sd.cpp image generation |
| `POST /cancel` | `local-ai:cancel-generation` | Stop the active generation |
| `GET /events` | IPC progress events | SSE download/generation progress |

Generate JSON example:

```json
{"model":"dreamshaper-8","prompt":"a mountain lake at sunrise","aspect_ratio":"1:1","steps":20,"guidance_scale":7.5,"seed":42}
```

The first implementation supports text-to-image. Image-conditioned editing and Wan2GP are not included in this sd.cpp HTTP port.

## Remote access security

The server binds to loopback by default. For non-loopback binding, a `LOCAL_AI_TOKEN` is mandatory; requests use `Authorization: Bearer <token>`. Set `LOCAL_AI_ALLOWED_ORIGINS` to a comma-separated exact origin allowlist for browser access. Use HTTPS or a trusted VPN; do not expose this service directly to the public internet. Bearer tokens sent over plain HTTP can be intercepted. The server trusts HTTPS redirects from its catalog and release sources, including their CDN hosts.

## Browser app

Start the Next.js app separately. The app opens without a MuAPI key; use its **Settings** modal to save or clear the optional MuAPI key and the server URL and token. The URL defaults to `http://127.0.0.1:3030`. Settings are stored in the browser's localStorage (`muapi_key`, `og_local_server_url`, and `og_local_server_token`), so use a trusted browser and device. The cloud app also uses a MuAPI cookie; serve the web app over HTTPS to protect it in transit.

Open **Local Inference** in the header or Settings to reach `/local`. Connect using the saved settings; the page also allows editing them. If health reports a missing binary, install it there, then download a model and any missing Z-Image text encoder and VAE before generating. The `/events` stream reports generation progress, and Cancel stops the active generation. The `/local` page permits HTTP(S) connections to user-configured servers in its Content Security Policy; the rest of the app retains its existing policy. For remote use, the server must allow the exact origin of the browser UI. This API and UI are separate from Electron IPC; other studios still use their existing cloud providers.
