import { getLocalModelById } from './localModels.js';

const DEFAULT_URL = 'http://127.0.0.1:3030';
const URL_KEY = 'og_local_server_url';
const TOKEN_KEY = 'og_local_server_token';
const uploadedInputs = new Map();

export const isLocalAIAvailable = () => typeof window !== 'undefined' && typeof window.fetch === 'function';

class LocalInferenceClient {
    getSettings() {
        return {
            baseUrl: localStorage.getItem(URL_KEY) || DEFAULT_URL,
            token: localStorage.getItem(TOKEN_KEY) || '',
        };
    }

    async request(path, options = {}) {
        const { baseUrl, token } = this.getSettings();
        const base = baseUrl.trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(base)) throw new Error('Local AI server URL must start with http:// or https://');
        const headers = new Headers(options.headers || {});
        if (token) headers.set('Authorization', `Bearer ${token}`);
        if (options.body && !(options.body instanceof Blob) && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }
        const response = await fetch(`${base}${path}`, { ...options, headers });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Local AI server returned HTTP ${response.status}`);
        return body;
    }

    async getBinaryStatus() {
        return this.request('/health');
    }
    async downloadBinary() {
        return this.request('/binary/download', { method: 'POST' });
    }
    async downloadModel(modelId) {
        return this.request(`/models/${encodeURIComponent(modelId)}/download`, { method: 'POST' });
    }
    async downloadAuxiliary(auxKey) {
        return this.request(`/auxiliaries/${encodeURIComponent(auxKey)}/download`, { method: 'POST' });
    }
    async deleteModel(modelId) {
        return this.request(`/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
    }
    async getWan2gpConfig() {
        return this.request('/wan2gp/config');
    }
    async setWan2gpConfig(cfg) {
        return this.request('/wan2gp/config', { method: 'POST', body: JSON.stringify(cfg) });
    }
    async setWan2gpUrl(url) {
        const config = await this.getWan2gpConfig();
        return this.setWan2gpConfig({ ...config, url });
    }
    async checkWan2gp(cfg) {
        return this.request('/wan2gp/check', { method: 'POST', body: JSON.stringify(cfg) });
    }
    async pickWan2gpFolder() {
        return null;
    }
    async probeWan2gp(url) {
        return this.request('/wan2gp/probe', { method: 'POST', body: JSON.stringify({ url }) });
    }
    async uploadFileToWan2gp(file) {
        const { baseUrl, token } = this.getSettings();
        const headers = new Headers({ 'Content-Type': file.type });
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const response = await fetch(`${baseUrl.trim().replace(/\/+$/, '')}/wan2gp/upload`, {
            method: 'POST',
            headers,
            body: file,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Local AI server returned HTTP ${response.status}`);
        const url = URL.createObjectURL(file);
        uploadedInputs.set(url, result.id);
        return { url };
    }

    async listModels() {
        const [sdCpp, wan2gp] = await Promise.all([
            this.request('/models'),
            this.request('/wan2gp/models'),
        ]);
        return [
            ...(sdCpp.models || []).map(model => ({ ...model, provider: model.provider || 'sdcpp' })),
            ...(wan2gp.models || []),
        ];
    }

    async generate(params) {
        const model = getLocalModelById(params.model);
        if (model?.provider === 'wan2gp') {
            const image = uploadedInputs.get(params.image) || params.image;
            const result = await this.request('/wan2gp/generate', {
                method: 'POST',
                body: JSON.stringify({ ...params, image }),
            });
            const mediaPath = `/wan2gp/media/${encodeURIComponent(result.runId)}/${encodeURIComponent(result.filename)}`;
            const media = await this.requestMedia(mediaPath);
            return { ...result, url: URL.createObjectURL(media) };
        }
        return this.request('/generate', { method: 'POST', body: JSON.stringify(params) });
    }

    async requestMedia(path) {
        const { baseUrl, token } = this.getSettings();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(`${baseUrl.trim().replace(/\/+$/, '')}${path}`, { headers });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Local AI server returned HTTP ${response.status}`);
        }
        return response.blob();
    }

    cancelGeneration() {
        if (!isLocalAIAvailable()) return;
        this.request('/cancel', { method: 'POST', body: '{}' }).catch(error => console.error(error));
        this.request('/wan2gp/cancel', { method: 'POST', body: '{}' }).catch(error => console.error(error));
    }

    subscribe(type, callback) {
        if (!isLocalAIAvailable()) return () => {};
        const controller = new AbortController();
        let retryTimer;
        const { baseUrl, token } = this.getSettings();
        const connect = async () => {
            try {
                const response = await fetch(`${baseUrl.trim().replace(/\/+$/, '')}/events`, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                    signal: controller.signal,
                });
                if (!response.ok || !response.body) throw new Error(`Event stream returned HTTP ${response.status}`);
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (!controller.signal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const frames = buffer.split(/\r\n\r\n|\n\n|\r\r/);
                    buffer = frames.pop() || '';
                    for (const frame of frames) {
                        const data = frame.split(/\r\n|\n|\r/).find(line => line.startsWith('data:'))?.slice(5).trim();
                        if (!data) continue;
                        try {
                            const event = JSON.parse(data);
                            if (type === 'generation' ? event.type === 'generation' : event.type === 'download') callback(event);
                        } catch { /* Ignore malformed event frames. */ }
                    }
                }
            } catch (error) {
                if (!controller.signal.aborted) console.warn('Local AI event stream disconnected:', error);
            }
            if (!controller.signal.aborted) retryTimer = setTimeout(connect, 2000);
        };
        connect();
        return () => { controller.abort(); clearTimeout(retryTimer); };
    }

    onProgress(callback) {
        return this.subscribe('generation', callback);
    }
    onDownloadProgress(callback) {
        return this.subscribe('download', callback);
    }
}

export const localAI = new LocalInferenceClient();
