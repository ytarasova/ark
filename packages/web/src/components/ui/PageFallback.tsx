/**
 * Tiny Suspense fallback for lazy-loaded pages.
 *
 * Intentionally almost invisible. React caches the lazy module after the
 * first successful import, so for normal tab switches this fallback is
 * visible for a frame or two at most -- enough time for the chunk to
 * resolve from cache. The previous version rendered a centered
 * "LOADING..." string that flashed on every nav click and drew the eye to
 * a transition that is supposed to feel instant.
 *
 * We keep the element for the a11y status so screen readers still see
 * "loading" during a real (uncached) chunk fetch, but make it visually
 * silent and sized like the page shell so layout doesn't jump.
 */
export function PageFallback() {
  return <div role="status" aria-live="polite" aria-label="Loading" className="flex h-full w-full" />;
}
