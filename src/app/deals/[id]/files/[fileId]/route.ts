import { NotFoundError } from "@/auth/access";
import { getDb } from "@/db/server";
import { getSession } from "@/lib/session";
import { getDealFile } from "@/workflow/orders";

// A file shared on a deal, for the buyer or the seller of that deal only.

export async function GET(_req: Request, ctx: RouteContext<"/deals/[id]/files/[fileId]">) {
  const session = await getSession();
  if (!session) return new Response("Sign in first", { status: 401 });
  const { id, fileId } = await ctx.params;
  try {
    const f = await getDealFile(await getDb(), session.actor, id, fileId);
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": f.mime,
        "Content-Disposition": `${f.mime === "application/pdf" || f.mime.startsWith("image/") ? "inline" : "attachment"}; filename="${f.filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof NotFoundError) return new Response("Not found", { status: 404 });
    throw err;
  }
}
