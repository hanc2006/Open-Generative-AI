'use strict';

// Standalone sd.cpp runtime, porting Electron's localInference functionality
// without importing Electron. Keep electron/lib/localInference.js untouched.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
const { dimensions, parseProgress, resolveGuidance, resolveSteps } = require('./runtime');

const execFileAsync = promisify(execFile);
const LOCAL_AI_DIR_ENV = 'OPEN_GENERATIVE_AI_LOCAL_AI_DIR';
const dataDir = path.resolve(process.env[LOCAL_AI_DIR_ENV] || path.join(process.cwd(), 'local-ai'));
const binDir = path.join(dataDir, 'bin');
const modelsDir = path.join(dataDir, 'models');
const tmpDir = path.join(dataDir, 'tmp');
const binaryName = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
const binaryPath = path.resolve(process.env.SD_CPP_BINARY || path.join(binDir, binaryName));
for (const dir of [binDir, modelsDir, tmpDir]) fs.mkdirSync(dir, { recursive: true });

const activeDownloads = new Map();
let activeProcess = null;
let activeGenerationId = null;
let cancellationRequested = false;
let emitEvent = () => {};

function setEventEmitter(emitter) {
    emitEvent = typeof emitter === 'function' ? emitter : () => {};
}
function emit(event) { try { emitEvent(event); } catch (error) { console.error('[local-ai] event listener failed:', error); } }

