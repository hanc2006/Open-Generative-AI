import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { getLang } from '../lib/i18n.js';

// Mounts a React studio from packages/studio into a vanilla DOM container.
export function ReactStudio(loadComponent) {
  const element = document.createElement('div');
  element.className = 'w-full h-full flex flex-col flex-1 overflow-hidden';

  loadComponent().then(({ default: Component }) => {
    createRoot(element).render(
      createElement(Component, {
        apiKey: window.__MUAPI_KEY__ || localStorage.getItem('muapi_key') || '',
        locale: getLang() === 'zh-CN' ? 'zh' : 'en',
      })
    );
  });

  return element;
}
