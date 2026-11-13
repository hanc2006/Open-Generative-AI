export default function Image({ fill, priority, unoptimized, quality, placeholder, blurDataURL, loader, sizes, style, alt = '', ...rest }) {
  const fillStyle = fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%' } : undefined;
  return <img alt={alt} loading={priority ? 'eager' : 'lazy'} style={{ ...fillStyle, ...style }} {...rest} />;
}
