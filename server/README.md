# Local sd.cpp inference server

This standalone Node.js server exposes the fork's local image-model catalog and sd.cpp generation over HTTP. It has no Electron dependency and uses Node built-ins only. It can run on the same host as the browser or a remote GPU machine.

## Requirements

- Node.js 18 or newer
- A compatible `sd-cli` executable from [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
- Enough disk space and compatible CPU/GPU memory for the chosen model

## Start

```sh
# Linux/macOS
export SD_CPP_BINARY=/path/to/sd-cli
export OPEN_GENERATIVE_AI_LOCAL_AI_DIR="$HOME/.local/share/open-generative-ai"
node server/server.js
```

On Windows PowerShell, set the same variables with `$env:SD_CPP_BINARY` and `$env:OPEN_GENERATIVE_AI_LOCAL_AI_DIR` before running `node server/server.js`. By default the server binds to `127.0.0.1:3030`; set `HOST` and `PORT` to change this. It does not install or compile sd.cpp automatically: place a compatible binary at `local-ai/bin/sd-cli` (or set `SD_CPP_BINARY`).

## API

- `GET /health` — server and binary status
- `GET /models` — catalog plus downloaded state
- `POST /models/{modelId}/download` — download a catalog model
- `POST /generate` — generate a PNG data URL
- `POST /cancel` — cancel the active generation
- `GET /events` — Server-Sent Events for download and generation progress

Example:

```sh
curl http://127.0.0.1:3030/models
curl -X POST http://127.0.0.1:3030/models/dreamshaper-8/download
curl -X POST http://127.0.0.1:3030/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"dreamshaper-8","prompt":"a mountain lake at sunrise","aspect_ratio":"1:1","steps":20}'
```

Generation accepts `model`, `prompt`, optional `negative_prompt`, `aspect_ratio` (`1:1`, `4:3`, `3:4`, `16:9`, `9:16`), `steps`, `guidance_scale`, and `seed`. One generation runs at a time. Z-Image currently requires the catalog's auxiliary text encoder and VAE files; this server version reports their absence and does not yet expose auxiliary downloads.

## Remote access safety

The default is loopback-only and no token is required. Before binding to a non-loopback host, set a long random `LOCAL_AI_TOKEN`; the server refuses remote binding without one. Clients must send `Authorization: Bearer <token>`. Set `LOCAL_AI_ALLOWED_ORIGINS` to a comma-separated exact origin allowlist when using a browser from another origin. Do not expose this service directly to the public internet; use a trusted VPN or an HTTPS reverse proxy with access controls. Tokens sent over plain HTTP can be intercepted.

Model downloads are restricted to HTTPS Hugging Face URLs and redirects to approved Hugging Face hosts. Model files may be several GB; check available disk space and model licenses before downloading or using them.
