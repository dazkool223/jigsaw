/**
 * The Room's join link: anyone with it can join, no signup. Copy-to-clipboard
 * with a transient confirmation. Rendered as a small tag resting on the table
 * beside the board (see theme.css).
 */

import { useEffect, useRef, useState } from "react";

export type ShareLinkProps = {
  readonly url: string;
};

export function ShareLink({ url }: ShareLinkProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Fallback for browsers without the async Clipboard API.
        inputRef.current?.select();
        document.execCommand("copy");
      }
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied/unavailable - the link is still selectable
      // and visible, so the user can copy it manually.
      inputRef.current?.select();
    }
  };

  return (
    <div className="tag share">
      {/* A readonly <input> can't ellipsize, so a long link gets sliced
          mid-character. This shows the link as text that truncates cleanly;
          the offscreen input exists only for the execCommand fallback path. */}
      <span className="share__url" title={url}>
        {url}
      </span>
      <input ref={inputRef} className="share__shadow" readOnly value={url} tabIndex={-1} aria-hidden="true" />
      <button type="button" className="share__btn" onClick={() => void handleCopy()}>
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
