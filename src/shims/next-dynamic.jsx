import { lazy, Suspense } from 'react';

export default function dynamic(loader, options = {}) {
  const Lazy = lazy(() => Promise.resolve(loader()).then((mod) => (mod && mod.default ? mod : { default: mod })));
  const Loading = options.loading;
  return function DynamicComponent(props) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
