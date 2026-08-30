/**
 * The seam between the React chrome and the PixiJS renderer (owned by a
 * concurrently-developed module, src/render/). This component knows NOTHING
 * about Pixi, WebGL or the renderer's API - it only owns a full-size DOM
 * container and hands the raw element to whoever is told to mount into it.
 *
 * `onMount` is called once the container element exists, and may return a
 * cleanup function (mirroring a React effect) which is invoked on unmount or
 * before a re-mount. Nothing here renders puzzle content itself - see
 * app.tsx's `// TODO(wiring):` comment for where the real renderer attaches.
 */

import { useEffect, useRef } from "react";

export type BoardMountProps = {
  readonly onMount: (el: HTMLDivElement) => void | (() => void);
};

export function BoardMount({ onMount }: BoardMountProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const cleanup = onMount(el);
    return () => {
      if (typeof cleanup === "function") cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMount]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
      }}
    />
  );
}
