const path = require('node:path');

function pickBinaryAssetForPlatform({ platform, arch, zipNames }) {
    const candidates = zipNames.filter(name => name.startsWith('sd-master-') || name.includes('-bin-'));
    if (platform === 'darwin') return arch === 'arm64' ? candidates.find(n => n.includes('Darwin') && n.includes('arm64')) || null : null;
    if (platform === 'win32') {
        const windows = candidates.filter(name => /win-(avx2?|avx512|noavx|cuda12|cu12)-x64/.test(name));
        for (const tag of ['win-avx2-x64', 'win-avx-x64', 'win-avx512-x64', 'win-noavx-x64', 'win-cuda12-x64', 'win-cu12-x64']) {
            const found = windows.find(name => name.includes(tag));
            if (found) return found;
        }
        return null;
    }
    if (platform === 'linux' && arch === 'arm64') {
        const arm = candidates.filter(name => name.includes('Linux') && (name.includes('aarch64') || name.includes('arm64')));
        return arm.find(n => !/rocm|vulkan/i.test(n)) || arm.find(n => n.includes('vulkan')) || arm.find(n => n.includes('rocm')) || null;
    }
    const linux = candidates.filter(name => name.includes('Linux') && name.includes('x86_64'));
    return linux.find(n => !/rocm|vulkan/i.test(n)) || linux.find(n => n.includes('vulkan')) || linux.find(n => n.includes('rocm')) || null;
}
function getBundledBinaryResourceDir({ resourcesPath, platform, arch }) {
    const pathLib = platform === 'win32' ? path.win32 : path.posix;
    return pathLib.join(resourcesPath, 'local-ai', `${platform}-${arch}`, 'bin');
}
function resolveRedirectUrl(location, requestUrl) {
    if (!location) throw new Error(`Redirect from ${requestUrl} has no Location header`);
    return new URL(location, requestUrl).toString();
}
module.exports = { getBundledBinaryResourceDir, pickBinaryAssetForPlatform, resolveRedirectUrl };
