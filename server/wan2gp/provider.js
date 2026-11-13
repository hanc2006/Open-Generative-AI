'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const inference = require('../inference');
const { withWan2gpAvailability } = require('./wan2gpModelAvailability');
const { WAN2GP_CATALOG, getModelById, buildWan2gpSettings } = require('./wan2gpCatalog');
const local = require('./wan2gpLocal');
const { createMcpClient, normalizeMcpUrl } = require('./wan2gpMcp');

const CONFIG_FILE = path.join(inference.dataDir, 'wan2gp.json');
const WORK_DIR = path.join(inference.dataDir, 'wan2gp');
const INPUTS_DIR = path.join(WORK_DIR, 'inputs');
const RUNS_DIR = path.join(WORK_DIR, 'runs');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm']);
const CHECK_MODEL = getModelById('wan2gp:wan21-t2v-1.3b');
const mcpClients = new Map();
let active = null;
let emitEvent = () => {};

function setEventEmitter(emitter) {
    emitEvent = typeof emitter === 'function' ? emitter : () => {};
}

function emit(event) {
    try { emitEvent({ type: 'generation', ...event }); }
    catch (error) { console.error('[wan2gp] event listener failed:', error); }
}

function readConfig() {
    try { return { dir: '', python: '', url: '', ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch { return { dir: '', python: '', url: '' }; }
}

function writeConfig(cfg) {
    const next = {
        dir: typeof cfg.dir === 'string' ? cfg.dir.trim() : '',
        python: typeof cfg.python === 'string' ? cfg.python.trim() : '',
        url: typeof cfg.url === 'string' ? cfg.url.trim().replace(/\/+$/, '') : '',
    };
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
}

function engineMode(cfg) {
    if (cfg.dir) return 'local';
    if (cfg.url) return 'remote';
    return null;
}

function mcpClientFor(url) {
    const endpoint = normalizeMcpUrl(url);
    if (!mcpClients.has(endpoint)) mcpClients.set(endpoint, createMcpClient(endpoint));
    return mcpClients.get(endpoint);
}

async function explainRemoteFailure(url, error) {
    try {
        const res = await fetch(`${url.replace(/\/mcp$/, '')}/config`, { signal: AbortSignal.timeout(4000) });
        if (res.ok && (await res.json()).mode === 'blocks') {
            return 'This is the Wan2GP web UI (Gradio), which has no generation API. Start Wan2GP with '
                + '"python wgp.py --mcp --mcp-api-version 1 --mcp-transport streamable-http --mcp-host 0.0.0.0 --mcp-port 7866" '
                + 'and use http://<host>:7866/mcp — or configure a local Wan2GP folder.';
        }
    } catch { /* The endpoint is not a Gradio UI. */ }
    return `Wan2GP MCP server not reachable at ${normalizeMcpUrl(url)}: ${error.message}`;
}

async function probeRemote(url) {
    if (!url) return { ok: false, error: 'URL is empty' };
    try {
        const info = await mcpClientFor(url).probe();
        return { ok: true, mode: 'remote', message: `Connected to ${info.server} MCP ${info.version}` };
    } catch (error) {
        mcpClients.delete(normalizeMcpUrl(url));
        return { ok: false, mode: 'remote', error: await explainRemoteFailure(url, error) };
    }
}

async function engineStatus(cfg = readConfig()) {
    const mode = engineMode(cfg);
    const modelTypes = WAN2GP_CATALOG.map(model => model.modelType);
    if (mode === 'local') {
        const install = local.resolveInstall(cfg);
        const check = local.checkInstall(install);
        if (!check.ok) return { ok: false, mode, error: check.error };
        return { ok: true, mode, modelStatus: local.localModelStatus(install, modelTypes) };
    }
    if (mode === 'remote') {
        const probe = await probeRemote(cfg.url);
        if (!probe.ok) return { ok: false, mode, error: probe.error };
        const client = mcpClientFor(cfg.url);
        const modelStatus = new Map();
        for (const modelType of modelTypes) {
            try { modelStatus.set(modelType, await client.modelAvailability(modelType)); }
            catch { /* Availability can be unknown for older MCP implementations. */ }
        }
        return { ok: true, mode, modelStatus };
    }
    return { ok: false, mode: null, error: 'Wan2GP is not configured — set its folder or MCP server URL.' };
}

async function listModels() {
    const engine = await engineStatus();
    return WAN2GP_CATALOG.map(model => withWan2gpAvailability(model, engine));
}

async function check(cfg = {}) {
    const config = { ...readConfig(), ...cfg };
    const mode = engineMode(config);
    if (mode === 'remote') return probeRemote(config.url);
    if (mode !== 'local') return { ok: false, error: 'Set the Wan2GP folder or a server URL first.' };
    const install = local.resolveInstall(config);
    const installCheck = local.checkInstall(install);
    if (!installCheck.ok) return { ok: false, mode, error: installCheck.error };
    if (config.quick) return { ok: true, mode, message: `Wan2GP folder found · python ${install.python}` };
    const settings = buildWan2gpSettings(CHECK_MODEL, { prompt: 'dry run', aspect_ratio: '16:9', seed: 1 });
    const result = await local.dryRun({ install, settings, runDir: path.join(WORK_DIR, 'check') });
    return result.ok
        ? { ok: true, mode, message: `Wan2GP found · python ${install.python}` }
        : { ok: false, mode, error: result.message };
}

function getConfig() {
    const cfg = readConfig();
    return { ...cfg, mode: engineMode(cfg), defaultPython: cfg.dir ? local.defaultPythonPath(cfg.dir) : '' };
}

function setConfig(cfg) {
    mcpClients.clear();
    return { ok: true, config: writeConfig({ ...readConfig(), ...cfg }) };
}

function saveInput({ name, type, bytes }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw Object.assign(new Error('Empty file payload.'), { status: 400 });
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
        throw Object.assign(new Error('Start-frame images must be PNG, JPEG, or WebP.'), { status: 415 });
    }
    const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type];
    fs.mkdirSync(INPUTS_DIR, { recursive: true });
    const id = `${crypto.randomUUID()}${extension}`;
    const filePath = path.join(INPUTS_DIR, id);
    fs.writeFileSync(filePath, bytes, { flag: 'wx' });
    return { id };
}

