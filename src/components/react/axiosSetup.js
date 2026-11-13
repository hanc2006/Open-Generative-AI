import axios from 'axios';

const UPSTREAM = 'https://api.muapi.ai';

// The packages call relative /api/* paths that Next.js used to proxy. In dev the Vite proxy
// handles them; in production they are rewritten to the upstream API here.
function toUpstream(url) {
  if (url.startsWith('/api/api/')) return `${UPSTREAM}${url.slice(4)}`;
  if (/^\/api\/(workflow|app|agents)(\/|\?|$)/.test(url)) return `${UPSTREAM}${url.slice(4)}`;
  if (url.startsWith('/api/v1/')) return `${UPSTREAM}${url}`;
  return url;
}

let installed = false;

export function installAxiosSetup() {
  if (installed) return;
  installed = true;
  axios.interceptors.request.use((config) => {
    const url = config.url || '';
    if (url.startsWith('/')) {
      const apiKey = window.__MUAPI_KEY__ || localStorage.getItem('muapi_key');
      if (apiKey) config.headers['x-api-key'] = apiKey;
      if (import.meta.env.PROD) config.url = toUpstream(url);
    }
    return config;
  });
}
