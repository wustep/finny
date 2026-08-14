import { createFileRoute } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import {
  ChevronDown,
  ChevronUp,
  EyeOff,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Wand2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  PFC_GROUPS,
  pfcLabel,
  type AmountOp,
  type TextOp,
} from "../../convex/rulesEngine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/rules")({
  component: RulesPage,
});

type RuleRow = FunctionReturnType<typeof api.rules.list>[number];
type AccountOption = { id: Id<"accounts">; label: string };

const TEXT_OPS: Array<{ value: TextOp; label: string }> = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "is exactly" },
  { value: "regex", label: "matches regex" },
];

const AMOUNT_OPS: Array<{ value: AmountOp; label: string }> = [
  { value: "gt", label: "is more than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
  { value: "eq", label: "is exactly" },
];

const textOpLabel = (op: TextOp) =>
  TEXT_OPS.find((entry) => entry.value === op)?.label ?? op;
const amountOpLabel = (op: AmountOp) =>
  AMOUNT_OPS.find((entry) => entry.value === op)?.label ?? op;

// Plaid's sign, which is what a condition is compared against: positive is
// money out. Shown signed so a rule for refunds reads as a negative number,
// the way it was typed.
function dollars(value: number) {
  const text = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? "-" : ""}$${text}`;
}

// The same select styling the Notion page's page picker uses.
const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs";

const styledSelect = `${selectClass} w-full`;

function RulesPage() {
  const rules = useQuery(api.rules.list);
  const connections = useQuery(api.connections.list);
  const [editing, setEditing] = useState<RuleRow | "new" | null>(null);

  const accounts: AccountOption[] = (connections ?? []).flatMap((connection) =>
    connection.accounts.map((account) => ({
      id: account.id,
      label: `${connection.institutionName} · ${account.name}${
        account.mask ? ` *${account.mask}` : ""
      }`,
    })),
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
          <p className="text-sm text-muted-foreground">
            Change what a transaction looks like in Notion
          </p>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus /> New rule
        </Button>
      </div>

      <HowRulesWork />

      {rules === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : rules.length === 0 ? (
        <EmptyState onCreate={() => setEditing("new")} />
      ) : (
        <RuleList
          rules={rules}
          accounts={accounts}
          onEdit={(rule) => setEditing(rule)}
        />
      )}

      {editing ? (
        <RuleDialog
          rule={editing === "new" ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function HowRulesWork() {
  return (
    <Card className="bg-muted/40">
      <CardContent className="flex flex-col gap-2 py-4 text-sm text-muted-foreground">
        <p>
          Rules are applied as transactions sync. They run top to bottom and{" "}
          <strong className="font-medium text-foreground">
            the first rule that matches wins
          </strong>{" "}
          — everything it sets is applied together, and no rule below it is
          considered.
        </p>
        <p>
          Rows already in Notion take a new rule the next time that transaction
          syncs, which happens when your bank changes it or you re-backfill
          from the Notion page. Editing a Finny-owned property in Notion (the
          title, category, amount, date) does not stick: the next sync writes
          over it. Properties you add yourself are never touched.
        </p>
      </CardContent>
    </Card>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card>
      <CardHeader className="items-center text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
          <Wand2 className="size-6 text-muted-foreground" />
        </div>
        <CardTitle>No rules yet</CardTitle>
        <CardDescription>
          A rule can put a transaction in a different category, retitle it, or
          keep it out of Notion — every time it syncs, without touching the
          row by hand.
        </CardDescription>
        <Button className="mx-auto mt-2 w-fit" onClick={onCreate}>
          <Plus /> New rule
        </Button>
      </CardHeader>
    </Card>
  );
}

function RuleList({
  rules,
  accounts,
  onEdit,
}: {
  rules: RuleRow[];
  accounts: AccountOption[];
  onEdit: (rule: RuleRow) => void;
}) {
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col p-0">
        {rules.map((rule, index) => (
          <RuleItem
            key={rule.id}
            rule={rule}
            accounts={accounts}
            position={index + 1}
            first={index === 0}
            last={index === rules.length - 1}
            onEdit={() => onEdit(rule)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function RuleItem({
  rule,
  accounts,
  position,
  first,
  last,
  onEdit,
}: {
  rule: RuleRow;
  accounts: AccountOption[];
  position: number;
  first: boolean;
  last: boolean;
  onEdit: () => void;
}) {
  const update = useMutation(api.rules.update);
  const move = useMutation(api.rules.move);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleToggle = (enabled: boolean) => {
    update({ ruleId: rule.id, enabled }).catch((err: unknown) => {
      console.error(err);
      toast.error(`Could not turn "${rule.name}" ${enabled ? "on" : "off"}`);
    });
  };

  const handleMove = (direction: "up" | "down") => {
    move({ ruleId: rule.id, direction }).catch((err: unknown) => {
      console.error(err);
      toast.error("Could not reorder the rules");
    });
  };

  return (
    <div className="flex items-start gap-3 border-b p-4 last:border-b-0">
      <span className="w-4 pt-0.5 text-sm tabular-nums text-muted-foreground">
        {position}
      </span>
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span
            className={
              rule.enabled ? "text-sm font-medium" : "text-sm font-medium text-muted-foreground"
            }
          >
            {rule.name}
          </span>
          {rule.enabled ? null : (
            <Badge variant="outline" className="text-muted-foreground">
              Off
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {conditionSummary(rule, accounts)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {rule.outcomes.categoryId ? (
            <Badge variant="secondary">
              Category: {pfcLabel(rule.outcomes.categoryId)}
            </Badge>
          ) : null}
          {rule.outcomes.rename ? (
            <Badge variant="secondary">Title: {rule.outcomes.rename}</Badge>
          ) : null}
          {rule.outcomes.hide ? (
            <Badge variant="outline" className="text-destructive">
              <EyeOff /> Kept out of Notion
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Move "${rule.name}" up`}
          disabled={first}
          onClick={() => handleMove("up")}
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Move "${rule.name}" down`}
          disabled={last}
          onClick={() => handleMove("down")}
        >
          <ChevronDown />
        </Button>
        <Switch
          checked={rule.enabled}
          aria-label={`Enable "${rule.name}"`}
          onCheckedChange={handleToggle}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`More for "${rule.name}"`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <DeleteDialog
        rule={rule}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
      />
    </div>
  );
}

function conditionSummary(rule: RuleRow, accounts: AccountOption[]): string {
  const parts: string[] = [];
  if (rule.conditions.merchant) {
    parts.push(
      `merchant ${textOpLabel(rule.conditions.merchant.op)} “${rule.conditions.merchant.value}”`,
    );
  }
  if (rule.conditions.description) {
    parts.push(
      `description ${textOpLabel(rule.conditions.description.op)} “${rule.conditions.description.value}”`,
    );
  }
  if (rule.conditions.amount) {
    parts.push(
      `amount ${amountOpLabel(rule.conditions.amount.op)} ${dollars(rule.conditions.amount.value)}`,
    );
  }
  if (rule.conditions.accountId) {
    const account = accounts.find(
      (option) => option.id === rule.conditions.accountId,
    );
    // A rule outlives the account it named if that bank is removed; it then
    // matches nothing rather than matching everything.
    parts.push(account ? `in ${account.label}` : "in an account that is gone");
  }
  return parts.length > 1
    ? `When ${parts.join(" and ")}`
    : `When ${parts[0] ?? "nothing"}`;
}

function DeleteDialog({
  rule,
  open,
  onOpenChange,
}: {
  rule: RuleRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useMutation(api.rules.remove);
  const [working, setWorking] = useState(false);

  const handleDelete = () => {
    setWorking(true);
    remove({ ruleId: rule.id })
      .then(() => {
        toast.success(`Deleted "${rule.name}"`);
        onOpenChange(false);
      })
      .catch((err: unknown) => {
        console.error(err);
        toast.error("Could not delete the rule");
      })
      .finally(() => setWorking(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete "{rule.name}"?</DialogTitle>
          <DialogDescription>
            Transactions stop being changed by this rule from the next sync
            onwards. Rows it already wrote keep the category and title it gave
            them until something makes those transactions sync again
            {rule.outcomes.hide
              ? " — and rows it hid stay out of Notion until then too."
              : "."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={working}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={working}
          >
            {working ? "Deleting…" : "Delete rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Draft = {
  name: string;
  merchantOp: TextOp | "";
  merchantValue: string;
  descriptionOp: TextOp | "";
  descriptionValue: string;
  amountOp: AmountOp | "";
  amountValue: string;
  accountId: string;
  categoryId: string;
  rename: string;
  hide: boolean;
};

function draftFrom(rule: RuleRow | null): Draft {
  return {
    name: rule?.name ?? "",
    merchantOp: rule?.conditions.merchant?.op ?? "",
    merchantValue: rule?.conditions.merchant?.value ?? "",
    descriptionOp: rule?.conditions.description?.op ?? "",
    descriptionValue: rule?.conditions.description?.value ?? "",
    amountOp: rule?.conditions.amount?.op ?? "",
    amountValue:
      rule?.conditions.amount === undefined
        ? ""
        : String(rule.conditions.amount.value),
    accountId: rule?.conditions.accountId ?? "",
    categoryId: rule?.outcomes.categoryId ?? "",
    rename: rule?.outcomes.rename ?? "",
    hide: rule?.outcomes.hide ?? false,
  };
}

function RuleDialog({
  rule,
  accounts,
  onClose,
}: {
  rule: RuleRow | null;
  accounts: AccountOption[];
  onClose: () => void;
}) {
  const create = useMutation(api.rules.create);
  const update = useMutation(api.rules.update);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(rule));
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const handleSave = () => {
    const built = buildRule(draft, accounts);
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setSaving(true);
    const saved = rule
      ? update({ ruleId: rule.id, ...built.value })
      : create(built.value);
    saved
      .then(() => {
        toast.success(rule ? "Rule saved" : "Rule created");
        onClose();
      })
      .catch((err: unknown) => {
        console.error(err);
        toast.error("Could not save the rule");
      })
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>
            A transaction has to meet every condition you set for the rule to
            apply.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              placeholder="Coffee runs"
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3">
            <Label>When a transaction…</Label>

            <TextConditionRow
              id="rule-merchant"
              label="Merchant"
              hint="Plaid's cleaned merchant name, or the bank's description when there is none — the same text Finny puts in the Notion title."
              op={draft.merchantOp}
              value={draft.merchantValue}
              onOpChange={(op) => set("merchantOp", op)}
              onValueChange={(value) => set("merchantValue", value)}
            />

            <TextConditionRow
              id="rule-description"
              label="Original description"
              hint="The raw string from your bank, as synced to Original Description."
              op={draft.descriptionOp}
              value={draft.descriptionValue}
              onOpChange={(op) => set("descriptionOp", op)}
              onValueChange={(value) => set("descriptionValue", value)}
            />

            <div className="flex flex-col gap-1.5">
              <div className="flex gap-2">
                <select
                  aria-label="Amount comparison"
                  className={`${selectClass} w-40`}
                  value={draft.amountOp}
                  onChange={(event) =>
                    set("amountOp", event.target.value as AmountOp | "")
                  }
                >
                  <option value="">Any amount</option>
                  {AMOUNT_OPS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      Amount {entry.label}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label="Amount"
                  type="number"
                  step="0.01"
                  placeholder="25"
                  disabled={draft.amountOp === ""}
                  value={draft.amountValue}
                  onChange={(event) => set("amountValue", event.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Money leaving the account is positive here, so{" "}
                <code>more than 50</code> means spending over $50 and{" "}
                <code>less than 0</code> catches refunds and deposits. The
                Notion Amount column shows the same transaction with the sign
                flipped.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <select
                aria-label="Account"
                className={styledSelect}
                value={draft.accountId}
                onChange={(event) => set("accountId", event.target.value)}
              >
                <option value="">In any account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    In {account.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Label>…then</Label>

            <select
              aria-label="Category"
              className={styledSelect}
              value={draft.categoryId}
              onChange={(event) => set("categoryId", event.target.value)}
            >
              <option value="">Keep the category Plaid chose</option>
              {PFC_GROUPS.map((group) => (
                <optgroup key={group.primary} label={group.label}>
                  {group.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <div className="flex flex-col gap-1.5">
              <Input
                aria-label="Title in Notion"
                placeholder="Leave the merchant name as the title"
                value={draft.rename}
                onChange={(event) => set("rename", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Renaming changes the Notion title only. Original Description
                keeps whatever your bank sent.
              </p>
            </div>

            <div className="flex items-start gap-3 rounded-md border p-3">
              <div className="flex-1">
                <div className="text-sm">Keep out of Notion</div>
                <p className="text-xs text-muted-foreground">
                  Matching transactions get no row. One that is already in
                  Notion is archived the next time it syncs, and Finny forgets
                  it — turning this back off brings the row back only when the
                  transaction next changes at your bank.
                </p>
              </div>
              <Switch
                checked={draft.hide}
                aria-label="Keep out of Notion"
                onCheckedChange={(checked) => set("hide", checked)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : rule ? "Save rule" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextConditionRow({
  id,
  label,
  hint,
  op,
  value,
  onOpChange,
  onValueChange,
}: {
  id: string;
  label: string;
  hint: string;
  op: TextOp | "";
  value: string;
  onOpChange: (op: TextOp | "") => void;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <select
          aria-label={`${label} comparison`}
          className={`${selectClass} w-40`}
          value={op}
          onChange={(event) => onOpChange(event.target.value as TextOp | "")}
        >
          <option value="">Any {label.toLowerCase()}</option>
          {TEXT_OPS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {label} {entry.label}
            </option>
          ))}
        </select>
        <Input
          id={id}
          aria-label={label}
          placeholder={op === "regex" ? "^SQ \\*" : "blue bottle"}
          disabled={op === ""}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

type RuleArgs = {
  name: string;
  conditions: RuleRow["conditions"];
  outcomes: RuleRow["outcomes"];
};

// Turn the form into mutation arguments, or say what is missing. The same
// checks run on the server (convex/rules.ts); doing them here is what makes
// the message specific.
function buildRule(
  draft: Draft,
  accounts: AccountOption[],
): { value: RuleArgs } | { error: string } {
  const name = draft.name.trim();
  if (!name) {
    return { error: "Give the rule a name" };
  }

  const conditions: RuleArgs["conditions"] = {};
  for (const [op, value, key] of [
    [draft.merchantOp, draft.merchantValue, "merchant"],
    [draft.descriptionOp, draft.descriptionValue, "description"],
  ] as Array<[TextOp | "", string, "merchant" | "description"]>) {
    if (op === "") {
      continue;
    }
    const text = value.trim();
    if (!text) {
      return { error: `Fill in the ${key} to match, or set it back to any` };
    }
    if (op === "regex") {
      try {
        new RegExp(text);
      } catch {
        return { error: `“${text}” is not a valid regular expression` };
      }
    }
    conditions[key] = { op, value: text };
  }

  if (draft.amountOp !== "") {
    const amount = Number(draft.amountValue);
    if (draft.amountValue.trim() === "" || !Number.isFinite(amount)) {
      return { error: "Fill in an amount to compare against" };
    }
    conditions.amount = { op: draft.amountOp, value: amount };
  }

  if (draft.accountId) {
    const account = accounts.find((option) => option.id === draft.accountId);
    if (!account) {
      return { error: "Pick an account that still exists" };
    }
    conditions.accountId = account.id;
  }

  if (Object.keys(conditions).length === 0) {
    return {
      error: "Add at least one condition — a rule with none would match every transaction",
    };
  }

  const outcomes: RuleArgs["outcomes"] = {};
  if (draft.categoryId) {
    outcomes.categoryId = draft.categoryId;
  }
  const rename = draft.rename.trim();
  if (rename) {
    outcomes.rename = rename;
  }
  if (draft.hide) {
    outcomes.hide = true;
  }
  if (Object.keys(outcomes).length === 0) {
    return { error: "Choose what the rule should do: a category, a title, or hide it" };
  }

  return { value: { name, conditions, outcomes } };
}
