// The F wordmark from public/favicon.svg, inlined so it can be sized/colored
// like any other icon component in the header.
export function AppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden>
      <rect width="1024" height="1024" rx="224" fill="#171717" />
      <rect x="352" y="256" width="128" height="512" rx="56" fill="#FAFAFA" />
      <path
        d="M400,256 h188 a64,64 0 0 1 0,128 h-188 z"
        fill="#FAFAFA"
      />
      <path
        d="M480,464 h108 a64,64 0 0 1 0,128 h-108 z"
        fill="#10B981"
      />
    </svg>
  );
}
