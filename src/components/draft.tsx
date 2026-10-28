import { CopyButton } from "./copy-button";
import { SparkIcon } from "./icons";

/** A message HiddenLot drafted from shared fields; the user copies and sends it. */
export function Draft({ text }: { text: string }) {
  return (
    <div className="space-y-2 rounded-lg bg-zinc-100 px-3.5 py-3 text-[13px] leading-relaxed text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
          <span className="text-accent">
            <SparkIcon size={14} />
          </span>
          Draft · from shared fields
        </span>
        <CopyButton text={text} className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-accent hover:bg-white dark:hover:bg-zinc-900" />
      </div>
      <p>{text}</p>
    </div>
  );
}
