"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A file field with its own English label, instead of the browser's "Choose
 * file / No file chosen" in the visitor's language. The real input stays in
 * the form (visually hidden), so forms, validation and DemoFile work as before.
 */
export function FileInput({ name = "file", accept, required, label, className = "" }: { name?: string; accept?: string; required?: boolean; label?: string; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    const input = ref.current;
    const form = input?.form;
    if (!input) return;
    // DemoFile sets files from outside React, so listen on the element itself.
    const changed = () => setFile(input.files?.[0]?.name ?? null);
    const reset = () => setFile(null);
    input.addEventListener("change", changed);
    form?.addEventListener("reset", reset);
    return () => {
      input.removeEventListener("change", changed);
      form?.removeEventListener("reset", reset);
    };
  }, []);
  return (
    <label className={`relative flex min-w-0 cursor-pointer items-center gap-2.5 text-xs ${className}`}>
      <input ref={ref} type="file" name={name} accept={accept} required={required} aria-label={label} className="peer absolute inset-0 size-full cursor-pointer opacity-0" />
      <span className="inline-flex h-8 shrink-0 items-center rounded-md border border-zinc-300 bg-white px-2.5 font-medium text-zinc-800 peer-focus-visible:outline-2 peer-focus-visible:outline-accent dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
        Choose file
      </span>
      <span className={`truncate ${file ? "text-zinc-800 dark:text-zinc-200" : "text-zinc-500 dark:text-zinc-400"}`}>{file ?? "No file chosen"}</span>
    </label>
  );
}
