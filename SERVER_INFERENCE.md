# Server-only inference fork

This fork is focused on self-hosted inference: run a local inference server on your own machine or a remote GPU host, and connect clients to it. Cloud API keys and vendor-hosted generation are not part of this fork's inference path.

The standalone Node.js HTTP service provides sd.cpp image generation and Wan2GP image/video generation, and can run locally or on a remote server. See [`server/README.md`](server/README.md) for setup, API endpoints, configuration, and security notes.

The browser clients connect directly to the configured server. Wan2GP can run from a folder installed on the server host or through Wan2GP's documented MCP server.
