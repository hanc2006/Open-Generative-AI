const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

async function waitFor(check) {
    for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for server or child process');
}

async function freePort() {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
}

test('HTTP server enforces auth and exact CORS, and exposes status and events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-server-'));
    const port = await freePort();
    const server = spawn(process.execPath, [path.join(root, 'server/server.js')], {
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOCAL_AI_TOKEN: 'test-token', LOCAL_AI_ALLOWED_ORIGINS: 'http://localhost:3000', OPEN_GENERATIVE_AI_LOCAL_AI_DIR: dir },
        stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: ['Bearer', 'test-token'].join(' '), Origin: 'http://localhost:3000' };
    try {
        await waitFor(async () => {
            try { return (await fetch(`${base}/health`, { headers })).ok; } catch { return false; }
        });
        assert.equal((await fetch(`${base}/health`)).status, 401);
        assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: 'http://localhost:3001' } })).status, 403);
        const preflight = await fetch(`${base}/generate`, { method: 'OPTIONS', headers: { Origin: headers.Origin } });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), headers.Origin);
        const health = await (await fetch(`${base}/health`, { headers })).json();
        assert.equal(health.exists, false);
        assert.equal(health.active, false);
        const models = await (await fetch(`${base}/models`, { headers })).json();
        assert.ok(models.models.some(model => model.id === 'z-image-turbo' && model.auxiliaryStatus.llm === 'not-downloaded'));
        const events = await fetch(`${base}/events`, { headers });
        const reader = events.body.getReader();
        const first = await reader.read();
        assert.match(new TextDecoder().decode(first.value), /"activeId":null/);
        await reader.cancel();
        assert.equal((await fetch(`${base}/models/unknown/download`, { method: 'POST', headers })).status, 404);
        assert.equal((await fetch(`${base}/generate`, { method: 'POST', headers, body: '{}' })).status, 503);
        assert.equal((await fetch(`${base}/cancel`, { method: 'POST', headers })).status, 200);
    } finally {
        server.kill('SIGTERM');
        await new Promise(resolve => server.once('exit', resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('non-loopback binding without a token is refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-server-'));
    const child = spawn(process.execPath, [path.join(root, 'server/server.js')], {
        env: { ...process.env, HOST: '0.0.0.0', LOCAL_AI_TOKEN: '', OPEN_GENERATIVE_AI_LOCAL_AI_DIR: dir },
        stdio: 'ignore',
    });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 1);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('generation stays active until a cancelled child exits', { skip: process.platform === 'win32' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runtime-'));
    const binary = path.join(dir, 'fake-sd-cli');
    const marker = path.join(dir, 'started');
    fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.TEST_SUCCESS) {
    fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], 'fake png');
    process.exit(0);
}
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250));
fs.writeFileSync(process.env.TEST_MARKER, '');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'models'));
    fs.writeFileSync(path.join(dir, 'models', 'DreamShaper_8_pruned.safetensors'), '');
    const oldEnv = { ...process.env };
    process.env.OPEN_GENERATIVE_AI_LOCAL_AI_DIR = dir;
    process.env.SD_CPP_BINARY = binary;
    process.env.TEST_MARKER = marker;
    const inference = require('../server/inference');
    const events = [];
    inference.setEventEmitter(event => events.push(event));
    try {
        const generation = inference.generate({ model: 'dreamshaper-8', prompt: 'test' });
        const rejected = assert.rejects(generation, /Generation cancelled/);
        const id = inference.getActiveGenerationId();
        assert.ok(id);
        await waitFor(() => fs.existsSync(marker));
        inference.cancelGeneration();
        inference.cancelGeneration();
        assert.equal(inference.isGenerating(), true);
        assert.equal(inference.getActiveGenerationId(), id);
        assert.throws(() => inference.generate({ model: 'dreamshaper-8', prompt: 'test' }), /already running/);
        await rejected;
        assert.equal(inference.isGenerating(), false);
        assert.equal(inference.getActiveGenerationId(), null);
        assert.equal(events.filter(event => event.status === 'cancelled').length, 1);
        assert.equal(events.filter(event => event.status === 'error').length, 0);
        process.env.TEST_SUCCESS = '1';
        const result = await inference.generate({ model: 'dreamshaper-8', prompt: 'test', seed: 42 });
        assert.equal(result.seed, 42);
        assert.equal(result.url, `data:image/png;base64,${Buffer.from('fake png').toString('base64')}`);
        assert.equal(inference.isGenerating(), false);
        assert.equal(events.filter(event => event.status === 'done').length, 1);
    } finally {
        inference.cancelGeneration();
        process.env = oldEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
