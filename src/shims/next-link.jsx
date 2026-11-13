import { useRouter } from './next-navigation.jsx';

export default function Link({ href, replace, prefetch, scroll, onClick, children, ...rest }) {
  const router = useRouter();
  const url = typeof href === 'string' ? href : href?.pathname || '/';
  const external = /^(https?:)?\/\//i.test(url);
  return (
    <a
      href={url}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || external || event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
        event.preventDefault();
        (replace ? router.replace : router.push)(url);
      }}
    >
      {children}
    </a>
  );
}
