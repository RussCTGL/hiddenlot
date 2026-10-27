"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        The action did not complete and nothing was changed beyond what was already saved. {error.digest ? `Reference ${error.digest}.` : ""}
      </p>
      <button onClick={reset} className="mt-4 rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
        Try again
      </button>
    </main>
  );
}
