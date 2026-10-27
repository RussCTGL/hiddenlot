import { createDemandAction } from "@/app/actions";
import { ActionForm, Submit } from "@/components/forms";
import { Card, inputCls, Page, primaryCls } from "@/components/ui";

const label = "mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400";

export default function NewDemandPage() {
  return (
    <Page title="New demand" subtitle="Saving runs discovery at once against every lot your network may see. Numeric tolerances are yours to set; HiddenLot does not take them from any standard.">
      <Card>
        <ActionForm action={createDemandAction} className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className={label}>Title</label>
            <input name="title" required className={inputCls} defaultValue="HRC SS400 3.0 × 1500 for Haiphong" />
          </div>
          <div>
            <label className={label}>Accepted grades — one per line: grade | standard | edition (standard and edition optional)</label>
            <textarea name="grades" rows={3} className={`${inputCls} font-mono`} defaultValue="SS400 | JIS G3101" />
          </div>
          <div>
            <label className={label}>Other grades</label>
            <select name="substitution" className={inputCls} defaultValue="review_required">
              <option value="forbidden">Not allowed</option>
              <option value="review_required">May be proposed — needs engineering review and my approval</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={label}>Thickness min (mm)</label>
              <input name="thk_min" className={inputCls} defaultValue="2.95" />
            </div>
            <div>
              <label className={label}>Thickness max (mm)</label>
              <input name="thk_max" className={inputCls} defaultValue="3.05" />
            </div>
            <div>
              <label className={label}>Width min (mm)</label>
              <input name="wid_min" className={inputCls} defaultValue="1495" />
            </div>
            <div>
              <label className={label}>Width max (mm)</label>
              <input name="wid_max" className={inputCls} defaultValue="1505" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className={label}>Qty min (t)</label>
              <input name="qty_min_t" required className={inputCls} defaultValue="15" />
            </div>
            <div>
              <label className={label}>Target (t)</label>
              <input name="qty_target_t" className={inputCls} defaultValue="18" />
            </div>
            <div>
              <label className={label}>Qty max (t)</label>
              <input name="qty_max_t" required className={inputCls} defaultValue="20" />
            </div>
            <label className="col-span-3 flex items-center gap-2 text-sm">
              <input type="checkbox" name="allow_partial" /> Partial delivery acceptable
            </label>
          </div>
          <div>
            <span className={label}>Acceptable condition</span>
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
          </div>
          <div>
            <label className={label}>Must-have certificates (comma-separated)</label>
            <input name="certificates" className={inputCls} defaultValue="MTC" />
          </div>
          <div>
            <label className={label}>Stock available by (ex-warehouse; transit is not modelled)</label>
            <input type="date" name="need_by" className={inputCls} defaultValue="2026-11-20" />
          </div>
          <div>
            <label className={label}>Destination</label>
            <input name="destination" className={inputCls} defaultValue="Haiphong" />
          </div>
          <div className="grid grid-cols-4 gap-2 md:col-span-2">
            <div>
              <label className={label}>Budget per MT</label>
              <input name="budget_amount" className={inputCls} placeholder="e.g. 560" />
            </div>
            <div>
              <label className={label}>Currency</label>
              <input name="budget_currency" className={inputCls} defaultValue="USD" />
            </div>
            <div>
              <label className={label}>Incoterm</label>
              <input name="budget_incoterm" className={inputCls} defaultValue="CFR" />
            </div>
            <div>
              <label className={label}>Named place</label>
              <input name="budget_place" className={inputCls} defaultValue="Haiphong" />
            </div>
          </div>
          <div className="md:col-span-2">
            <Submit className={primaryCls} pending="Saving and running discovery…">
              Save and run discovery
            </Submit>
          </div>
        </ActionForm>
      </Card>
    </Page>
  );
}
