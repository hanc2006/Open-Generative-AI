

## Self-hosted sd.cpp image client

Run the Next.js web app and the standalone [`server/`](server/README.md) separately. No MuAPI key is required to open the app: use **Settings** to save an optional MuAPI key for cloud studios and the local server URL (default `http://127.0.0.1:3030`) and optional token. Select **Local Inference** in the header or Settings to open [`/local`](app/local/page.js), connect, install sd.cpp if needed, download a model and any required Z-Image components, and generate. Requests go directly from the browser to the configured server, not through MuAPI.

Alternatively, configure `SD_CPP_BINARY` on the server. Binary releases and model files are catalog-controlled; clients cannot supply download URLs. Automatic engine installation supports macOS arm64, Linux x64/arm64, and Windows x64 when compatible release assets are available. Unix needs `unzip`, and Windows needs PowerShell. See the [server setup and API documentation](server/README.md) for requirements, endpoints, and remote access configuration.

The server API handles text-to-image only; other studios retain their existing cloud behavior. Its endpoints cover health/status, binary installation, model and auxiliary downloads, model deletion, generation, cancellation, and SSE events; see the [full API table](server/README.md#http-api-parallels-electron-ipc). For remote access, configure `LOCAL_AI_TOKEN`, an exact `LOCAL_AI_ALLOWED_ORIGINS` entry, and HTTPS or a trusted VPN as described in the server README. Never expose an unauthenticated server on a LAN or WAN.