function resolveRedirectUrl(location, requestUrl) {
    if (!location) throw new Error(`Redirect from ${requestUrl} has no Location header`);
    return new URL(location, requestUrl).toString();
}
function pickBinaryAssetForPlatform({ platform, arch, zipNames }) {
    const candidates = zipNames.filter(name => name.startsWith('sd-master-') || name.includes('-bin-'));
    if (platform === 'darwin') return arch === 'arm64' ? candidates.find(n => n.includes('Darwin') && n.includes('arm64')) || null : null;
    if (platform === 'win32') {
        const windows = candidates.filter(name => /win-(avx2?|avx512|noavx|cuda12|cu12)-x64/.test(name));
        for (const tag of ['win-avx2-x64', 'win-avx-x64', 'win-avx512-x64', 'win-noavx-x64', 'win-cuda12-x64', 'win-cu12-x64']) {
            const hit = windows.find(name => name.includes(tag));
            if (hit) return hit;
        }
        return null;
    }
    if (platform === 'linux' && arch === 'arm64') {
        const arm = candidates.filter(name => name.includes('Linux') && (name.includes('aarch64') || name.includes('arm64')));
        return arm.find(name => !/rocm|vulkan/i.test(name)) || arm.find(name => name.includes('vulkan')) || arm.find(name => name.includes('rocm')) || null;
    }
    const linux = candidates.filter(name => name.includes('Linux') && name.includes('x86_64'));
    return linux.find(name => !/rocm|vulkan/i.test(name)) || linux.find(name => name.includes('vulkan')) || linux.find(name => name.includes('rocm')) || null;
}
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'open-generative-ai-local-server/1.0', Accept: 'application/vnd.github+json' } }, response => {
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode} from GitHub release API`)); return; }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
            response.on('error', reject);
        }).on('error', reject);
    });
}
function downloadFile(url, destination, onProgress, { allowedHosts = null, redirects = 10, retries = 3 } = {}) {
    const partialPath = `${destination}.part`;
    const attempt = (requestUrl, redirectsLeft, retriesLeft) => new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(requestUrl); } catch (error) { reject(error); return; }
        if (!['https:', 'http:'].includes(parsed.protocol)) { reject(new Error('Unsupported download protocol.')); return; }
        if (allowedHosts && !allowedHosts.has(parsed.hostname)) { reject(new Error(`Download host is not allowed: ${parsed.hostname}`)); return; }
        const existing = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
        const headers = { 'User-Agent': 'open-generative-ai-local-server/1.0', Accept: '*/*' };
        if (existing) headers.Range = `bytes=${existing}-`;
        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.get(parsed, { headers }, response => {
            const code = response.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(code)) {
                response.resume();
                if (redirectsLeft <= 0) { reject(new Error('Too many download redirects.')); return; }
                let next;
                try { next = resolveRedirectUrl(response.headers.location, requestUrl); } catch (error) { reject(error); return; }
                resolve(attempt(next, redirectsLeft - 1, retriesLeft));
                return;
            }
            if (code !== 200 && code !== 206) { response.resume(); reject(new Error(`Download failed with HTTP ${code} from ${parsed.hostname}.`)); return; }
            const offset = code === 206 ? existing : 0;
            if (code === 200 && existing) fs.rmSync(partialPath, { force: true });
            const length = Number(response.headers['content-length'] || 0);
            const total = code === 206 ? offset + length : length;
            let received = offset;
            const output = fs.createWriteStream(partialPath, { flags: code === 206 ? 'a' : 'w' });
            response.on('data', chunk => { received += chunk.length; if (total) onProgress?.(Math.min(1, received / total)); });
            response.pipe(output);
            output.on('finish', () => { output.close(error => {
                if (error) { reject(error); return; }
                try { fs.renameSync(partialPath, destination); resolve(); } catch (renameError) { reject(renameError); }
            }); });
            output.on('error', error => { response.destroy(); reject(error); });
            response.on('error', error => { output.destroy(); reject(error); });
        });
        request.setTimeout(60_000, () => request.destroy(new Error('Download timed out.')));
        request.on('error', error => {
            if (retriesLeft > 0) {
                console.warn(`[download] ${error.message}; retrying (${retriesLeft} left)`);
                setTimeout(() => resolve(attempt(requestUrl, redirectsLeft, retriesLeft - 1)), 1500);
            } else reject(error);
        });
    });
    return attempt(url, redirects, retries);
}
function findFile(dir, name) {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { const nested = findFile(full, name); if (nested) return nested; }
        else if (entry.name === name) return full;
    }
    return null;
}
function ensureBinaryPermissions() {
    if (process.platform === 'win32') return;
    for (const file of [binaryName, 'sd-server', 'libstable-diffusion.dylib', 'libstable-diffusion.so']) {
        const found = findFile(binDir, file);
        if (found) fs.chmodSync(found, 0o755);
    }
}
function getBinaryStatus() {
    ensureBinaryPermissions();
    return { exists: fs.existsSync(binaryPath), path: binaryPath, dataDir, modelsDir, binDir, tmpDir, envVar: LOCAL_AI_DIR_ENV };
}
async function extractZip(zipPath, destination) {
    if (process.platform === 'win32') {
        const escapedZip = zipPath.replace(/'/g, "''");
        const escapedDestination = destination.replace(/'/g, "''");
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Force -LiteralPath '${escapedZip}' -DestinationPath '${escapedDestination}'`]);
    } else {
        await execFileAsync('unzip', ['-o', zipPath, '-d', destination]);
    }
}
async function downloadBinary() {
    if (fs.existsSync(binaryPath)) return { ok: true, source: 'installed', path: binaryPath };
    emit({ type: 'download', id: '__binary__', phase: 'fetching-release', progress: 0 });
    const platformKey = `${process.platform}-${process.arch}`;
    const customBinaries = { 'darwin-arm64': 'https://github.com/Anil-matcha/Open-Generative-AI/releases/download/v1.0.3-binaries/sd-cli-metal-macos-arm64.zip' };
    let downloadUrl; let archiveName;
    if (customBinaries[platformKey]) {
        downloadUrl = customBinaries[platformKey]; archiveName = path.basename(downloadUrl);
    } else {
        const releases = await fetchJson('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=15');
        let chosen = null; let lastAssets = [];
        for (const release of releases) {
            const zips = (release.assets || []).filter(asset => asset.name.endsWith('.zip'));
            lastAssets = zips.map(asset => asset.name);
            const match = pickBinaryAssetForPlatform({ platform: process.platform, arch: process.arch, zipNames: lastAssets });
            if (match) { chosen = zips.find(asset => asset.name === match); break; }
        }
        if (!chosen) throw new Error(`No sd.cpp binary found for ${platformKey}. Available recent assets: ${lastAssets.join(', ') || '(none)'}`);
        downloadUrl = chosen.browser_download_url; archiveName = chosen.name;
    }
    const archivePath = path.join(binDir, path.basename(archiveName));
    emit({ type: 'download', id: '__binary__', phase: 'downloading', progress: 0 });
    await downloadFile(downloadUrl, archivePath, progress => emit({ type: 'download', id: '__binary__', phase: 'downloading', progress }));
    emit({ type: 'download', id: '__binary__', phase: 'extracting', progress: 0.95 });
    await extractZip(archivePath, binDir);
    fs.rmSync(archivePath, { force: true });
    const found = findFile(binDir, binaryName);
    if (!found) throw new Error(`Extracted sd.cpp archive but ${binaryName} was not found.`);
    if (path.resolve(found) !== path.resolve(binaryPath)) {
        fs.rmSync(binaryPath, { force: true });
        fs.renameSync(found, binaryPath);
    }
    ensureBinaryPermissions();
    if (process.platform === 'darwin') await execFileAsync('xattr', ['-cr', binDir]).catch(() => {});
    emit({ type: 'download', id: '__binary__', phase: 'done', progress: 1 });
    return { ok: true, path: binaryPath };
}
function modelFileState(model) {
    const target = path.join(modelsDir, model.filename);
    if (fs.existsSync(target)) return 'downloaded';
    if (fs.existsSync(`${target}.part`)) return 'partial';
    return 'not-downloaded';
}
function listModels() {
    return LOCAL_MODEL_CATALOG.map(model => ({
        ...model,
        state: modelFileState(model),
        path: path.join(modelsDir, model.filename),
        ...(model.requiresAuxiliary ? { auxiliaryStatus: Object.fromEntries(Object.entries(ZIMAGE_AUXILIARY).map(([key, aux]) => [key, fs.existsSync(path.join(modelsDir, aux.filename)) ? 'downloaded' : 'not-downloaded'])) } : {}),
    }));
}
async function withDownloadLock(id, task) {
    if (activeDownloads.has(id)) return activeDownloads.get(id);
    const promise = task().finally(() => activeDownloads.delete(id));
    activeDownloads.set(id, promise);
    return promise;
}
async function downloadModel(modelId) {
    const model = LOCAL_MODEL_CATALOG.find(item => item.id === modelId);
    if (!model) throw Object.assign(new Error(`Unknown model: ${modelId}`), { status: 404 });
    const destination = path.join(modelsDir, model.filename);
    return withDownloadLock(modelId, async () => {
        if (fs.existsSync(destination)) return { ok: true, modelId, state: 'downloaded' };
        const allowed = new Set(['huggingface.co', 'cdn-lfs.huggingface.co', 'hf.co']);
        emit({ type: 'download', id: modelId, phase: 'downloading', progress: 0 });
        await downloadFile(model.downloadUrl, destination, progress => emit({ type: 'download', id: modelId, phase: 'downloading', progress }), { allowedHosts: allowed });
        emit({ type: 'download', id: modelId, phase: 'done', progress: 1 });
        return { ok: true, modelId, state: 'downloaded' };
    });
}
async function downloadAuxiliary(auxKey) {
    const aux = ZIMAGE_AUXILIARY[auxKey];
    if (!aux) throw Object.assign(new Error(`Unknown auxiliary file: ${auxKey}`), { status: 404 });
    const destination = path.join(modelsDir, aux.filename);
    return withDownloadLock(aux.id, async () => {
        if (fs.existsSync(destination)) return { ok: true, id: aux.id, state: 'downloaded' };
        const allowed = new Set(['huggingface.co', 'cdn-lfs.huggingface.co', 'hf.co']);
        emit({ type: 'download', id: aux.id, phase: 'downloading', progress: 0 });
        await downloadFile(aux.downloadUrl, destination, progress => emit({ type: 'download', id: aux.id, phase: 'downloading', progress }), { allowedHosts: allowed });
        emit({ type: 'download', id: aux.id, phase: 'done', progress: 1 });
        return { ok: true, id: aux.id, state: 'downloaded' };
    });
}
function deleteModel(modelId) {
    const model = LOCAL_MODEL_CATALOG.find(item => item.id === modelId);
    if (!model) throw Object.assign(new Error(`Unknown model: ${modelId}`), { status: 404 });
    const target = path.join(modelsDir, model.filename);
    fs.rmSync(target, { force: true }); fs.rmSync(`${target}.part`, { force: true });
    return { ok: true };
}
function generate(params = {}) {
    if (activeProcess) throw Object.assign(new Error('A generation is already running.'), { status: 409 });
    ensureBinaryPermissions();
    if (!fs.existsSync(binaryPath)) throw Object.assign(new Error(`sd.cpp binary is missing. Download it via POST /binary/download or set SD_CPP_BINARY (${binaryPath}).`), { status: 503 });
    if (typeof params.prompt !== 'string' || params.prompt.length > 10_000) throw Object.assign(new Error('prompt must be a string of at most 10,000 characters.'), { status: 400 });
    const model = LOCAL_MODEL_CATALOG.find(item => item.id === params.model);
    if (!model) throw Object.assign(new Error(`Unknown model: ${params.model}`), { status: 404 });
    const modelPath = path.join(modelsDir, model.filename);
    if (!fs.existsSync(modelPath)) throw Object.assign(new Error(`Model is not downloaded. Download ${model.id} first.`), { status: 409 });
    if (model.requiresAuxiliary) for (const aux of Object.values(ZIMAGE_AUXILIARY)) {
        if (!fs.existsSync(path.join(modelsDir, aux.filename))) throw Object.assign(new Error(`Required model component missing: ${aux.displayName}. Download it first.`), { status: 409 });
    }
    const [width, height] = dimensions(params.aspect_ratio || '1:1', model.type);
    const steps = resolveSteps(params, model);
    const requestedSeed = Number(params.seed);
    const seed = Number.isSafeInteger(requestedSeed) && requestedSeed >= 0 ? requestedSeed : Math.floor(Math.random() * 2147483647);
    const outputPath = path.join(tmpDir, `generation-${randomUUID()}.png`);
    const args = [model.type === 'z-image' || model.type === 'flux' ? '--diffusion-model' : '-m', modelPath,
        '-p', params.prompt || '', '-o', outputPath, '--steps', String(steps), '-H', String(height), '-W', String(width),
        '--cfg-scale', String(resolveGuidance(params, model)), '--seed', String(seed), '--sampling-method', model.sampler || 'euler_a', '-v'];
    if (params.negative_prompt) args.push('-n', String(params.negative_prompt));
    if (model.type === 'z-image') args.push('--llm', path.join(modelsDir, ZIMAGE_AUXILIARY.llm.filename), '--vae', path.join(modelsDir, ZIMAGE_AUXILIARY.vae.filename), '--scheduler', model.scheduler || 'simple');
    if (model.type === 'sdxl') args.push('--sd-version', 'sdxl');
    if (model.type === 'sd2') args.push('--sd-version', 'sd2');
    if (model.type === 'flux') args.push('--flux');

    const id = randomUUID();
    const progressState = { tail: '', lastStep: 0, lastTotalSteps: 0 };
    return new Promise((resolve, reject) => {
        let settled = false;
        const settleError = error => {
            if (settled) return; settled = true;
            fs.rmSync(outputPath, { force: true });
            if (!cancellationRequested) emit({ type: 'generation', id, status: 'error', error: error.message });
            reject(error);
        };
        const child = spawn(binaryPath, args, { env: { ...process.env, DYLD_LIBRARY_PATH: binDir, LD_LIBRARY_PATH: binDir } });
        activeProcess = child; activeGenerationId = id; cancellationRequested = false;
        const outputTail = [];
        let processError = null;
        const startupAt = Date.now();
        let samplingStarted = false;
        emit({ type: 'generation', id, status: 'starting', step: 0, totalSteps: steps, progress: 0, message: 'Starting local model...' });
        const heartbeat = setInterval(() => {
            if (!samplingStarted && !cancellationRequested && activeProcess === child) emit({ type: 'generation', id, status: 'starting', step: 0, totalSteps: steps, progress: 0, message: startupMessage(Date.now() - startupAt) });
        }, 5000);
        const stopHeartbeat = () => clearInterval(heartbeat);
        const onData = chunk => {
            if (cancellationRequested) return;
            const text = chunk.toString(); outputTail.push(text); if (outputTail.length > 200) outputTail.shift();
            for (const event of parseProgress(text, progressState)) {
                samplingStarted = true; stopHeartbeat(); emit({ type: 'generation', id, ...event });
            }
        };
        child.stdout.on('data', onData); child.stderr.on('data', onData);
        child.on('error', error => { processError = error; });
        child.on('close', code => {
            stopHeartbeat();
            if (activeProcess === child) { activeProcess = null; activeGenerationId = null; }
            if (settled) return;
            if (cancellationRequested) {
                settleError(Object.assign(new Error('Generation cancelled.'), { status: 409 }));
                return;
            }
            if (processError) { settleError(processError); return; }
            if (code !== 0 || !fs.existsSync(outputPath)) {
                const error = new Error(`sd.cpp exited with code ${code}:\n${outputTail.join('').slice(-4000)}`);
                settleError(error); return;
            }
            try {
                const result = { id, seed, url: `data:image/png;base64,${fs.readFileSync(outputPath).toString('base64')}` };
                fs.rmSync(outputPath, { force: true }); settled = true;
                emit({ type: 'generation', id, status: 'done', step: steps, totalSteps: steps, progress: 1, seed });
                resolve(result);
            } catch (error) { settleError(error); }
        });
    });
}
function startupMessage(elapsedMs) {
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    if (seconds < 10) return 'Starting local model...';
    if (seconds < 60) return `Loading local model (${seconds}s)...`;
    return `Loading local model (${Math.floor(seconds / 60)}m ${seconds % 60}s)...`;
}
function cancelGeneration() {
    if (activeProcess && !cancellationRequested) {
        if (activeProcess.kill('SIGTERM')) {
            cancellationRequested = true;
            emit({ type: 'generation', id: activeGenerationId, status: 'cancelled' });
            const child = activeProcess;
            const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
            timer.unref();
            child.once('close', () => clearTimeout(timer));
        }
    }
    return { ok: true };
}

module.exports = {
    cancelGeneration,
    dataDir,
    deleteModel,
    downloadAuxiliary,
    downloadBinary,
    downloadModel,
    generate,
    getBinaryStatus,
    isGenerating: () => activeProcess !== null,
    getActiveGenerationId: () => activeGenerationId,
    waitForGeneration: () => activeProcess ? new Promise(resolve => activeProcess.once('close', resolve)) : Promise.resolve(),
    listModels,
    modelsDir,
    setEventEmitter,
};
