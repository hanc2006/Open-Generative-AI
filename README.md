

## Self-hosted sd.cpp image client

This fork adds a browser-based, no-Muapi-key client at [`/local`](app/local/page.js) for the standalone server in [`server/`](server/README.md). Run the web UI and inference server separately, connect using the server URL, then download a supported model and generate. The client sends generation requests directly from the browser to the configured server; it does not route local generation through Muapi.

The server API in this initial version handles text-to-image only. Reference-image editing, video generation, and other studios still use their existing providers and are not part of this local server feature. For remote browser access, configure `LOCAL_AI_TOKEN`, `LOCAL_AI_ALLOWED_ORIGINS`, and HTTPS as described in [`server/README.md`](server/README.md).
