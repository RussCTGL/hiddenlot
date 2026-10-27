"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/app/actions";

// Client wrappers so server actions can report validation errors inline.

export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      {state?.error && <p className="mt-2 text-sm text-rose-700 dark:text-rose-400" role="alert">{state.error}</p>}
      {state?.ok && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400" role="status">{state.ok}</p>}
    </form>
  );
}

export function Submit({
  children,
  className,
  pending,
  name,
  value,
  disabled = false,
  title,
}: {
  children: ReactNode;
  className: string;
  pending?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  title?: string;
}) {
  const status = useFormStatus();
  return (
    <button type="submit" name={name} value={value} title={title} className={className} disabled={disabled || status.pending}>
      {status.pending ? (pending ?? "Working…") : children}
    </button>
  );
}
