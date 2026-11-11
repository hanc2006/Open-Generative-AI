#!/usr/bin/env node
'use strict';

// Standalone HTTP server for local sd.cpp image inference. Node built-ins only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
const { dimensions, parseProgress, resolveGuidance, resolveSteps } = require('./runtime');

const dataDir = path.resolve(process.env.OPEN_GENERATIVE_AI_LOCAL_AI_DIR || path.join(process.cwd(), 'local-ai'));
const binDir = path.join(dataDir, 'bin');
const modelsDir = path.join(dataDir, 'models');
const tmpDir = path.join(dataDir, 'tmp');
for (const dir of [binDir, modelsDir, tmpDir]) fs.mkdirSync(dir, { recursive: true });
const binaryPath = path.resolve(process.env.SD_CPP_BINARY || path.join(binDir, process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3030);
const token = process.env.LOCAL_AI_TOKEN || '';
const allowedOrigins = (process.env.LOCAL_AI_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const clients = new Set();
let active = null;
let activeId = null;

if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && !token) {
    console.error('Refusing to bind to a non-loopback address without LOCAL_AI_TOKEN.');
    process.exit(1);
}

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
}
function emit(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of clients) response.write(line);
}
function authorized(req) {
    if (!token) return true;
    const header = req.headers.authorization || '';
    const supplied = header.startsWith('Bearer ') ? Buffer.from(header.slice(7)) : Buffer.alloc(0);
    const expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        return true;
    }
    return false;
}
function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > 1024 * 1024) {
                reject(Object.assign(new Error('Request body exceeds 1 MiB.'), { status: 413 }));
                req.destroy();
            }
        });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
        });
        req.on('error', reject);
    });
}
function status() {
    return { binary: fs.existsSync(binaryPath), binaryPath, modelsDir, dataDir, active: !!active };
}
function listModels() {
    return LOCAL_MODEL_CATALOG.map(model => ({
        id: model.id, name: model.name, description: model.description, type: model.type,
        sizeGB: model.sizeGB, defaultSteps: model.defaultSteps, defaultGuidance: model.defaultGuidance,
        requiresAuxiliary: !!model.requiresAuxiliary,
        state: fs.existsSync(path.join(modelsDir, model.filename)) ? 'downloaded' : 'not-downloaded',
        auxiliaryStatus: model.requiresAuxiliary ? Object.fromEntries(Object.entries(ZIMAGE_AUXILIARY).map(([key, aux]) => [key, fs.existsSync(path.join(modelsDir, aux.filename)) ? 'downloaded' : 'not-downloaded'])) : undefined,
    }));
}
function download(url, destination, redirects = 5) {
    return new Promise((resolve, reject) => {
        if (redirects < 0) return reject(new Error('Too many download redirects.'));
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !['huggingface.co', 'cdn-lfs.huggingface.co', 'hf.co'].includes(parsed.hostname)) {
            return reject(new Error('Downloads are restricted to HTTPS Hugging Face model URLs.'));
        }
        const request = httpsGet(parsed, redirects, destination, resolve, reject);
        request.setTimeout(60_000, () => request.destroy(new Error('Download timed out.')));
    });
}
function httpsGet(parsed, redirects, destination, resolve, reject) {
    const https = require('node:https');
    return https.get(parsed, { headers: { 'User-Agent': 'open-generative-ai-local-server/1.0' } }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            let next;
            try { next = new URL(response.headers.location, parsed); } catch (error) { reject(error); return; }
            if (next.protocol !== 'https:' || !['huggingface.co', 'cdn-lfs.huggingface.co', 'hf.co'].includes(next.hostname)) {
                reject(new Error('Refusing download redirect outside approved Hugging Face hosts.')); return;
            }
            httpsGet(next, redirects - 1, destination, resolve, reject);
            return;
        }
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`Download failed with HTTP ${response.statusCode}.`)); return; }
        const temporary = `${destination}.part`;
        const output = fs.createWriteStream(temporary);
        response.pipe(output);
        output.on('finish', () => { output.close(() => { fs.renameSync(temporary, destination); resolve(); }); });
        output.on('error', error => { fs.rmSync(temporary, { force: true }); reject(error); });
        response.on('error', error => { output.destroy(); fs.rmSync(temporary, { force: true }); reject(error); });
    }).on('error', reject);
}
async function downloadModel(modelId) {
    const model = LOCAL_MODEL_CATALOG.find(item => item.id === modelId);
    if (!model) throw Object.assign(new Error('Unknown model id.'), { status: 404 });
    const target = path.join(modelsDir, model.filename);
    if (!fs.existsSync(target)) {
        emit({ type: 'download', id: modelId, status: 'downloading', progress: null });
        await download(model.downloadUrl, target);
    }
    emit({ type: 'download', id: modelId, status: 'done', progress: 1 });
    return { ok: true, modelId };
}
function generate(params) {
    if (active) throw Object.assign(new Error('A generation is already running.'), { status: 409 });
    if (!fs.existsSync(binaryPath)) throw Object.assign(new Error(`sd.cpp binary not found at ${binaryPath}. Set SD_CPP_BINARY or install it at that path.`), { status: 503 });
    const model = LOCAL_MODEL_CATALOG.find(item => item.id === params.model);
    if (!model) throw Object.assign(new Error('Unknown model id.'), { status: 404 });
    const modelPath = path.join(modelsDir, model.filename);
    if (!fs.existsSync(modelPath)) throw Object.assign(new Error(`Model is not downloaded. POST /models/${model.id}/download first.`), { status: 409 });
    if (model.requiresAuxiliary) {
        for (const aux of Object.values(ZIMAGE_AUXILIARY)) {
            if (!fs.existsSync(path.join(modelsDir, aux.filename))) throw Object.assign(new Error(`Required model component missing: ${aux.displayName}.`), { status: 409 });
        }
    }
    const [width, height] = dimensions(params.aspect_ratio || '1:1', model.type);
    const steps = resolveSteps(params, model);
    const seed = Number.isSafeInteger(Number(params.seed)) && Number(params.seed) >= 0 ? Number(params.seed) : Math.floor(Math.random() * 2147483647);
    const outputPath = path.join(tmpDir, `generation-${randomUUID()}.png`);
    const args = [model.type === 'z-image' || model.type === 'flux' ? '--diffusion-model' : '-m', modelPath,
        '-p', String(params.prompt || ''), '-o', outputPath, '--steps', String(steps), '-H', String(height), '-W', String(width),
        '--cfg-scale', String(resolveGuidance(params, model)), '--seed', String(seed), '--sampling-method', model.sampler || 'euler_a', '-v'];
    if (params.negative_prompt) args.push('-n', String(params.negative_prompt));
    if (model.type === 'z-image') args.push('--llm', path.join(modelsDir, ZIMAGE_AUXILIARY.llm.filename), '--vae', path.join(modelsDir, ZIMAGE_AUXILIARY.vae.filename), '--scheduler', model.scheduler || 'simple');
    if (model.type === 'sdxl') args.push('--sd-version', 'sdxl');
    if (model.type === 'sd2') args.push('--sd-version', 'sd2');
    if (model.type === 'flux') args.push('--flux');

    const id = randomUUID();
    const progressState = { tail: '', lastStep: 0 };
    emit({ type: 'generation', id, status: 'starting', step: 0, totalSteps: steps, progress: 0 });
    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, args, { env: { ...process.env, DYLD_LIBRARY_PATH: binDir, LD_LIBRARY_PATH: binDir } });
        active = child; activeId = id;
        const output = [];
        const onData = chunk => {
            const text = chunk.toString(); output.push(text);
            for (const event of parseProgress(text, progressState)) emit({ type: 'generation', id, ...event });
        };
        child.stdout.on('data', onData); child.stderr.on('data', onData);
        child.on('error', error => { active = null; activeId = null; fs.rmSync(outputPath, { force: true }); emit({ type: 'generation', id, status: 'error', error: error.message }); reject(error); });
        child.on('close', code => {
            active = null; activeId = null;
            if (code !== 0 || !fs.existsSync(outputPath)) {
                const error = new Error(`sd.cpp exited with code ${code}: ${output.join('').slice(-4000)}`);
                fs.rmSync(outputPath, { force: true }); emit({ type: 'generation', id, status: 'error', error: error.message }); reject(error); return;
            }
            try {
                const image = fs.readFileSync(outputPath).toString('base64');
                fs.rmSync(outputPath, { force: true });
                emit({ type: 'generation', id, status: 'done', step: steps, totalSteps: steps, progress: 1, seed });
                resolve({ id, seed, url: `data:image/png;base64,${image}` });
            } catch (error) { reject(error); }
        });
    });
}