function inputPath(image) {
    if (!image) return null;
    const id = String(image);
    if (!/^[\da-f-]{36}\.(png|jpg|webp)$/i.test(id)) {
        throw Object.assign(new Error('Invalid uploaded start-frame reference.'), { status: 400 });
    }
    const filePath = path.join(INPUTS_DIR, id);
    if (!fs.existsSync(filePath)) {
        throw Object.assign(new Error('Start-frame image is unavailable on the server — upload it again.'), { status: 400 });
    }
    return filePath;
}

function mediaResult(filePath, runId, seed) {
    const mediaType = VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ? 'video' : 'image';
    return { runId, filename: path.basename(filePath), mediaType, seed };
}

async function generate(params = {}) {
    if (active) throw Object.assign(new Error('A Wan2GP generation is already running.'), { status: 409 });
    const model = getModelById(params.model);
    if (!model) throw Object.assign(new Error(`Unknown Wan2GP model: ${params.model}`), { status: 404 });
    const cfg = readConfig();
    const mode = engineMode(cfg);
    if (!mode) throw Object.assign(new Error('Wan2GP is not configured — set its folder or MCP server URL.'), { status: 409 });

    const imagePath = inputPath(params.image);
    const runId = crypto.randomUUID();
    const runDir = path.join(RUNS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const run = { id: runId, cancelled: false, cancel: () => {} };
    active = run;
    emit({ id: runId, status: 'starting', progress: 0 });

    const send = event => emit({ id: runId, ...event });
    try {
        if (mode === 'local') {
            const install = local.resolveInstall(cfg);
            const installCheck = local.checkInstall(install);
            if (!installCheck.ok) throw new Error(installCheck.error);
            const settings = buildWan2gpSettings(model, params, { imageStart: imagePath });
            const { child, done } = local.runGeneration({ install, settings, runDir, onProgress: send });
            run.cancel = () => local.killTree(child);
            const mediaPath = await done.catch(error => {
                throw run.cancelled ? Object.assign(new Error('Generation cancelled.'), { status: 409 }) : error;
            });
            send({ status: 'done', progress: 1 });
            return mediaResult(mediaPath, runId, settings.seed);
        }

        const client = mcpClientFor(cfg.url);
        const abort = new AbortController();
        let jobId = null;
        run.cancel = () => {
            abort.abort();
            client.cancel(jobId).catch(error => console.error('[wan2gp] cancel failed:', error.message));
        };
        const imageStart = imagePath
            ? await client.uploadImage({ name: path.basename(imagePath), bytes: fs.readFileSync(imagePath) })
            : undefined;
        const settings = buildWan2gpSettings(model, params, { imageStart });
        const item = await client.generate(settings, {
            onProgress: send,
            onJobId: id => { jobId = id; },
            signal: abort.signal,
        });
        const { filename, bytes } = await client.download(item.media_id);
        const safeName = path.basename(filename || `${item.media_id.replace(/\W/g, '_')}.mp4`);
        const mediaPath = path.join(runDir, safeName);
        fs.writeFileSync(mediaPath, bytes, { flag: 'wx' });
        send({ status: 'done', progress: 1 });
        return mediaResult(mediaPath, runId, settings.seed);
    } catch (error) {
        if (run.cancelled) throw Object.assign(new Error('Generation cancelled.'), { status: 409 });
        send({ status: 'error', error: error.message });
        throw error;
    } finally {
        if (active === run) active = null;
    }
}

function cancelGeneration() {
    if (active && !active.cancelled) {
        active.cancelled = true;
        emit({ id: active.id, status: 'cancelled' });
        active.cancel();
    }
    return { ok: true };
}

function readMedia(runId, filename) {
    if (!/^[\da-f-]{36}$/i.test(runId) || !filename || path.basename(filename) !== filename) return null;
    const filePath = path.join(RUNS_DIR, runId, filename);
    try {
        if (!fs.statSync(filePath).isFile()) return null;
        return { filePath, extension: path.extname(filename).toLowerCase() };
    } catch { return null; }
}

async function shutdown() {
    cancelGeneration();
    if (active) await new Promise(resolve => {
        const timer = setInterval(() => { if (!active) { clearInterval(timer); resolve(); } }, 50);
        timer.unref();
    });
}

module.exports = {
    cancelGeneration,
    check,
    generate,
    getConfig,
    listModels,
    readMedia,
    saveInput,
    setConfig,
    setEventEmitter,
    shutdown,
    probeRemote,
};
