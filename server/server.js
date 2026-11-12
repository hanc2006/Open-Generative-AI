'use strict';

// HTTP adapter over server/inference.js. The server runtime is a plain Node
// port of Electron's local inference behavior; Electron files remain untouched.
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const inference = require('./inference');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3030);
const token = process.env.LOCAL_AI_TOKEN || '';
const allowedOrigins = (process.env.LOCAL_AI_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const eventClients = new Set();
inference.setEventEmitter(event => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of eventClients) {
        if (!response.destroyed) response.write(payload);
        else eventClients.delete(response);
    }
});

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) {
    console.error('Refusing to bind to a non-loopback address without LOCAL_AI_TOKEN.');
    process.exit(1);
}

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
}
function authorized(req) {
    if (!token) return true;
    const header = req.headers.authorization || '';
    const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function setCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!allowedOrigins.includes(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    return true;
}
function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let tooLarge = false;
        req.on('data', chunk => {
            if (tooLarge) return;
            body += chunk;
            if (Buffer.byteLength(body) > 1024 * 1024) {
                tooLarge = true;
                reject(Object.assign(new Error('Request body exceeds 1 MiB.'), { status: 413 }));
                req.resume();
            }
        });
        req.on('end', () => {
            if (tooLarge) return;
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
        });
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    if (!setCors(req, res)) return sendJson(res, 403, { error: 'Origin not allowed. Configure LOCAL_AI_ALLOWED_ORIGINS with the exact web app origin.' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!authorized(req)) return sendJson(res, 401, { error: 'Missing or invalid bearer token.' });
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
        if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
            return sendJson(res, 200, { ok: true, ...inference.getBinaryStatus(), active: inference.isGenerating() });
        }
        if (req.method === 'POST' && url.pathname === '/binary/download') {
            return sendJson(res, 200, await inference.downloadBinary());
        }
        if (req.method === 'GET' && url.pathname === '/models') {
            return sendJson(res, 200, { models: inference.listModels() });
        }
        if (req.method === 'GET' && url.pathname === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            res.write(`data: ${JSON.stringify({ type: 'connected', activeId: inference.getActiveGenerationId() })}\n\n`);
            eventClients.add(res);
            const keepalive = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 20_000);
            req.on('close', () => { clearInterval(keepalive); eventClients.delete(res); });
            return;
        }
        const modelDownload = url.pathname.match(/^\/models\/([a-z0-9-]+)\/download$/);
        if (req.method === 'POST' && modelDownload) return sendJson(res, 200, await inference.downloadModel(modelDownload[1]));
        const auxiliaryDownload = url.pathname.match(/^\/auxiliary\/(llm|vae)\/download$/);
        if (req.method === 'POST' && auxiliaryDownload) return sendJson(res, 200, await inference.downloadAuxiliary(auxiliaryDownload[1]));
        const modelDelete = url.pathname.match(/^\/models\/([a-z0-9-]+)$/);
        if (req.method === 'DELETE' && modelDelete) return sendJson(res, 200, inference.deleteModel(modelDelete[1]));
        if (req.method === 'POST' && url.pathname === '/generate') return sendJson(res, 200, await inference.generate(await readJson(req)));
        if (req.method === 'POST' && url.pathname === '/cancel') return sendJson(res, 200, inference.cancelGeneration());
        return sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
        if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || 'Internal server error.' });
    }
});

server.listen(port, host, () => console.log(`Local AI server listening on http://${host}:${port}; data: ${inference.dataDir}`));
function shutdown() {
    inference.cancelGeneration();
    for (const response of eventClients) response.end();
    eventClients.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
