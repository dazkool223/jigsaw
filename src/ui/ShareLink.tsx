/**
 * The Room's join link: anyone with it can join, no signup. Copy-to-clipboard
 * with a transient "Copied" confirmation.
 */

import { useRef, useState, type CSSProperties } from "react";

export type ShareLinkProps = {
  readonly url: string;
};

export function ShareLink({ url }: ShareLinkProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied/unavailable — the link is still selectable
      // and visible, so the user can copy it manually.
      inputRef.current?.select();
    }
  };

  return (
    <div style={styles.container}>
      <input ref={inputRef} readOnly value={url} style={styles.input} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" onClick={() => void handleCopy()} style={styles.button}>
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid #3a3f4b",
    background: "#12141a",
    color: "#e8eaf0",
    fontSize: 13,
    fontFamily: "ui-monospace, monospace",
  },
  button: {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid #4363d8",
    background: "#4363d8",
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
};
