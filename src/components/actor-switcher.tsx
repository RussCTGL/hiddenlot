"use client";

import { switchActor } from "@/app/actions";

export function ActorSwitcher({ users, current }: { users: { id: string; name: string; network: string }[]; current: string }) {
  return (
    <form action={switchActor} className="flex items-center gap-2">
      <label htmlFor="actor" className="text-xs text-zinc-500">
        Acting as
      </label>
      <select
        id="actor"
        name="user_id"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.network} — {u.name}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit">Switch</button>
      </noscript>
    </form>
  );
}
