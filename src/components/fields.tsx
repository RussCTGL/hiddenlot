import type { EvidenceRef, InventoryLot, InventoryLotField } from "@/domain/hrc";
import { Badge, Unknown } from "./ui";

export const FIELD_LABEL: Record<InventoryLotField, string> = {
  seller_lot_ref: "Seller lot ref",
  product_form: "Product form",
  grade_raw: "Grade (as written)",
  standard_id: "Standard",
  standard_edition: "Standard edition",
  certificate_claims: "Certificates (seller says)",
  heat_numbers: "Heat numbers",
  thickness_mm: "Thickness",
  width_mm: "Width",
  total_kg: "Total weight",
  piece_count: "Coils",
  splittable: "Can be split",
  location_country: "Country",
  location_place: "Location",
  available_from: "Available from",
  price_amount: "Price",
  price_currency: "Currency",
  price_basis: "Price basis",
  incoterm: "Incoterm",
  incoterm_place: "Incoterm place",
  condition: "Condition",
  defect_notes: "Defect notes",
  surplus_reason: "Why surplus",
};

export const FIELD_ORDER = Object.keys(FIELD_LABEL) as InventoryLotField[];

type Obs = InventoryLot["fields"][InventoryLotField];

export function formatValue(field: InventoryLotField, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (field === "thickness_mm" || field === "width_mm") return `${v} mm`;
  if (field === "total_kg") return `${(v as number) / 1000} t (${(v as number).toLocaleString("en-US")} kg)`;
  if (typeof v === "string") return v.replaceAll("_", " ");
  return String(v);
}

const STATUS: Record<Obs["status"], [string, "zinc" | "amber" | "rose" | "emerald" | "sky" | "violet"]> = {
  source_stated: ["source stated", "zinc"],
  normalized: ["converted in code", "sky"],
  user_confirmed: ["confirmed by lot owner", "emerald"],
  user_corrected: ["corrected by lot owner", "violet"],
  unresolved: ["unresolved", "rose"],
  not_stated: ["not stated", "amber"],
};

export function locatorText(e: EvidenceRef): string {
  const l = e.locator;
  switch (l.kind) {
    case "text_span":
      return `${e.fragment_id} · chars ${l.start}–${l.end}`;
    case "sheet_cell":
      return `${l.sheet}!${l.cell}`;
    case "pdf_text":
      return `page ${l.page} · ${e.fragment_id}`;
    case "owner_private":
      return "traced in the seller's private source (quote not shared)";
  }
}

export function FieldRow({ field, obs, children }: { field: InventoryLotField; obs: Obs; children?: React.ReactNode }) {
  const value = obs.normalized_value;
  const empty = value === null || (Array.isArray(value) && value.length === 0);
  const withheld = obs.issues.includes("withheld_by_owner");
  const [label, tone] = STATUS[obs.status];
  return (
    <tr className="border-t border-zinc-100 align-top dark:border-zinc-800">
      <td className="py-1.5 pr-3 text-xs text-zinc-500">{FIELD_LABEL[field]}</td>
      <td className="py-1.5 pr-3 text-sm">
        {empty ? <Unknown reason={withheld ? "not shared" : obs.status === "unresolved" ? obs.issues.join(", ") : undefined} /> : <span className="font-medium">{formatValue(field, value)}</span>}
        {obs.normalization && !empty && <div className="text-[11px] text-zinc-500">rule {obs.normalization.rule} {/^\d/.test(obs.normalization.version) ? `v${obs.normalization.version}` : obs.normalization.version}{obs.raw_value ? ` from "${obs.raw_value}"` : ""}</div>}
        {!empty && obs.issues.length > 0 && <div className="text-[11px] text-rose-700 dark:text-rose-400">{obs.issues.join(", ")}</div>}
      </td>
      <td className="py-1.5 pr-3">{!withheld && <Badge tone={tone}>{label}</Badge>}</td>
      <td className="py-1.5 text-xs text-zinc-600 dark:text-zinc-400">
        {obs.evidence.map((e, i) => (
          <div key={i}>
            {e.quote && <q className="font-mono text-[11px] text-zinc-800 dark:text-zinc-200">{e.quote}</q>} <span className="text-zinc-500">{locatorText(e)}</span>
          </div>
        ))}
        {children}
      </td>
    </tr>
  );
}

export function FieldTable({ lot, fields = FIELD_ORDER, render }: { lot: InventoryLot; fields?: InventoryLotField[]; render?: (f: InventoryLotField) => React.ReactNode }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <th className="pb-1 font-medium">Field</th>
          <th className="pb-1 font-medium">Value</th>
          <th className="pb-1 font-medium">Status</th>
          <th className="pb-1 font-medium">Evidence</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <FieldRow key={f} field={f} obs={lot.fields[f]}>
            {render?.(f)}
          </FieldRow>
        ))}
      </tbody>
    </table>
  );
}
