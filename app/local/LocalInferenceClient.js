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
  const [connecting, setConnecting] = useState(false);
  const [session, setSession] = useState(null);
  const [streamReady, setStreamReady] = useState(false);
  const [binary, setBinary] = useState(null);
  const [auxiliaries, setAuxiliaries] = useState([]);
  const [operation, setOperation] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [downloads, setDownloads] = useState({});
  const [image, setImage] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const generationId = useRef(null);
  const cancelledId = useRef(null);

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
    setError(''); setStatus('Connecting…'); setConnected(false); setSession(null);
    setStreamReady(false); setConnecting(true); setDownloads({}); setGenerating(false);
    try {
      const [health, result, auxiliaryResult] = await Promise.all([request('/health'), request('/models'), request('/auxiliaries')]);
      setBinary(health);
      setAuxiliaries(auxiliaryResult.auxiliaries || []);
      setModels(result.models || []);
      setModelId((current) => (result.models || []).some((model) => model.id === current) ? current : (result.models || [])[0]?.id || '');
      setConnected(true);
      setGenerating(Boolean(health.active));
      setSession({ base: normalizeBaseUrl(baseUrl), token });
      setStatus('Connected. Connecting to progress stream…');
      localStorage.setItem(URL_KEY, normalizeBaseUrl(baseUrl));
      if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      setError(e.message); setStatus('Could not connect. Check the URL, server status, token, and CORS allowlist.');
    } finally { setConnecting(false); }
  }, [baseUrl, request, token]);

  const refreshSetup = useCallback(async () => {
    const [health, result, auxiliaryResult] = await Promise.all([request('/health'), request('/models'), request('/auxiliaries')]);
    setBinary(health);
    setModels(result.models || []);
    setAuxiliaries(auxiliaryResult.auxiliaries || []);
  }, [request]);

  const download = async (id, path, label) => {
    setOperation('download'); setError(''); setStatus(`Downloading ${label}…`);
    setDownloads((current) => ({ ...current, [id]: { id, phase: 'starting', progress: 0 } }));
    try {
      await request(path, { method: 'POST' });
      await refreshSetup();
      setDownloads((current) => ({ ...current, [id]: { id, phase: 'done', progress: 1 } }));
      setStatus(`${label} is ready.`);
    } catch (e) {
      setDownloads((current) => ({ ...current, [id]: { ...current[id], id, phase: 'error', error: e.message } }));
      setError(e.message); setStatus(`${label} download failed.`);
      try { await refreshSetup(); } catch { /* Keep the original error. */ }
    } finally { setOperation(null); }
  };

  useEffect(() => {
    if (!session) return undefined;
    const controller = new AbortController();
    let timer;
    const handleEvent = (event) => {
      if (event.type === 'connected') {
        setGenerating(Boolean(event.activeId));
      } else if (event.type === 'download' && event.id) {
        setDownloads((current) => ({ ...current, [event.id]: event }));
        if (event.phase === 'done' || event.phase === 'error') {
          refreshSetup().catch((e) => { if (!controller.signal.aborted) setError(`Could not refresh setup: ${e.message}`); });
        }
      } else if (event.type === 'generation') {
        if (event.status === 'starting' && event.id !== generationId.current) {
          generationId.current = event.id;
        }
        if (event.id && event.id === cancelledId.current && event.status === 'error') return;
        setProgress(event);
        if (event.status === 'starting' || event.status === 'generating') setGenerating(true);
        if (['done', 'cancelled', 'error'].includes(event.status)) setGenerating(false);
        if (event.status === 'starting') setStatus(event.message || 'Loading the model…');
        else if (event.status === 'generating') setStatus(`Generating · ${event.step}/${event.totalSteps}`);
        else if (event.status === 'done') setStatus('Generation complete.');
        else if (event.status === 'cancelled') { cancelled.current = true; cancelledId.current = event.id; setStatus('Generation cancelled.'); }
        else if (event.status === 'error') { setError(event.error || 'Generation failed.'); setStatus('Generation failed.'); }
      }
    };
    const watch = async () => {
      while (!controller.signal.aborted) {
        let reader;
        try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const response = await fetch(`${normalizeBaseUrl(baseUrl)}/events`, { headers, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Event stream returned HTTP ${response.status}`);
      if (controller.signal.aborted) break;
      reader = response.body.getReader();
      await refreshSetup();
      if (controller.signal.aborted) break;
      setStreamReady(true);
      setStatus('Connected to server and progress stream.');
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r\n\r\n|\n\n|\r\r/);
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const data = frame.split(/\r\n|\n|\r/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          if (controller.signal.aborted) break;
          try { handleEvent(JSON.parse(data)); } catch { /* Ignore malformed events. */ }
        }
      }
        } catch (e) {
          if (reader) reader.cancel().catch(() => {});
          if (controller.signal.aborted) break;
          console.warn('Local server event stream disconnected:', e);
        }
        if (controller.signal.aborted) break;
        setStreamReady(false);
        setDownloads((current) => Object.fromEntries(Object.entries(current).map(([id, item]) => [
          id, ['done', 'error', 'cancelled'].includes(item.phase) ? item : { ...item, phase: 'interrupted' },
        ])));
        setStatus('Progress stream disconnected. Reconnecting…');
        await new Promise((resolve) => {
          const finish = () => { controller.signal.removeEventListener('abort', finish); resolve(); };
          timer = setTimeout(finish, 2000);
          controller.signal.addEventListener('abort', finish, { once: true });
        });
      }
    };
    watch();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [session, refreshSetup, baseUrl, token]);

  const selectedModel = models.find((model) => model.id === modelId);
  const auxiliaryStatus = selectedModel?.auxiliaryStatus || {};
  const missingAuxiliary = Object.entries(auxiliaryStatus).filter(([, state]) => state !== 'downloaded');
  const auxiliaryReady = Object.keys(auxiliaryStatus).length > 0 ? missingAuxiliary.length === 0 : !selectedModel?.requiresAuxiliary;
  const downloadActive = Object.values(downloads).some((item) => !['done', 'error', 'cancelled', 'interrupted'].includes(item.phase));
  const busy = Boolean(operation || generating || downloadActive);
  const ready = connected && streamReady && binary?.exists && selectedModel?.state === 'downloaded' && auxiliaryReady && !busy;

  const generate = async (event) => {
    event.preventDefault();
    if (!ready || !prompt.trim()) { setError('Complete setup, choose a model, and enter a prompt.'); return; }
    cancelled.current = false;
    setOperation('generation'); setGenerating(true); setError(''); setImage(''); setProgress(null); setStatus('Starting generation…');
    try {
      const result = await request('/generate', {
        method: 'POST',
        body: JSON.stringify({ model: modelId, prompt: prompt.trim(), negative_prompt: negativePrompt || undefined, aspect_ratio: aspectRatio, steps: Number(steps), guidance_scale: Number(guidance), seed: Number(seed) }),
      });
      if (!result.url) throw new Error('The server did not return an image.');
      setImage(result.url);
      setStatus(`Complete · seed ${result.seed}`);
      setProgress({ progress: 1, step: Number(steps), totalSteps: Number(steps), status: 'done' });
    } catch (e) {
      if (cancelled.current) setStatus('Generation cancelled.');
      else { setError(e.message); setStatus('Generation failed.'); }
    } finally { setGenerating(false); setOperation(null); setCancelling(false); }
  };

  const cancel = async () => {
    setCancelling(true);
    cancelled.current = true;
    try { await request('/cancel', { method: 'POST', body: '{}' }); setStatus('Cancellation requested.'); }
    catch (e) { cancelled.current = false; setError(e.message); }
    finally { setCancelling(false); }
  };

  const disconnect = () => {
    setSession(null); setConnected(false); setStreamReady(false);
    setStatus('Enter a server URL and connect.');
  };

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
              <input value={baseUrl} disabled={busy || connecting} onChange={(e) => { disconnect(); setBaseUrl(e.target.value); }} placeholder={DEFAULT_URL} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400" />
            </label>
            <label className="text-xs text-white/60">Bearer token (optional for loopback)
              <input type="password" value={token} disabled={busy || connecting} onChange={(e) => { disconnect(); setToken(e.target.value); }} placeholder="LOCAL_AI_TOKEN" autoComplete="off" className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400" />
            </label>
            <button type="button" disabled={busy || connecting} onClick={connect} className="self-end rounded-lg bg-cyan-300 px-5 py-2 text-sm font-bold text-black hover:bg-cyan-200 disabled:opacity-40">{connecting ? 'Connecting…' : 'Connect'}</button>
          </div>
          <p className="mt-3 text-xs text-white/45">For remote servers, use HTTPS or a trusted VPN/reverse proxy and configure the server’s exact browser origin in <code>LOCAL_AI_ALLOWED_ORIGINS</code>. Do not expose an unauthenticated server to the internet.</p>
          <p role="status" className={`mt-3 text-sm ${connected ? 'text-emerald-300' : 'text-white/60'}`}>{status}</p>
          {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
          {connected && <div className="mt-4 space-y-3 text-sm text-white/70">
            <p>sd.cpp: {binary?.exists ? 'Ready' : 'Not installed'}{binary?.path ? ` · ${binary.path}` : ''}</p>
            {!binary?.exists && <button type="button" disabled={busy || !streamReady} onClick={() => download('__binary__', '/binary/download', 'sd.cpp')} className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-40">Download sd.cpp</button>}
            {Object.values(downloads).map((item) => {
              const label = item.id === '__binary__' ? 'sd.cpp' : auxiliaries.find((aux) => aux.id === item.id)?.displayName || models.find((model) => model.id === item.id)?.name || item.id;
              const percent = Number.isFinite(item.progress) ? Math.round(Math.max(0, Math.min(1, item.progress)) * 100) : null;
              return <div key={item.id} aria-live="polite">
                <p>{label} · {item.phase}{percent !== null ? ` · ${percent}%` : ''}{item.error ? ` · ${item.error}` : ''}</p>
                {percent !== null && <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/10"><div className="h-full bg-cyan-300 transition-all" style={{ width: `${percent}%` }} /></div>}
              </div>;
            })}
          </div>}
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
          <form onSubmit={generate} className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="font-bold">Generate an image</h2>
            <label className="block text-xs text-white/60">Model
              <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={!connected || busy} className="mt-1 w-full rounded-lg border border-white/10 bg-[#111] px-3 py-2 text-sm text-white">
                {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.state}</option>)}
              </select>
            </label>
            {connected && selectedModel?.state !== 'downloaded' && modelId && (
              <button type="button" disabled={busy || !streamReady} onClick={() => download(modelId, `/models/${encodeURIComponent(modelId)}/download`, selectedModel?.name || modelId)} className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-40">Download model to server</button>
            )}
            {connected && Object.entries(auxiliaryStatus).map(([key, state]) => {
              const auxiliary = auxiliaries.find((item) => item.key === key);
              return <div key={key} className="text-sm text-white/70">
                <p>{auxiliary?.displayName || key} · {state}</p>
                {state !== 'downloaded' && auxiliary && <button type="button" disabled={busy || !streamReady} onClick={() => download(auxiliary.id, `/auxiliaries/${encodeURIComponent(key)}/download`, auxiliary.displayName || key)} className="mt-2 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-40">Download {auxiliary.displayName || key}</button>}
              </div>;
            })}
            {connected && selectedModel?.requiresAuxiliary && !Object.keys(auxiliaryStatus).length && <p className="text-sm text-amber-300">Required component status is unavailable. Reconnect to check setup.</p>}
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
              <button disabled={!ready || !prompt.trim()} className="rounded-lg bg-cyan-300 px-5 py-2.5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-40">{operation === 'generation' || generating ? 'Generating…' : 'Generate'}</button>
              {(generating || operation === 'generation') && <button type="button" disabled={cancelling} onClick={cancel} className="rounded-lg border border-red-400/30 px-4 py-2 text-sm text-red-200 disabled:opacity-40">{cancelling ? 'Cancelling…' : 'Cancel'}</button>}
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
