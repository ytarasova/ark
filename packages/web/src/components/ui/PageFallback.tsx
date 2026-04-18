/**
 * Tiny Suspense fallback for lazy-loaded pages.
 *
 * Intentionally avoids importing anything heavy -- it ships in the initial
 * chunk as the placeholder shown while a page bundle is being fetched.
 */

export function PageFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      className="flex h-full w-full items-center justify-center p-8 text-xs uppercase tracking-[0.12em] text-muted-foreground"
    >
      <span className="opacity-60">Loading...</span>
    </div>
  );
}
