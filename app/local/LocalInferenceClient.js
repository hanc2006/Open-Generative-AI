'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_URL = 'http://127.0.0.1:3030';
const URL_KEY = 'og_local_server_url';
const TOKEN_KEY = 'og_local_server_token';

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

export default function LocalInferenceClient() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_URL);
  const [token, setToken] = useState('');
  const [models, setModels] = useState([]);
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [steps, setSteps] = useState(20);
  const [guidance, setGuidance] = useState(7.5);
  const [seed, setSeed] = useState(-1);
  const [status, setStatus] = useState('Enter a server URL and connect.');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [binaryAvailable, setBinaryAvailable] = useState(false);
  const [image, setImage] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const eventController = useRef(null);

  useEffect(() => {
    setBaseUrl(localStorage.getItem(URL_KEY) || DEFAULT_URL);
    setToken(localStorage.getItem(TOKEN_KEY) || '');
  }, []);

  const request = useCallback(async (path, options = {}) => {
    const base = normalizeBaseUrl(baseUrl);
    if (!/^https?:\/\//i.test(base)) throw new Error('Server URL must start with http:// or https://');
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${base}${path}`, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Server returned HTTP ${response.status}`);
    return body;
  }, [baseUrl, token]);

  const connect = useCallback(async () => {
    setError(''); setStatus('Connecting…'); setConnected(false); setBinaryAvailable(false);
    try {
      const [health, result] = await Promise.all([request('/health'), request('/models')]);
      setModels(result.models || []);
      setModelId((current) => (result.models || []).some((model) => model.id === current) ? current : (result.models || [])[0]?.id || '');
      setConnected(true);
      setBinaryAvailable(health.exists);
      setStatus(health.exists ? `Connected · sd.cpp ready · models stored at ${health.modelsDir}` : `Connected, but sd.cpp binary was not found at ${health.path}`);
      localStorage.setItem(URL_KEY, normalizeBaseUrl(baseUrl));
      if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      setError(e.message); setStatus('Could not connect. Check the URL, server status, token, and CORS allowlist.');
    }
  }, [baseUrl, request, token]);

  const refreshModels = useCallback(async () => {
    const result = await request('/models');
    setModels(result.models || []);
    return result.models || [];
  }, [request]);

  const downloadModel = async (id) => {
    setBusy(true); setError(''); setStatus(`Downloading ${id}…`);
    try {
      await request(`/models/${encodeURIComponent(id)}/download`, { method: 'POST' });
      await refreshModels();
      setStatus(`${id} is ready.`);
    } catch (e) { setError(e.message); setStatus('Model download failed.'); }
    finally { setBusy(false); }
  };

  const installBinary = async () => {
    setBusy(true); setError(''); setStatus('Installing sd.cpp…');
    try {
      await request('/binary/download', { method: 'POST' });
      const health = await request('/health');
      setBinaryAvailable(health.exists);
      setStatus(health.exists ? 'sd.cpp is ready.' : 'sd.cpp binary is still missing.');
    } catch (e) { setError(e.message); setStatus('Binary installation failed.'); }
    finally { setBusy(false); }
  };

  const downloadAuxiliary = async (key) => {
    setBusy(true); setError(''); setStatus(`Downloading ${key}…`);
    try {
      await request(`/auxiliary/${key}/download`, { method: 'POST' });
      await refreshModels();
      setStatus(`${key} is ready.`);
    } catch (e) { setError(e.message); setStatus('Auxiliary download failed.'); }
    finally { setBusy(false); }
  };

  const watchEvents = useCallback(async () => {
    eventController.current?.abort();
    const controller = new AbortController();
    eventController.current = controller;
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const response = await fetch(`${normalizeBaseUrl(baseUrl)}/events`, { headers, signal: controller.signal });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6));
            if (event.type === 'generation') {
              setProgress(event);
              if (event.status === 'starting') setStatus('Loading the model…');
              else if (event.status === 'generating') setStatus(`Generating · ${event.step}/${event.totalSteps}`);
              else if (event.status === 'cancelled') setStatus('Generation cancelled.');
              else if (event.status === 'error') setStatus(event.error || 'Generation failed.');
            }
          } catch { /* Ignore incomplete or unrelated event frames. */ }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('Local server event stream disconnected:', e);
    }
  }, [baseUrl, token]);

  const generate = async (event) => {
    event.preventDefault();
    if (!modelId || !prompt.trim()) { setError('Choose a model and enter a prompt.'); return; }
    setBusy(true); setGenerating(true); setError(''); setImage(''); setProgress(null);
    const eventTask = watchEvents();
    try {
      const result = await request('/generate', {
        method: 'POST',
        body: JSON.stringify({ model: modelId, prompt: prompt.trim(), negative_prompt: negativePrompt || undefined, aspect_ratio: aspectRatio, steps: Number(steps), guidance_scale: Number(guidance), seed: Number(seed) }),
      });
      if (!result.url) throw new Error('The server did not return an image.');
      setImage(result.url);
      setStatus(`Complete · seed ${result.seed}`);
      setProgress({ progress: 1, step: Number(steps), totalSteps: Number(steps), status: 'done' });
    } catch (e) { setError(e.message); setStatus('Generation failed.'); }
    finally { eventController.current?.abort(); await eventTask; setBusy(false); setGenerating(false); }
  };

  const cancel = async () => {
    try { await request('/cancel', { method: 'POST', body: '{}' }); }
    catch (e) { setError(e.message); }
  };

  const selectedModel = models.find((model) => model.id === modelId);
  const missingAuxiliary = selectedModel?.requiresAuxiliary
    ? ['llm', 'vae'].filter((key) => selectedModel.auxiliaryStatus?.[key] !== 'downloaded')
    : [];

  return (
    <main className="min-h-screen bg-[#050505] text-white px-4 py-8 md:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <a href="/" className="text-xs text-cyan-300 hover:text-cyan-200">← Studio home</a>
          <h1 className="mt-4 text-3xl font-black">Self-hosted image generation</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/55">Connect this browser to your own local or remote sd.cpp server. Prompts and generation requests go to that server; this page does not require a Muapi key.</p>
        </header>

        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="font-bold">Inference server</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <label className="text-xs text-white/60">Server URL
              <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setConnected(false); }} disabled={busy} placeholder={DEFAULT_URL} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400" />
            </label>
            <label className="text-xs text-white/60">Bearer token (optional for loopback)
              <input type="password" value={token} onChange={(e) => { setToken(e.target.value); setConnected(false); }} disabled={busy} placeholder="LOCAL_AI_TOKEN" autoComplete="off" className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400" />
            </label>
            <button type="button" onClick={connect} disabled={busy} className="self-end rounded-lg bg-cyan-300 px-5 py-2 text-sm font-bold text-black hover:bg-cyan-200 disabled:opacity-40">Connect</button>
          </div>
          <p className="mt-3 text-xs text-white/45">For remote servers, use HTTPS or a trusted VPN/reverse proxy and configure the server’s exact browser origin in <code>LOCAL_AI_ALLOWED_ORIGINS</code>. Do not expose an unauthenticated server to the internet.</p>
          <p role="status" className={`mt-3 text-sm ${connected ? 'text-emerald-300' : 'text-white/60'}`}>{status}</p>
          {connected && !binaryAvailable && <button type="button" disabled={busy} onClick={installBinary} className="mt-3 rounded-lg border border-cyan-300/30 px-4 py-2 text-sm text-cyan-200 disabled:opacity-40">Install sd.cpp binary on server</button>}
          {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
          <form onSubmit={generate} className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="font-bold">Generate an image</h2>
            <label className="block text-xs text-white/60">Model
              <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={!connected || busy} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] px-3 py-2 text-sm text-white">
                {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.state}</option>)}
              </select>
            </label>
            {connected && models.find((model) => model.id === modelId)?.state !== 'downloaded' && modelId && (
              <button type="button" disabled={busy} onClick={() => downloadModel(modelId)} className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-40">Download model to server</button>
            )}
            {connected && missingAuxiliary.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-white/60">This model requires the missing Z-Image text encoder and/or VAE before generation.</p>
                {missingAuxiliary.map((key) => <button key={key} type="button" disabled={busy} onClick={() => downloadAuxiliary(key)} className="mr-2 rounded-lg border border-cyan-300/30 px-4 py-2 text-sm text-cyan-200 disabled:opacity-40">Download {key === 'llm' ? 'text encoder' : 'VAE'}</button>)}
              </div>
            )}
            <label className="block text-xs text-white/60">Prompt
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} required rows={4} maxLength={10000} placeholder="Describe the image to create" className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400" />
            </label>
            <label className="block text-xs text-white/60">Negative prompt (optional)
              <input value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-white/60">Aspect ratio<select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] px-3 py-2 text-sm text-white">{['1:1', '4:3', '3:4', '16:9', '9:16'].map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
              <label className="text-xs text-white/60">Steps<input type="number" min="1" max="150" value={steps} onChange={(e) => setSteps(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white" /></label>
              <label className="text-xs text-white/60">Guidance scale<input type="number" min="0" max="30" step="0.5" value={guidance} onChange={(e) => setGuidance(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white" /></label>
              <label className="text-xs text-white/60">Seed (-1 random)<input type="number" min="-1" value={seed} onChange={(e) => setSeed(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white" /></label>
            </div>
            <div className="flex gap-3">
              <button disabled={!connected || busy || !binaryAvailable || selectedModel?.state !== 'downloaded' || missingAuxiliary.length > 0} className="rounded-lg bg-cyan-300 px-5 py-2.5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-40">{generating ? 'Generating…' : 'Generate'}</button>
              {generating && <button type="button" onClick={cancel} className="rounded-lg border border-red-400/30 px-4 py-2 text-sm text-red-200">Cancel</button>}
            </div>
            {progress && <div aria-live="polite" className="text-xs text-white/60">{progress.status === 'generating' ? `Step ${progress.step}/${progress.totalSteps}` : status}<div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10"><div className="h-full bg-cyan-300 transition-all" style={{ width: `${Math.round((progress.progress || 0) * 100)}%` }} /></div></div>}
          </form>

          <section className="min-h-72 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="font-bold">Result</h2>
            {image ? <div className="mt-4"><img src={image} alt={prompt || 'Generated image'} className="max-h-[70vh] w-full rounded-lg object-contain" /><a href={image} download="generated.png" className="mt-3 inline-block rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/10">Download PNG</a></div> : <p className="mt-4 text-sm text-white/40">Your generated image will appear here.</p>}
          </section>
        </div>
        <p className="mt-6 text-xs text-white/40">This first server-connected client supports text-to-image with sd.cpp. Reference-image editing, video, and the other cloud-powered studios are not implemented by this server API yet.</p>
      </div>
    </main>
  );
}
