

## Self-hosted sd.cpp image client

This fork adds a browser-based, no-Muapi-key client at [`/local`](app/local/page.js) for the standalone server in [`server/`](server/README.md). Run the web UI and inference server separately, allow the web origin, and connect using the server URL. Install sd.cpp from the client (or configure `SD_CPP_BINARY`), download a supported model and, for Z-Image, its text encoder and VAE, then generate. Binary releases and model files are catalog-controlled; clients cannot supply download URLs. The client sends requests directly to the configured server, not Muapi.

Automatic engine installation supports macOS arm64, Linux x64/arm64, and Windows x64 when compatible release assets are available. Unix needs `unzip`, and Windows needs PowerShell. See the [server setup and API documentation](server/README.md) for requirements, endpoints, and remote access configuration.

The server API in this initial version handles text-to-image only. Reference-image editing, video generation, and other studios still use their existing providers and are not part of this local server feature. For remote browser access, configure `LOCAL_AI_TOKEN`, `LOCAL_AI_ALLOWED_ORIGINS`, and HTTPS as described in [`server/README.md`](server/README.md).
