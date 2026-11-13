import { useEffect } from 'react';

// The Vite app is dark-only, so theming is pinned to dark.
export function ThemeProvider({ children }) {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);
  return children;
}

export const useTheme = () => ({
  theme: 'dark',
  resolvedTheme: 'dark',
  systemTheme: 'dark',
  themes: ['dark'],
  setTheme: () => {},
});
