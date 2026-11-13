

## Self-hosted inference

Run the web app and the standalone [`server/`](server/README.md) separately. Use **Settings** to save an optional MuAPI key and local server URL (default `http://127.0.0.1:3030`) and token. **Local Inference** opens [`/local`](app/local/page.js) for sd.cpp image generation. The Studio's Local Models settings and local image/video models use the same server API, including Wan2GP local-folder and remote MCP modes.

Alternatively, configure `SD_CPP_BINARY` on the server. Binary releases and model files are catalog-controlled; clients cannot supply download URLs. Automatic engine installation supports macOS arm64, Linux x64/arm64, and Windows x64 when compatible release assets are available. Unix needs `unzip`, and Windows needs PowerShell. See the [server setup and API documentation](server/README.md) for requirements, endpoints, and remote access configuration.

The server API handles sd.cpp text-to-image and Wan2GP image/video generation. Cloud-powered studios retain their existing behavior. For remote access, configure `LOCAL_AI_TOKEN`, an exact `LOCAL_AI_ALLOWED_ORIGINS` entry, and HTTPS or a trusted VPN as described in the server README. Never expose an unauthenticated server on a LAN or WAN.
