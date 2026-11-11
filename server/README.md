

## Browser client

The web client route is available at `/local` (for example `http://localhost:3000/local`). It connects to the configured server URL, lists models and their download state, downloads catalog models, generates text-to-image results, displays SSE generation progress, and supports cancellation. It does not require a Muapi key.

For browser access from another origin, the server must allow the exact origin, for example:

```sh
HOST=0.0.0.0 PORT=3030 LOCAL_AI_TOKEN='replace-with-a-long-random-secret' LOCAL_AI_ALLOWED_ORIGINS='https://your-web-ui.example' node server/server.js
```

The UI sends the bearer token stored in browser localStorage to that server. Use HTTPS (or a trusted VPN); do not send the token over public plain HTTP. For a remote deployed UI, `127.0.0.1` refers to the visitor's own computer, so users must enter their server's reachable address.
