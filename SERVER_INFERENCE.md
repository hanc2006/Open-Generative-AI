# Server-only inference fork

This fork is focused on self-hosted inference: run a local inference server on your own machine or a remote GPU host, and connect clients to it. Cloud API keys and vendor-hosted generation are not part of this fork's inference path.

The first server implementation uses **sd.cpp** for image generation. It is a standalone Node.js HTTP service, separate from the browser UI and designed to run locally or on a remote server. See [`server/README.md`](server/README.md) for setup, API endpoints, configuration, and security notes.

The existing web application remains a separate UI at this stage; it is not yet wired to the new server API. Video and Wan2GP inference are also not included in this initial sd.cpp server implementation.
