# Local inference server

This standalone Node.js service exposes the local inference features over HTTP and SSE. It supports sd.cpp text-to-image models and Wan2GP image/video generation, with Wan2GP either installed on the server host or reached through its MCP API.

## Requirements and start

- Node.js 18+
- Automatic sd.cpp installation supports macOS arm64, Linux x64/arm64, and Windows x64 when upstream release assets are available. Unix needs `unzip`; Windows needs PowerShell with `Expand-Archive`.
- Wan2GP local mode requires a Wan2GP installation and its Python virtual environment on the server host. Remote mode requires Wan2GP's MCP server.
- Sufficient disk space and compatible CPU/GPU memory for model weights.

```sh
export OPEN_GENERATIVE_AI_LOCAL_AI_DIR="$HOME/.local/share/open-generative-ai"
npm run server:local-ai
```

By default the service listens on `127.0.0.1:3030`. Set `HOST` and `PORT` as needed. For browser access, set `LOCAL_AI_ALLOWED_ORIGINS` to the exact web app origin (for example `http://localhost:5173`). In the Studio's **Settings → Local Models**, configure Wan2GP and manage local models.

sd.cpp binaries and models are stored under the configured data directory (`bin/`, `models/`, `tmp/`). `SD_CPP_BINARY` overrides binary discovery and is never overwritten. Wan2GP settings, uploaded inputs, and generated results are stored under `wan2gp/` in the same data directory. Model and binary download URLs are catalog-controlled; clients cannot provide URLs.

## HTTP API

All routes accept the optional bearer token configured through `LOCAL_AI_TOKEN`. JSON routes use JSON request/response bodies unless noted. Progress from both engines is broadcast through `GET /events`.

| Method and path | Description |
|---|---|
| `GET /health` or `/status` | sd.cpp binary and storage status, plus active-generation state |
| `POST /binary/download` | Download and install compatible sd.cpp |
| `GET /models` | sd.cpp model and auxiliary-file status |
| `GET /auxiliaries` | Z-Image text encoder and VAE status |
| `POST /models/{id}/download` | Download a catalog model |
| `POST /auxiliaries/{llm\|vae}/download` | Download a required Z-Image component |
| `DELETE /models/{id}` | Delete an sd.cpp model |
| `POST /generate` | Generate an sd.cpp image |
| `POST /cancel` | Cancel sd.cpp generation |
| `GET /wan2gp/config` | Read Wan2GP folder, Python, and MCP URL settings |
| `POST /wan2gp/config` | Save Wan2GP settings (`{"dir":"","python":"","url":""}`); a folder takes precedence over a URL |
| `POST /wan2gp/check` | Validate local installation (optionally `{"quick":true}`) or probe configured MCP server |
| `POST /wan2gp/probe` | Probe an MCP server (`{"url":"http://host:7866/mcp"}`) |
| `GET /wan2gp/models` | Wan2GP model availability |
| `POST /wan2gp/upload` | Upload a PNG/JPEG/WebP start frame as raw bytes; returns an opaque input ID |
| `POST /wan2gp/generate` | Generate a Wan2GP image or video |
| `POST /wan2gp/cancel` | Cancel Wan2GP generation |
| `GET /wan2gp/media/{runId}/{filename}` | Retrieve a generated result |
| `GET /events` | SSE stream for downloads and generation progress |

sd.cpp generation accepts JSON such as `{"model":"dreamshaper-8","prompt":"a mountain lake at sunrise","aspect_ratio":"1:1","steps":20,"guidance_scale":7.5,"seed":42}`. Wan2GP generation accepts `model`, `prompt`, optional `negative_prompt`, `aspect_ratio`, `steps`, `video_length`, `seed`, and an uploaded input ID in `image` for image-to-video. The generation response identifies the result using `runId`, `filename`, and `mediaType`; use the media route to retrieve it.

## Wan2GP setup

For local mode, enter the Wan2GP directory path as seen by the server host; optionally enter a Python executable path. The default is `<Wan2GP>/venv/bin/python` on Unix or `<Wan2GP>\venv\Scripts\python.exe` on Windows. The browser cannot browse the server's filesystem. Wan2GP downloads model weights on first use.

For remote mode, start Wan2GP's documented MCP server on the GPU host:

```sh
python wgp.py --mcp --mcp-api-version 1 --mcp-transport streamable-http --mcp-host 0.0.0.0 --mcp-port 7866
```

Configure its MCP URL, such as `http://gpu-host:7866/mcp`. The Wan2GP Gradio web UI port (usually 7860) is not a generation API. A local folder takes precedence if both modes are configured.

## Remote access security

The server binds to loopback by default. A non-loopback bind requires `LOCAL_AI_TOKEN`; send it as `Authorization: Bearer <token>`. Set `LOCAL_AI_ALLOWED_ORIGINS` to a comma-separated exact origin allowlist for browser access. Use HTTPS or a trusted VPN; do not expose this service directly to the public internet. The server trusts HTTPS redirects from catalog-selected download sources. Only configure MCP URLs and local install paths you trust.

## Browser app

The browser stores the server URL and token in localStorage (`og_local_server_url` and `og_local_server_token`). Wan2GP and sd.cpp model management and local generation in the Studio use the same HTTP service. Cloud studios continue to use their existing providers.
