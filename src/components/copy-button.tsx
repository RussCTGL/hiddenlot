"use client";

import { useState } from "react";
import { CopyIcon } from "./icons";

/** Copies a drafted message; HiddenLot never sends messages itself. */
export function CopyButton({ text, className }: { text: string; className: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      <CopyIcon size={16} />
      {copied ? "Copied" : "Copy message"}
    </button>
  );
}
