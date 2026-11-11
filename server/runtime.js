const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function resolveSteps(params, model) {
    const value = Number(params.steps);
    return Number.isFinite(value) && value > 0 ? Math.min(150, Math.round(value)) : model.defaultSteps || 20;
}

function resolveGuidance(params, model) {
    const value = Number(params.guidance_scale);
    return Number.isFinite(value) ? Math.max(0, Math.min(30, value)) : model.defaultGuidance || 7.5;
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

function parseProgress(chunk, state) {
    const text = `${state.tail}${String(chunk).replace(ANSI_RE, '').replace(/\r/g, '\n')}`;
    const matches = [...text.matchAll(/(?:step\s+)?(\d+)\s*\/\s*(\d+)/ig)];
    const events = [];
    for (const match of matches) {
        const step = Number(match[1]);
        const totalSteps = Number(match[2]);
        if (totalSteps > 0 && step > state.lastStep) {
            state.lastStep = step;
            events.push({ step, totalSteps, progress: Math.min(1, step / totalSteps), status: 'generating' });
        }
    }
    state.tail = text.slice(-512);
    return events;
}

module.exports = { dimensions, parseProgress, resolveGuidance, resolveSteps };
