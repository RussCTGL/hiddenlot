import { Suspense } from "react";
import { signInAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { buttonCls, Card, inputCls, Label, Loading, Page, primaryCls } from "@/components/ui";
import { getDb } from "@/db/server";
import { demoLoaded, getSession } from "@/lib/session";
import { loadMarket } from "@/sim/market";

export default function LoginPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Login />
    </Suspense>
  );
}

interface AccountRow {
  username: string;
  name: string;
  alias: string;
  simulated: boolean;
}

async function Login() {
  const session = await getSession();
  if (!(await demoLoaded())) {
    return (
      <Page title="Sign in" subtitle="No demo data loaded yet.">
        <Card>
          <p className="text-sm">Load the demo first: `npm run db:seed`, or set HIDDENLOT_SEED_ON_START=true.</p>
        </Card>
      </Page>
    );
  }
  const accounts = await (await getDb()).query<AccountRow>(
    `SELECT u.username, u.name, n.alias, u.simulated FROM users u JOIN networks n ON n.id = u.network_id
      WHERE u.username IS NOT NULL ORDER BY u.simulated, n.alias, u.username`,
  );
  const password = loadMarket().demo_password;
  const story = accounts.filter((a) => !a.simulated);
  const simulated = accounts.filter((a) => a.simulated);

  return (
    <Page
      title="Sign in"
      subtitle={session ? `Signed in as ${short(session.user.name)} (${session.network.alias}). Sign in again to switch account.` : "Every account here is a fictional demo account."}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card title="Sign in">
          <ActionForm action={signInAction} className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Username</span>
              <input name="username" autoComplete="username" required className={inputCls} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Password</span>
              <input name="password" type="password" autoComplete="current-password" required className={inputCls} />
            </label>
            <Submit className={primaryCls} pending="Signing in…">
              Sign in
            </Submit>
          </ActionForm>
          <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
            Demo password for every account: <code className="font-mono text-zinc-700 dark:text-zinc-300">{password}</code>
          </p>
        </Card>

        <div className="space-y-6">
          <AccountList title="Walkthrough accounts" note="You act as these people. Their stock and demands are the demo story." accounts={story} password={password} />
          <AccountList
            title="Simulated users"
            note="Pseudo users of the same networks. A simulator has them post stock and demands, answer buyers' questions and sell, through the same pipeline and rules. Sign in to see the market from their side."
            accounts={simulated}
            password={password}
          />
        </div>
      </div>
    </Page>
  );
}

function AccountList({ title, note, accounts, password }: { title: string; note: string; accounts: AccountRow[]; password: string }) {
  return (
    <section className="space-y-3">
      <Label>{title}</Label>
      <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{note}</p>
      <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {accounts.map((a) => (
          <li key={a.username} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {short(a.name)} <span className="font-normal text-zinc-500 dark:text-zinc-400">· {a.alias}</span>
              </p>
              <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                {role(a.name)} · username <code className="font-mono">{a.username}</code>
              </p>
            </div>
            <ActionForm action={signInAction}>
              <input type="hidden" name="username" value={a.username} />
              <input type="hidden" name="password" value={password} />
              <Submit className={buttonCls} pending="…">
                Sign in
              </Submit>
            </ActionForm>
          </li>
        ))}
      </ul>
    </section>
  );
}

const short = (name: string) => name.replace(/\s*\(.*?\)/g, "").split(" · ")[0];
const role = (name: string) => name.replace(/\s*\(.*?\)/g, "").split(" · ")[1] ?? "";
