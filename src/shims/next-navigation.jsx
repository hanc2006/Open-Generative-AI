import { createContext, useContext, useMemo, useRef, useState } from 'react';

// In-memory stand-in for next/navigation so the Next-era studio/workflow/agent packages
// run inside the single-page Vite shell. Each host owns its own router instance.
const RouterContext = createContext(null);

const ROUTES = [
  '/workflow/:id/:tab',
  '/workflow/:id',
  '/agents/edit/:id',
  '/agents/:agent_id/:conversation_id',
  '/agents/:agent_id',
];

export function matchRoute(path) {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  for (const route of ROUTES) {
    const parts = route.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params = {};
    const ok = parts.every((part, i) => {
      if (part.startsWith(':')) { params[part.slice(1)] = decodeURIComponent(segments[i]); return true; }
      return part === segments[i];
    });
    if (ok) return params;
  }
  return {};
}

export function MemoryRouter({ initialPath, children }) {
  const [path, setPath] = useState(initialPath);
  const history = useRef([initialPath]);

  const value = useMemo(() => {
    const go = (next, replace) => {
      if (replace) history.current[history.current.length - 1] = next;
      else history.current.push(next);
      setPath(next);
    };
    return {
      path,
      router: {
        push: (next) => go(next, false),
        replace: (next) => go(next, true),
        back: () => {
          if (history.current.length > 1) history.current.pop();
          setPath(history.current[history.current.length - 1]);
        },
        forward: () => {},
        refresh: () => {},
        prefetch: () => {},
      },
    };
  }, [path]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export const useRouter = () => useContext(RouterContext)?.router ?? { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
export const usePathname = () => (useContext(RouterContext)?.path ?? '/').split('?')[0];
export const useParams = () => matchRoute(useContext(RouterContext)?.path ?? '/');
export const useSearchParams = () => new URLSearchParams((useContext(RouterContext)?.path ?? '').split('?')[1] || '');
export const redirect = () => {};
