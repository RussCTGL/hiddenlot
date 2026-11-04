import { NotFoundError } from "@/auth/access";
import { getDb } from "@/db/server";
import { demoInputs } from "@/lib/demo";
import { getSession, requestNow } from "@/lib/session";
import { demoFile } from "@/workflow/orders";

// Demo only: a generated document for an order step (or a packing list), for
// either side of the deal. The page binds it to the file field; nothing is
// stored until it is attached.

export async function GET(_req: Request, ctx: RouteContext<"/deals/[id]/demo-file/[kind]">) {
  if (!demoInputs()) return new Response("Not found", { status: 404 });
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const { id, kind } = await ctx.params;
  try {
    const f = await demoFile(await getDb(), session.actor, id, kind, await requestNow());
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": f.mime,
        "Content-Disposition": `attachment; filename="${f.filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof NotFoundError) return new Response("Not found", { status: 404 });
    throw err;
  }
}
