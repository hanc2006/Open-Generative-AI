'use strict';

// Standalone sd.cpp runtime, porting Electron's localInference functionality
// without importing Electron. Keep electron/lib/localInference.js untouched.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
const { dimensions, parseProgress, resolveGuidance, resolveSteps } = require('./runtime');
const { pickBinaryAssetForPlatform } = require('./assets');
const { catalogPath, downloadFile, downloadUrl, validateZip } = require('./downloads');

const execFileAsync = promisify(execFile);
const LOCAL_AI_DIR_ENV = 'OPEN_GENERATIVE_AI_LOCAL_AI_DIR';
const dataDir = path.resolve(process.env[LOCAL_AI_DIR_ENV] || path.join(process.cwd(), 'local-ai'));
const binDir = path.join(dataDir, 'bin');
const modelsDir = path.join(dataDir, 'models');
const tmpDir = path.join(dataDir, 'tmp');
const binaryName = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
const binaryOverride = process.env.SD_CPP_BINARY ? path.resolve(process.env.SD_CPP_BINARY) : null;
const installedDir = path.join(binDir, 'sd-cpp');
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

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers: { 'User-Agent': 'open-generative-ai-local-server/1.0', Accept: 'application/vnd.github+json' } }, response => {
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode} from GitHub release API`)); return; }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
                if (body.length > 10 * 1024 * 1024) response.destroy(new Error('GitHub release response is too large.'));
            });
            response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
            response.on('error', reject);
        });
        request.setTimeout(60_000, () => request.destroy(new Error('GitHub release request timed out.')));
        request.on('error', reject);
    });
}
function findFile(dir, name) {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.sd-cpp-')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { const nested = findFile(full, name); if (nested) return nested; }
        else if (entry.isFile() && entry.name === name) return full;
    }
    return null;
}
function ensureBinaryPermissions(dir) {
    if (process.platform === 'win32') return;
    for (const file of [binaryName, 'sd-server', 'libstable-diffusion.dylib', 'libstable-diffusion.so']) {
        const found = findFile(dir, file);
        if (found) fs.chmodSync(found, 0o755);
    }
}
function resolveBinaryPath() {
    return binaryOverride || findFile(installedDir, binaryName) || findFile(binDir, binaryName) || path.join(binDir, binaryName);
}
function getBinaryStatus() {
    const binaryPath = resolveBinaryPath();
    let exists = false;
    let executable = false;
    try { exists = fs.statSync(binaryPath).isFile(); } catch {}
    if (exists) {
        try { fs.accessSync(binaryPath, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); executable = true; } catch {}
    }
    return { exists, executable, binary: exists && executable, path: binaryPath, binaryPath, override: !!binaryOverride, dataDir, modelsDir, binDir, tmpDir, envVar: LOCAL_AI_DIR_ENV };
}
async function extractZip(zipPath, destination) {
    validateZip(zipPath);
    try {
        if (process.platform === 'win32') {
            const escapedZip = zipPath.replace(/'/g, "''");
            const escapedDestination = destination.replace(/'/g, "''");
            await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Force -LiteralPath '${escapedZip}' -DestinationPath '${escapedDestination}'`], { timeout: 300000 });
        } else {
            await execFileAsync('unzip', ['-o', zipPath, '-d', destination], { timeout: 300000 });
        }
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error(process.platform === 'win32' ? 'PowerShell is required to extract sd.cpp.' : 'The unzip command is required to extract sd.cpp; install unzip and retry.');
        throw error;
    }
}
async function downloadBinary() {
    return withDownloadLock('__binary__', async () => {
    const status = getBinaryStatus();
    if (status.exists) return { ok: true, source: 'installed', path: status.path };
    if (binaryOverride) throw Object.assign(new Error('SD_CPP_BINARY is set but does not point to a file. Fix or unset it before installing.'), { status: 409 });
    emit({ type: 'download', id: '__binary__', phase: 'fetching-release', progress: 0 });
    const platformKey = `${process.platform}-${process.arch}`;
    if (!['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64'].includes(platformKey)) throw new Error(`Unsupported sd.cpp platform/architecture: ${platformKey}. Set SD_CPP_BINARY to a compatible binary.`);
    const customBinaries = { 'darwin-arm64': 'https://github.com/Anil-matcha/Open-Generative-AI/releases/download/v1.0.3-binaries/sd-cli-metal-macos-arm64.zip' };
    let selectedUrl;
    if (customBinaries[platformKey]) {
        selectedUrl = customBinaries[platformKey];
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
        const assetUrl = downloadUrl(chosen.browser_download_url);
        if (assetUrl.hostname !== 'github.com' || !assetUrl.pathname.startsWith('/leejet/stable-diffusion.cpp/releases/download/')) throw new Error('Invalid sd.cpp release asset URL.');
        selectedUrl = assetUrl.toString();
    }
    const archivePath = path.join(tmpDir, `sd-cpp-${randomUUID()}.zip`);
    const staging = fs.mkdtempSync(path.join(binDir, '.sd-cpp-'));
    try {
    emit({ type: 'download', id: '__binary__', phase: 'downloading', progress: 0 });
    await downloadFile(selectedUrl, archivePath, progress => emit({ type: 'download', id: '__binary__', phase: 'downloading', progress }));
    emit({ type: 'download', id: '__binary__', phase: 'extracting', progress: 0.95 });
    await extractZip(archivePath, staging);
    const found = findFile(staging, binaryName);
    if (!found) throw new Error(`Extracted sd.cpp archive but ${binaryName} was not found.`);
    ensureBinaryPermissions(staging);
    if (process.platform === 'darwin') await execFileAsync('xattr', ['-cr', staging]).catch(() => {});
    fs.rmSync(installedDir, { recursive: true, force: true });
    fs.renameSync(staging, installedDir);
    const binaryPath = path.join(installedDir, path.relative(staging, found));
    emit({ type: 'download', id: '__binary__', phase: 'done', progress: 1 });
    return { ok: true, path: binaryPath };
    } finally {
        fs.rmSync(archivePath, { force: true });
        fs.rmSync(staging, { recursive: true, force: true });
    }
    });
}
function modelFileState(model) {
    const target = catalogPath(modelsDir, model.filename);
    if (fs.existsSync(target)) return 'downloaded';
    if (fs.existsSync(`${target}.part`)) return 'partial';
    return 'not-downloaded';
}
function listAuxiliaries() {
    return Object.entries(ZIMAGE_AUXILIARY).map(([key, aux]) => ({
        ...aux, key, state: modelFileState(aux), path: catalogPath(modelsDir, aux.filename),
    }));
}
function listModels() {
    return LOCAL_MODEL_CATALOG.map(model => ({
        ...model,
        state: modelFileState(model),
        path: catalogPath(modelsDir, model.filename),
        ...(model.requiresAuxiliary ? { auxiliaryStatus: Object.fromEntries(listAuxiliaries().map(aux => [aux.key, aux.state])) } : {}),
    }));
}
async function withDownloadLock(id, task) {
    if (activeDownloads.has(id)) throw Object.assign(new Error('A download for this target is already running.'), { status: 409 });
    const promise = Promise.resolve().then(task).catch(error => {
        emit({ type: 'download', id, phase: 'error', error: error.message });
        throw error;
    }).finally(() => activeDownloads.delete(id));
    activeDownloads.set(id, promise);
    return promise;
}
async function downloadModel(modelId) {
    const model = LOCAL_MODEL_CATALOG.find(item => item.id === modelId);
    if (!model) throw Object.assign(new Error(`Unknown model: ${modelId}`), { status: 404 });
    const destination = catalogPath(modelsDir, model.filename);
    return withDownloadLock(modelId, async () => {
        if (fs.existsSync(destination)) return { ok: true, modelId, state: 'downloaded' };
        emit({ type: 'download', id: modelId, phase: 'downloading', progress: 0 });
        await downloadFile(model.downloadUrl, destination, progress => emit({ type: 'download', id: modelId, phase: 'downloading', progress }));
        emit({ type: 'download', id: modelId, phase: 'done', progress: 1 });
        return { ok: true, modelId, state: 'downloaded' };
    });
}
async function downloadAuxiliary(auxKey) {
    const aux = Object.hasOwn(ZIMAGE_AUXILIARY, auxKey) ? ZIMAGE_AUXILIARY[auxKey] : null;
    if (!aux) throw Object.assign(new Error(`Unknown auxiliary file: ${auxKey}`), { status: 404 });
    const destination = catalogPath(modelsDir, aux.filename);
    return withDownloadLock(aux.id, async () => {
        if (fs.existsSync(destination)) return { ok: true, id: aux.id, state: 'downloaded' };
        emit({ type: 'download', id: aux.id, phase: 'downloading', progress: 0 });
        await downloadFile(aux.downloadUrl, destination, progress => emit({ type: 'download', id: aux.id, phase: 'downloading', progress }));
        emit({ type: 'download', id: aux.id, phase: 'done', progress: 1 });
        return { ok: true, id: aux.id, state: 'downloaded' };
    });
}
function deleteModel(modelId) {
    const model = LOCAL_MODEL_CATALOG.find(item => item.id === modelId);
    if (!model) throw Object.assign(new Error(`Unknown model: ${modelId}`), { status: 404 });
    if (activeDownloads.has(modelId)) throw Object.assign(new Error('Model download is in progress.'), { status: 409 });
    const target = catalogPath(modelsDir, model.filename);
    fs.rmSync(target, { force: true }); fs.rmSync(`${target}.part`, { force: true });
    return { ok: true };
}
function generate(params = {}) {
    if (activeProcess) throw Object.assign(new Error('A generation is already running.'), { status: 409 });
    const binaryStatus = getBinaryStatus();
    const binaryPath = binaryStatus.path;
    if (!binaryStatus.exists) throw Object.assign(new Error(`sd.cpp binary is missing. Download it via POST /binary/download or set SD_CPP_BINARY (${binaryPath}).`), { status: 503 });
    if (!binaryStatus.executable) throw Object.assign(new Error(`sd.cpp binary is not executable: ${binaryPath}`), { status: 503 });
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
        const libraryDir = path.dirname(binaryPath);
        const child = spawn(binaryPath, args, { env: { ...process.env, DYLD_LIBRARY_PATH: libraryDir, LD_LIBRARY_PATH: libraryDir } });
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
    getActiveGenerationId: () => activeGenerationId,
    isGenerating: () => !!activeProcess,
    listAuxiliaries,
    waitForGeneration: () => activeProcess ? new Promise(resolve => activeProcess.once('close', resolve)) : Promise.resolve(),
    listModels,
    modelsDir,
    setEventEmitter,
};
