'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { pickBinaryAssetForPlatform } = require('../assets');
const { catalogPath, downloadUrl, validateZip } = require('../downloads');

test('selects compatible release assets and rejects unsupported architectures', () => {
    const zipNames = ['sd-master-Linux-x86_64-vulkan.zip', 'sd-master-Linux-x86_64.zip', 'sd-master-win-avx-x64.zip', 'sd-master-win-avx2-x64.zip'];
    assert.equal(pickBinaryAssetForPlatform({ platform: 'linux', arch: 'x64', zipNames }), zipNames[1]);
    assert.equal(pickBinaryAssetForPlatform({ platform: 'win32', arch: 'x64', zipNames }), zipNames[3]);
    assert.equal(pickBinaryAssetForPlatform({ platform: 'linux', arch: 'ia32', zipNames }), null);
    assert.equal(pickBinaryAssetForPlatform({ platform: 'win32', arch: 'arm64', zipNames }), null);
});

test('catalog paths and redirects reject unsafe inputs while permitting CDN hosts', () => {
    assert.equal(catalogPath('/models', 'model.gguf'), path.join('/models', 'model.gguf'));
    for (const name of ['../model', 'a\\b', '/tmp/file', '..', 'C:foo']) assert.throws(() => catalogPath('/models', name));
    for (const url of ['http://example.com/a', 'https://localhost/a', 'https://127.0.0.1/a', '******example.com/']) assert.throws(() => downloadUrl(url));
    assert.equal(downloadUrl('https://cdn-lfs-us-1.hf.co/file').hostname, 'cdn-lfs-us-1.hf.co');
    assert.equal(downloadUrl('https://release-assets.githubusercontent.com/file').hostname, 'release-assets.githubusercontent.com');
});

function zipDirectory(name, mode = 0) {
    const filename = Buffer.from(name);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(mode * 65536, 38);
    filename.copy(central, 46);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    return Buffer.concat([central, end]);
}

test('ZIP validation rejects traversal and symlink entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-zip-'));
    const file = path.join(dir, 'archive.zip');
    try {
        fs.writeFileSync(file, zipDirectory('nested/sd-cli'));
        assert.doesNotThrow(() => validateZip(file));
        for (const [name, mode] of [['../escape', 0], ['nested\\escape', 0], ['link', 0xa000]]) {
            fs.writeFileSync(file, zipDirectory(name, mode));
            assert.throws(() => validateZip(file), /Unsafe/);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('binary override and auxiliary states are exposed without network access', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-status-'));
    const script = `
        const assert = require('node:assert/strict');
        const core = require(${JSON.stringify(path.join(__dirname, '../inference.js'))});
        assert.equal(core.getBinaryStatus().exists, false);
        assert.equal(core.getBinaryStatus().override, true);
        assert.equal(core.listAuxiliaries().length, 2);
        assert.equal(core.listModels().find(m => m.id === 'z-image-turbo').auxiliaryStatus.llm, 'not-downloaded');
        core.downloadBinary().then(() => process.exit(1), e => { assert.equal(e.status, 409); });
    `;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, OPEN_GENERATIVE_AI_LOCAL_AI_DIR: dir, SD_CPP_BINARY: path.join(dir, 'missing') }, stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', code => {
            fs.rmSync(dir, { recursive: true, force: true });
            code === 0 ? resolve() : reject(new Error(`Child exited ${code}`));
        });
    });
});

test('HTTP health, auxiliaries, models and event stream are usable', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-http-'));
            const port = await new Promise((resolve, reject) => {
                const socket = net.createServer();
                socket.on('error', reject);
                socket.listen(0, '127.0.0.1', () => {
                    const value = socket.address().port;
                    socket.close(() => resolve(value));
                });
            });
            const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
                env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOCAL_AI_TOKEN: '', OPEN_GENERATIVE_AI_LOCAL_AI_DIR: dir, SD_CPP_BINARY: path.join(dir, 'missing') },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const base = `http://127.0.0.1:${port}`;
            let reader;
            try {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Server did not start.')), 5000);
                    child.once('error', reject);
                    child.once('exit', code => reject(new Error(`Server exited ${code}.`)));
                    child.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
                });
                const health = await (await fetch(`${base}/health`)).json();
                assert.equal(health.exists, false);
                assert.equal(health.active, false);
                const auxiliaries = (await (await fetch(`${base}/auxiliaries`)).json()).auxiliaries;
                const models = (await (await fetch(`${base}/models`)).json()).models;
                assert.equal(auxiliaries.length, 2);
                assert.equal(models.find(model => model.id === 'z-image-turbo').auxiliaryStatus.vae, 'not-downloaded');
                assert.equal((await fetch(`${base}/auxiliaries/invalid/download`, { method: 'POST' })).status, 404);
                assert.equal((await fetch(`${base}/binary/download`, { method: 'POST' })).status, 409);
                const events = await fetch(`${base}/events`);
                reader = events.body.getReader();
                assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"connected"/);
            } finally {
                await reader?.cancel();
                child.kill('SIGTERM');
                await new Promise(resolve => child.once('close', resolve));
                fs.rmSync(dir, { recursive: true, force: true });
            }
});
