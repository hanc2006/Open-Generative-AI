'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const { pipeline } = require('node:stream/promises');

function downloadUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        net.isIP(url.hostname.replace(/^\[|\]$/g, '')) || /(^|\.)(localhost|local|internal)$/i.test(url.hostname)) {
        throw new Error('Download redirects must use a public HTTPS URL.');
    }
    return url;
}

function catalogPath(dir, filename) {
    if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..' ||
        path.basename(filename) !== filename || /[\\/:]/.test(filename)) throw new Error('Invalid catalog filename.');
    return path.join(dir, filename);
}

function request(url, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(downloadUrl(url), { headers }, resolve);
        req.setTimeout(60_000, () => req.destroy(new Error('Download timed out.')));
        req.on('error', reject);
    });
}

async function downloadFile(url, destination, onProgress) {
    const partial = `${destination}.part`;
    const headers = { 'User-Agent': 'open-generative-ai-local-server/1.0', Accept: '*/*' };
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                let current = url;
                let response;
                for (let redirects = 0; ; redirects++) {
                    const offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
                    response = await request(current, { ...headers, ...(offset ? { Range: `bytes=${offset}-` } : {}) });
                    if (![301, 302, 303, 307, 308].includes(response.statusCode)) break;
                    response.resume();
                    if (redirects >= 10 || !response.headers.location) throw new Error('Invalid or excessive download redirects.');
                    current = downloadUrl(new URL(response.headers.location, current)).toString();
                }
                const offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
                const code = response.statusCode;
                if (code !== 200 && code !== 206) {
                    response.resume();
                    throw new Error(`Download failed with HTTP ${code}.`);
                }
                if (code === 206) {
                    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
                    if (!match || Number(match[1]) !== offset || Number(match[2]) < offset ||
                        Number(match[2]) !== Number(match[3]) - 1 ||
                        (response.headers['content-length'] && Number(response.headers['content-length']) !== Number(match[2]) - offset + 1)) {
                        response.destroy();
                        throw new Error('Invalid download range response.');
                    }
                }
                const start = code === 206 ? offset : 0;
                const length = Number(response.headers['content-length'] || 0);
                const total = length ? start + length : 0;
                let received = start;
                response.on('data', chunk => {
                    received += chunk.length;
                    if (total) onProgress?.(Math.min(1, received / total));
                });
                await pipeline(response, fs.createWriteStream(partial, { flags: code === 206 ? 'a' : 'w' }));
                if (length && received !== total) throw new Error('Incomplete download.');
                fs.renameSync(partial, destination);
                return;
            } catch (error) {
                if (attempt >= 2) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    } catch (error) {
        fs.rmSync(partial, { force: true });
        throw error;
    }
}

function validateZip(zipPath) {
    const fd = fs.openSync(zipPath, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const tail = Buffer.alloc(Math.min(size, 65557));
        fs.readSync(fd, tail, 0, tail.length, size - tail.length);
        let eocd = tail.length - 22;
        while (eocd >= 0 && (tail.readUInt32LE(eocd) !== 0x06054b50 ||
            eocd + 22 + tail.readUInt16LE(eocd + 20) !== tail.length)) eocd--;
        if (eocd < 0) throw new Error('Invalid ZIP archive.');
        const count = tail.readUInt16LE(eocd + 10);
        const centralSize = tail.readUInt32LE(eocd + 12);
        const centralOffset = tail.readUInt32LE(eocd + 16);
        if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) ||
            count === 0xffff || centralSize > 32 * 1024 * 1024 || centralOffset + centralSize > size - tail.length + eocd) {
            throw new Error('Unsupported ZIP archive.');
        }
        const central = Buffer.alloc(centralSize);
        fs.readSync(fd, central, 0, central.length, centralOffset);
        let pos = 0;
        for (let i = 0; i < count; i++) {
            if (pos + 46 > central.length || central.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
            const nameLength = central.readUInt16LE(pos + 28);
            const extraLength = central.readUInt16LE(pos + 30);
            const commentLength = central.readUInt16LE(pos + 32);
            const end = pos + 46 + nameLength + extraLength + commentLength;
            if (end > central.length) throw new Error('Invalid ZIP directory.');
            const name = central.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
            const mode = central.readUInt32LE(pos + 38) >>> 16;
            if (!name || name.startsWith('/') || /[\\:\0]/.test(name) ||
                name.split('/').some(part => part === '..' || part === '.') || (mode & 0xf000) === 0xa000) {
                throw new Error('Unsafe path or link in ZIP archive.');
            }
            pos = end;
        }
        if (pos !== central.length) throw new Error('Invalid ZIP directory.');
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = { catalogPath, downloadFile, downloadUrl, validateZip };
