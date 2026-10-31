import type { Metadata } from "next";
import Link from "next/link";
import { createDemandAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { Card, inputCls, Page, primaryCls } from "@/components/ui";

export const metadata: Metadata = { title: "New demand" };

const label = "mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400";

export default function NewDemandPage() {
  return (
    <Page title="New demand" subtitle="Saving runs discovery at once. Tolerances are yours to set.">
      <Card>
        <ActionForm action={createDemandAction} className="grid gap-4 md:grid-cols-2">
          <label className="block md:col-span-2">
            <span className={label}>Title</span>
            <input name="title" required className={inputCls} placeholder="e.g. HRC SS400 3.0 × 1500 for Haiphong" />
          </label>
          <label className="block">
            <span className={label}>Accepted grades — one per line: grade | standard | edition (standard and edition optional)</span>
            <textarea name="grades" required rows={3} className={`${inputCls} font-mono`} placeholder="e.g. SS400 | JIS G3101" />
          </label>
          <label className="block">
            <span className={label}>Other grades</span>
            <select name="substitution" className={inputCls} defaultValue="review_required">
              <option value="forbidden">Not allowed</option>
              <option value="review_required">May be proposed — needs engineering review and my approval</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className={label}>Thickness min (mm)</span>
              <input name="thk_min" inputMode="decimal" className={inputCls} placeholder="e.g. 2.95" />
            </label>
            <label className="block">
              <span className={label}>Thickness max (mm)</span>
              <input name="thk_max" inputMode="decimal" className={inputCls} placeholder="e.g. 3.05" />
            </label>
            <label className="block">
              <span className={label}>Width min (mm)</span>
              <input name="wid_min" inputMode="decimal" className={inputCls} placeholder="e.g. 1495" />
            </label>
            <label className="block">
              <span className={label}>Width max (mm)</span>
              <input name="wid_max" inputMode="decimal" className={inputCls} placeholder="e.g. 1505" />
            </label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className={label}>Qty min (t)</span>
              <input name="qty_min_t" inputMode="decimal" required className={inputCls} placeholder="e.g. 15" />
            </label>
            <label className="block">
              <span className={label}>Target (t)</span>
              <input name="qty_target_t" inputMode="decimal" className={inputCls} placeholder="e.g. 18" />
            </label>
            <label className="block">
              <span className={label}>Qty max (t)</span>
              <input name="qty_max_t" inputMode="decimal" required className={inputCls} placeholder="e.g. 20" />
            </label>
            <label className="col-span-3 flex items-center gap-2 text-sm">
              <input type="checkbox" name="allow_partial" /> Partial delivery acceptable
            </label>
          </div>
          <fieldset>
            <legend className={label}>Acceptable condition</legend>
            <div className="flex flex-wrap gap-3 text-sm">
              <label>
                <input type="checkbox" name="conditions" value="prime" defaultChecked /> prime
              </label>
              <label>
                <input type="checkbox" name="conditions" value="secondary" /> secondary
              </label>
              <label>
                <input type="checkbox" name="conditions" value="rejected_on_arrival" /> rejected on arrival
              </label>
            </div>
          </fieldset>
          <label className="block">
            <span className={label}>Must-have certificates (comma-separated)</span>
            <input name="certificates" className={inputCls} placeholder="e.g. MTC" />
          </label>
          <label className="block">
            <span className={label}>Stock available by (ex-warehouse; transit is not modelled)</span>
            <input type="date" name="need_by" className={inputCls} />
          </label>
          <label className="block">
            <span className={label}>Destination</span>
            <input name="destination" className={inputCls} placeholder="e.g. Haiphong" />
          </label>
          <div className="grid grid-cols-4 gap-2 md:col-span-2">
            <label className="block">
              <span className={label}>Budget per MT</span>
              <input name="budget_amount" inputMode="decimal" className={inputCls} placeholder="e.g. 560" />
            </label>
            <label className="block">
              <span className={label}>Currency</span>
              <input name="budget_currency" className={inputCls} defaultValue="USD" />
            </label>
            <label className="block">
              <span className={label}>Incoterm</span>
              <input name="budget_incoterm" className={inputCls} defaultValue="CFR" />
            </label>
            <label className="block">
              <span className={label}>Named place</span>
              <input name="budget_place" className={inputCls} placeholder="e.g. Haiphong" />
            </label>
          </div>
          <div className="flex items-center gap-3 md:col-span-2">
            <Submit className={primaryCls} pending="Saving and running discovery…">
              Save and run discovery
            </Submit>
            <Link href="/demands" className="text-sm text-accent hover:underline">
              Cancel
            </Link>
          </div>
        </ActionForm>
      </Card>
    </Page>
  );
}
