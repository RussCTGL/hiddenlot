"use client";

import { switchActor } from "@/app/actions";

export function ActorSwitcher({ users, current }: { users: { id: string; name: string; network: string }[]; current: string }) {
  return (
    <form action={switchActor} className="flex items-center gap-2">
      <label htmlFor="actor" className="text-[13px] text-zinc-500 dark:text-zinc-400">
        Acting as
      </label>
      <select
        id="actor"
        name="user_id"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="min-h-10 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium dark:border-zinc-700 dark:bg-zinc-900"
      >
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.network} · {u.name}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit">Switch</button>
      </noscript>
    </form>
  );
}