const server = http.createServer(async (req, res) => {
    if (!cors(req, res)) return sendJson(res, 403, { error: 'Origin not allowed. Configure LOCAL_AI_ALLOWED_ORIGINS.' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!authorized(req)) return sendJson(res, 401, { error: 'Missing or invalid bearer token.' });
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
        if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, ...status() });
        if (req.method === 'GET' && url.pathname === '/models') return sendJson(res, 200, { models: listModels() });
        if (req.method === 'GET' && url.pathname === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            res.write(`data: ${JSON.stringify({ type: 'connected', activeId })}\n\n`);
            clients.add(res); req.on('close', () => clients.delete(res)); return;
        }
        const modelDownload = url.pathname.match(/^\/models\/([a-z0-9-]+)\/download$/);
        if (req.method === 'POST' && modelDownload) return sendJson(res, 200, await downloadModel(modelDownload[1]));
        if (req.method === 'POST' && url.pathname === '/generate') return sendJson(res, 200, await generate(await readJson(req)));
        if (req.method === 'POST' && url.pathname === '/cancel') {
            if (active) { const id = activeId; active.kill('SIGTERM'); active = null; activeId = null; emit({ type: 'generation', id, status: 'cancelled' }); }
            return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
        if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || 'Internal server error.' });
    }
});
server.listen(port, host, () => console.log(`Local AI server listening on http://${host}:${port}; data: ${dataDir}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (active) active.kill('SIGTERM'); server.close(() => process.exit(0)); });
