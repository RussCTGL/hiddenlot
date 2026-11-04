"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { startStoryAction } from "@/app/actions";
import { LogoIcon } from "@/components/icons";
import { atSeat } from "@/lib/seat";
import { Driver, PANE_SCALE, Stopped } from "./driver";
import { storySteps } from "./steps";

const PANES = [
  { name: "Ana", role: "Buyer", place: "Haiphong, Vietnam", network: "Network A" },
  { name: "Bo", role: "Stockist", place: "Busan, Korea", network: "Network B" },
] as const;

const noSubscribe = () => () => {};

type Phase = "intro" | "starting" | "playing" | "done" | "browse" | "failed";

const ctl =
  "inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const cta = "inline-flex h-11 items-center gap-2 rounded-xl bg-amber-500 px-5 text-base font-semibold text-zinc-950 shadow-lg shadow-amber-500/20 hover:bg-amber-400";

export function StoryPlayer({ meta, resets }: { meta: boolean; resets: boolean }) {
  // ?fast=1 uses the regex extractor instead of the model, for rehearsing the story quickly.
  const fast = useSyncExternalStore(
    noSubscribe,
    () => new URLSearchParams(location.search).has("fast"),
    () => false,
  );
  const steps = useMemo(() => storySteps(meta && !fast), [meta, fast]);
  const [phase, setPhase] = useState<Phase>("intro");
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [run, setRun] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [active, setActive] = useState<0 | 1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const driver = useRef<Driver | null>(null);
  const frames = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)];

  // The caption's live status line (e.g. the seconds a model call has taken) and the pane the action is in.
  useEffect(() => {
    const t = setInterval(() => {
      setStatus(driver.current?.status?.() ?? null);
      setActive(driver.current?.active ?? null);
    }, 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => driver.current?.stop(), []);

  const play = async () => {
    driver.current?.stop();
    const d = new Driver();
    driver.current = d;
    setPaused(false);
    setError(null);
    setStep(0);
    setPhase("starting");
    const r = await startStoryAction();
    if (d.stopped) return;
    if (r.error) {
      setError(r.error);
      setPhase("failed");
      return;
    }
    d.lotRef = r.lotRef;
    setRun((n) => n + 1); // fresh panes, signed in as Ana and Bo
    setPhase("playing");
    try {
      await d.until(() => frames[0].current && frames[1].current, 10_000, "the panes");
      d.frames = [frames[0].current, frames[1].current];
      for (let i = 0; i < steps.length; i++) {
        setStep(i);
        // A new step starts clean: no ring or zoom left on the other pane.
        for (const q of [0, 1] as const) if (q !== steps[i].pane) d.clear(q);
        d.active = steps[i].pane ?? null;
        try {
          await steps[i].run(d);
        } catch (e) {
          if (e instanceof Stopped || !steps[i].optional) throw e;
          d.status = null; // an optional step that cannot run here is left out
        }
      }
      d.clear(0);
      d.clear(1);
      setPhase("done");
    } catch (e) {
      if (e instanceof Stopped) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    } finally {
      d.status = null;
    }
  };

  const togglePause = () => {
    const d = driver.current;
    if (!d) return;
    d.paused = !d.paused;
    setPaused(d.paused);
  };

  // Space pauses, the right arrow skips the rest of a pause for reading.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== "playing") return;
      if (e.key === " ") {
        e.preventDefault();
        togglePause();
      } else if (e.key === "ArrowRight") driver.current?.next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const s = steps[step];
  const live = phase === "playing" || phase === "done" || phase === "browse" || phase === "failed";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* The dev-mode indicator would sit in the recording. */}
      <style>{"nextjs-portal { display: none !important; }"}</style>
      <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-5 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
        <Link href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="text-accent">
            <LogoIcon size={20} />
          </span>
          HiddenLot
        </Link>
        <ol className="hidden items-center gap-1 md:flex" aria-label="Story progress">
          {steps.map((x, i) => (
            <li
              key={x.title}
              title={x.title}
              className={`h-1.5 rounded-full transition-all ${i === step && phase === "playing" ? "w-8 bg-amber-500" : i < step || phase === "done" || phase === "browse" ? "w-3 bg-zinc-500" : "w-3 bg-zinc-300 dark:bg-zinc-700"}`}
            />
          ))}
        </ol>
        <span className="ml-auto flex items-center gap-2">
          {phase === "playing" && (
            <>
              <button type="button" className={ctl} onClick={togglePause} title="Space">
                {paused ? "▶ Resume" : "❚❚ Pause"}
              </button>
              <button type="button" className={ctl} onClick={() => driver.current?.next()} title="Right arrow: skip the rest of this pause">
                Next ›
              </button>
            </>
          )}
          {phase !== "intro" && phase !== "starting" && (
            <button type="button" className={ctl} onClick={play}>
              ↺ Restart
            </button>
          )}
          <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">Synthetic demo</span>
        </span>
      </header>

      {phase === "playing" && s && (
        <div className="flex items-start gap-5 border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
          <span className="mt-1 font-mono text-sm text-amber-600 dark:text-amber-400">
            {String(step + 1).padStart(2, "0")}/{steps.length}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{s.title}</h1>
            <p className="mt-1 max-w-5xl text-[17px] leading-relaxed text-zinc-600 dark:text-zinc-300">{s.body}</p>
          </div>
          {status && (
            <span className="mt-1 inline-flex shrink-0 items-center gap-2 rounded-full bg-amber-50 px-3 py-1.5 font-mono text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <span className="size-2 animate-pulse rounded-full bg-amber-500" />
              {status}
            </span>
          )}
        </div>
      )}

      <div className="relative grid min-h-0 flex-1 grid-cols-2 gap-3 p-3">
        {PANES.map((p, i) => {
          const on = phase === "playing" && active === i;
          const dim = phase === "playing" && active !== null && active !== i;
          return (
            <section
              key={p.name}
              className={`flex min-h-0 flex-col overflow-hidden rounded-xl border bg-white shadow-sm transition duration-500 dark:bg-zinc-900 ${on ? "border-amber-500 ring-2 ring-amber-500/60" : "border-zinc-200 dark:border-zinc-800"} ${dim ? "opacity-60" : ""}`}
            >
              <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
                <span className={`flex size-8 items-center justify-center rounded-full text-sm font-semibold ${i === 0 ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"}`}>
                  {p.name[0]}
                </span>
                <span className="text-sm">
                  <b className="font-semibold">{p.name}</b>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {" "}
                    · {p.role} · {p.place}
                  </span>
                </span>
                <span className="ml-auto rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">{p.network}</span>
              </div>
              {live ? (
                // The frame can be zoomed like a camera; this box keeps it inside the pane.
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <iframe key={run} ref={frames[i]} src={atSeat((i + 1) as 1 | 2, "/")} title={`${p.name}'s screen`} className="absolute top-0 left-0 origin-top-left border-0 bg-zinc-50 dark:bg-zinc-950"
                    style={{ width: `${100 / PANE_SCALE}%`, height: `${100 / PANE_SCALE}%`, transform: `scale(${PANE_SCALE})` }}
                  />
                </div>
              ) : (
                <div className="flex-1 bg-zinc-50 dark:bg-zinc-950" />
              )}
            </section>
          );
        })}

        {(phase === "intro" || phase === "starting") && (
          <Card>
            <p className="text-sm font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">A three-minute story</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight">The coil Ana needs is sitting in Bo&apos;s chat.</h1>
            <p className="mt-4 text-lg leading-relaxed text-zinc-600 dark:text-zinc-300">
              Surplus steel is offered in chat messages inside closed trade networks. HiddenLot reads those offers with Meta Muse Spark, checks every value in code, and matches them to buyers in other networks, all the way to
              a checked order.
            </p>
            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
              Both screens are the real app, signed in as two different accounts. Every click is a real action.{" "}
              {resets ? "Playing resets the local demo first." : "It adds a new lot to the shared demo."}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button type="button" className={cta} onClick={play} disabled={phase === "starting"}>
                {phase === "starting" ? "Setting up…" : "▶ Play the story"}
              </button>
              <Link href="/demo" className="text-sm font-medium text-accent hover:underline">
                Or explore both accounts yourself
              </Link>
            </div>
          </Card>
        )}

        {phase === "done" && (
          <Card>
            <p className="text-sm font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">What you just saw</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">From a chat message to a checked order, without a single guessed value.</h1>
            <dl className="mt-6 grid grid-cols-3 gap-4">
              {[
                ["261 / 261", "critical fields correct on an unseen synthetic test set"],
                ["0", "candidates shown that break a known hard requirement"],
                ["21 / 21", "unsupported values the model claimed, all caught by the code checks"],
              ].map(([n, t]) => (
                <div key={n} className="rounded-xl bg-zinc-100 p-4 dark:bg-zinc-800">
                  <dt className="font-mono text-2xl font-semibold">{n}</dt>
                  <dd className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{t}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">Synthetic data only. Results are from small synthetic test sets; see the README for method and caveats.</p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" className={cta} onClick={play}>
                ↺ Play again
              </button>
              <button type="button" className={ctl} onClick={() => setPhase("browse")}>
                Look around the panes
              </button>
              <Link href="/demo" className="text-sm font-medium text-accent hover:underline">
                Explore both accounts yourself
              </Link>
            </div>
          </Card>
        )}

        {phase === "failed" && (
          <div className="absolute inset-x-0 bottom-6 mx-auto w-fit max-w-xl rounded-xl border border-rose-300 bg-white px-5 py-3 text-sm shadow-lg dark:border-rose-800 dark:bg-zinc-900">
            <b className="text-rose-700 dark:text-rose-400">The story stopped at step {step + 1}.</b> {error}{" "}
            <button type="button" className="font-medium text-accent hover:underline" onClick={play}>
              Restart
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-100/70 p-6 backdrop-blur-sm dark:bg-zinc-950/70">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">{children}</div>
    </div>
  );
}
