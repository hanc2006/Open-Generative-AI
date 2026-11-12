# Local sd.cpp inference server

This standalone Node.js service is an Electron-independent port of the sd.cpp behavior in `electron/lib/localInference.js`. Electron files are intentionally left untouched. The copied server modules provide binary discovery/download, model and auxiliary-file management, generation, cancellation, and progress events over HTTP/SSE.

## Requirements and start

- Node.js 18+
- A compatible `sd-cli` binary can be downloaded by the server, or point `SD_CPP_BINARY` to an existing one.
- Available disk space and compatible CPU/GPU memory for downloaded models.

```sh
export OPEN_GENERATIVE_AI_LOCAL_AI_DIR="$HOME/.local/share/open-generative-ai"
node server/server.js
```

Defaults to loopback `127.0.0.1:3030`; set `HOST` and `PORT` as needed. The binary and models are stored under the configured data directory (`bin/`, `models/`, `tmp/`). The server can install the sd.cpp CLI with `POST /binary/download`.

## HTTP API (parallels Electron IPC)

| HTTP | Electron IPC counterpart | Description |
|---|---|---|
| `GET /health` or `/status` | `local-ai:binary-status` | Binary and storage status |
| `POST /binary/download` | `local-ai:download-binary` | Find/download/extract compatible sd.cpp binary |
| `GET /models` | `local-ai:list-models` | Models and file/auxiliary status |
| `POST /models/{id}/download` | `local-ai:download-model` | Download a catalog model |
| `POST /auxiliary/{llm|vae}/download` | `local-ai:download-auxiliary` | Download required Z-Image files |
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

The server binds to loopback by default. For non-loopback binding, a `LOCAL_AI_TOKEN` is mandatory; requests use `Authorization: Bearer <token>`. Set `LOCAL_AI_ALLOWED_ORIGINS` to a comma-separated exact origin allowlist for browser access. Use HTTPS or a trusted VPN; do not expose this service directly to the public internet. Bearer tokens sent over plain HTTP can be intercepted. Model downloads are limited to HTTPS Hugging Face model URLs and approved Hugging Face redirect hosts.

## Browser app

The current browser client lives at `/local`. Configure the server URL/token there. For remote use, the server must allow the exact origin of the browser UI. This API and UI are separate from Electron IPC, but provide equivalent sd.cpp commands over HTTP.
