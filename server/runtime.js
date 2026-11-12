const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function coerceFiniteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function resolveSteps(params, model) {
    const requested = coerceFiniteNumber(params?.steps);
    if (requested !== null && requested > 0) return Math.min(150, Math.max(1, Math.round(requested)));
    const fallback = coerceFiniteNumber(model?.defaultSteps);
    return fallback !== null && fallback > 0 ? Math.round(fallback) : 20;
}
function resolveGuidance(params, model) {
    const requested = coerceFiniteNumber(params?.guidance_scale);
    if (requested !== null) return Math.max(0, Math.min(30, requested));
    const fallback = coerceFiniteNumber(model?.defaultGuidance);
    return fallback !== null ? fallback : 7.5;
}
function startupMessage(elapsedMs) {
    const seconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    if (seconds < 10) return 'Starting local model...';
    if (seconds < 60) return `Loading local model (${seconds}s)...`;
    return `Loading local model (${Math.floor(seconds / 60)}m ${seconds % 60}s)...`;
}
function dimensions(aspectRatio, type) {
    const base = type === 'sdxl' || type === 'z-image' ? 1024 : 512;
    const ratios = {
        '1:1': [base, base],
        '16:9': [Math.round(base * 16 / 9 / 64) * 64, base],
        '9:16': [base, Math.round(base * 16 / 9 / 64) * 64],
        '4:3': [Math.round(base * 4 / 3 / 64) * 64, base],
        '3:4': [base, Math.round(base * 4 / 3 / 64) * 64],
    };
    return ratios[aspectRatio] || ratios['1:1'];
}
function parseProgress(chunk, state = { tail: '', lastStep: 0, lastTotalSteps: 0 }) {
    const combined = `${state.tail}${String(chunk).replace(ANSI_RE, '').replace(/\r/g, '\n')}`;
    const events = [];
    const patterns = [/step\s+(\d+)\s*\/\s*(\d+)/ig, /(\d+)\s*\/\s*(\d+)\s*-\s*[\d.]+s\/it/ig];
    for (const pattern of patterns) {
        let match = pattern.exec(combined);
        while (match) {
            const step = Number.parseInt(match[1], 10);
            const totalSteps = Number.parseInt(match[2], 10);
            if (Number.isFinite(step) && Number.isFinite(totalSteps) && totalSteps > 0) {
                if (totalSteps !== state.lastTotalSteps) { state.lastTotalSteps = totalSteps; state.lastStep = 0; }
                if (step > state.lastStep) {
                    state.lastStep = step;
                    events.push({ step, totalSteps, progress: Math.min(1, step / totalSteps), status: 'generating' });
                }
            }
            match = pattern.exec(combined);
        }
    }
    state.tail = combined.slice(-1024);
    return events;
}

module.exports = { dimensions, parseProgress, resolveGuidance, resolveSteps, startupMessage };
