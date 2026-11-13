const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseProgress,
    resolveGuidance,
    resolveSteps,
    startupMessage,
} = require('../server/runtime');

test('resolveSteps prefers explicit request over model defaults', () => {
    const steps = resolveSteps({ steps: 3 }, { defaultSteps: 20 });
    assert.equal(steps, 3);
});

test('resolveGuidance prefers explicit request over model defaults', () => {
    const guidance = resolveGuidance({ guidance_scale: 5.25 }, { defaultGuidance: 7.5 });
    assert.equal(guidance, 5.25);
});

test('startupMessage surfaces elapsed startup time', () => {
    assert.equal(startupMessage(0), 'Starting local model...');
    assert.equal(startupMessage(12_400), 'Loading local model (12s)...');
    assert.equal(startupMessage(65_000), 'Loading local model (1m 5s)...');
});

test('parseProgress extracts sd-cli sampling progress from carriage-return output', () => {
    const state = { tail: '', lastStep: 0, lastTotalSteps: 0 };
    const chunk = '\r  |==>                                               | 1/20 - 7.16s/it\u001b[K\r  |=====>                                            | 2/20 - 6.98s/it\u001b[K';
    const events = parseProgress(chunk, state);

    assert.deepEqual(events, [
        { step: 1, totalSteps: 20, progress: 0.05, status: 'generating' },
        { step: 2, totalSteps: 20, progress: 0.1, status: 'generating' },
    ]);
});

test('parseProgress de-duplicates repeated progress events across chunks', () => {
    const state = { tail: '', lastStep: 0, lastTotalSteps: 0 };
    const first = parseProgress('\r  |==> | 1/20 - 7.16s/it\u001b[K', state);
    const second = parseProgress('\r  |==> | 1/20 - 7.16s/it\u001b[K\r  |=====> | 2/20 - 6.98s/it\u001b[K', state);

    assert.deepEqual(first, [{ step: 1, totalSteps: 20, progress: 0.05, status: 'generating' }]);
    assert.deepEqual(second, [{ step: 2, totalSteps: 20, progress: 0.1, status: 'generating' }]);
});

test('parseProgress does not replay old buffered steps when later chunks include earlier output', () => {
    const state = { tail: '', lastStep: 0, lastTotalSteps: 0 };
    const first = parseProgress('\r  |==> | 1/3 - 1.00s/it\u001b[K\r  |=====> | 2/3 - 1.00s/it\u001b[K', state);
    const second = parseProgress('\r  |==> | 1/3 - 1.00s/it\u001b[K\r  |=====> | 2/3 - 1.00s/it\u001b[K\r  |========> | 3/3 - 1.00s/it\u001b[K', state);

    assert.deepEqual(first, [
        { step: 1, totalSteps: 3, progress: 1 / 3, status: 'generating' },
        { step: 2, totalSteps: 3, progress: 2 / 3, status: 'generating' },
    ]);
    assert.deepEqual(second, [
        { step: 3, totalSteps: 3, progress: 1, status: 'generating' },
    ]);
});
