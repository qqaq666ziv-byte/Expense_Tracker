export function BrandMark({ className = 'h-11 w-11' }: { className?: string }) {
  return (
    <span className={`brand-mark ${className}`} aria-hidden="true">
      <img src="/icons/icon-192.png" alt="" />
    </span>
  );
}
