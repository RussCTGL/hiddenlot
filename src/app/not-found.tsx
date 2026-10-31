import Link from "next/link";
import { Card, Page } from "@/components/ui";

export default function NotFound() {
  return (
    <Page title="Not found">
      <Card>
        <p className="text-sm">
          This page or lot is not visible to your network. It may have been sold or withdrawn, or the shared demo was reloaded.{" "}
          <Link href="/" className="text-accent hover:underline">
            Back to Today
          </Link>
        </p>
      </Card>
    </Page>
  );
}
