import { createFileRoute } from "@tanstack/react-router";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  EyeOff,
  History,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  Tag,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  PFC_GROUPS,
  pfcLabel,
  isPfcPrimary,
  type Action,
  type AmountOp,
  type Condition,
  type TextField,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/rules")({
  component: RulesPage,
});

type RuleRow = FunctionReturnType<typeof api.rules.list>[number];
type AccountOption = { id: Id<"accounts">; label: string };

// Each operator next to its own negation, so picking the opposite of what is
// selected is the neighbouring row rather than three rows down.
const TEXT_OPS: Array<{ value: TextOp; label: string; not: string }> = [
  { value: "contains", label: "contains", not: "doesn't contain" },
  { value: "equals", label: "is exactly", not: "is not" },
  { value: "regex", label: "matches regex", not: "doesn't match regex" },
];

const TEXT_OP_OPTIONS: Array<{ value: string; label: string }> =
  TEXT_OPS.flatMap((entry) => [
    { value: entry.value, label: entry.label },
    { value: `${entry.value}:not`, label: entry.not },
  ]);

const AMOUNT_OPS: Array<{ value: AmountOp; label: string }> = [
  { value: "gt", label: "is more than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
  { value: "eq", label: "is exactly" },
];

const FIELD_LABELS: Record<Condition["kind"] | TextField, string> = {
  merchant: "Merchant",
  description: "Description",
  text: "Merchant",
  amount: "Amount",
  account: "Account",
  category: "Category",
  pending: "Status",
};

function textOpLabel(op: TextOp, negate?: boolean) {
  const entry = TEXT_OPS.find((candidate) => candidate.value === op);
  return (negate ? entry?.not : entry?.label) ?? op;
}

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

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs";

// The engine keeps account ids as plain strings, on purpose — it is pure and
// knows nothing about the data model. Everything on this page is talking to
// Convex, where they are branded ids. One named cast at that seam beats one
// at every use of it.
function asStored(conditions: Condition[]): RuleArgs["conditions"] {
  return conditions as RuleArgs["conditions"];
}

// A question mark that holds the paragraph a control does not have room for.
// The prose is worth keeping; it is only ever worth reading once.
function Hint({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={`inline-flex text-muted-foreground transition-colors hover:text-foreground ${className ?? ""}`}
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="text-xs text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}

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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
          <p className="text-sm text-muted-foreground">
            Applied as each transaction syncs, top to bottom — the first match
            wins.{" "}
            <Hint label="How rules work" className="ml-0.5 align-middle">
              <p className="mb-2">
                Everything the winning rule sets is applied together, and no
                rule below it is considered.
              </p>
              <p>
                Rows already in Notion take a new rule the next time that
                transaction syncs — when your bank changes it, or when you
                re-backfill from the Notion page. Editing a Finny-owned
                property in Notion does not stick; properties you add yourself
                are never touched.
              </p>
            </Hint>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {rules && rules.length > 0 ? <ApplyToHistory /> : null}
          <Button onClick={() => setEditing("new")}>
            <Plus /> New rule
          </Button>
        </div>
      </div>

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

// A rule only ever met transactions that synced after it was written, which
// is the first thing anyone notices and the least obvious thing about the
// whole feature. There is nothing stored to re-run rules against — so the
// only honest offer is to replay the history through the sync, which is
// exactly what the destination page's re-backfill does.
function ApplyToHistory() {
  const applyToHistory = useMutation(api.rules.applyToHistory);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);

  const handleApply = () => {
    setWorking(true);
    applyToHistory({})
      .then((result) => {
        toast.success(
          `Replaying ${result.connections} ${
            result.connections === 1 ? "bank" : "banks"
          } — this runs in the background`,
        );
        setOpen(false);
      })
      .catch((err: unknown) => {
        console.error(err);
        toast.error("Could not start the replay");
      })
      .finally(() => setWorking(false));
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <History /> Apply to history
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply these rules to everything?</DialogTitle>
            <DialogDescription>
              Finny replays your Plaid history from the start date, running
              every transaction past these rules on the way. Rows already in
              Notion are updated in place, not duplicated.
              <br />
              <br />
              A couple of years of transactions at Notion's three writes a
              second takes hours. It keeps going whether or not this page is
              open.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={working}
            >
              Cancel
            </Button>
            <Button onClick={handleApply} disabled={working}>
              {working ? "Starting…" : "Apply to history"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
          A rule can recategorise a transaction, retitle it, or keep it out of
          Notion — every time it syncs.
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
  const create = useMutation(api.rules.create);
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

  // The way to say "OR across different fields", which the condition list
  // deliberately cannot: two rules, same outcomes.
  const handleDuplicate = () => {
    create({
      name: `${rule.name} (copy)`,
      conditions: asStored(rule.conditions),
      actions: rule.actions as RuleArgs["actions"],
    })
      .then(() => toast.success("Duplicated — it goes last in the order"))
      .catch((err: unknown) => {
        console.error(err);
        toast.error("Could not duplicate the rule");
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
              rule.enabled
                ? "text-sm font-medium"
                : "text-sm font-medium text-muted-foreground"
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
          {conditionSummary(rule.conditions, accounts)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {rule.actions.map((action, index) => (
            <ActionBadge key={index} action={action} />
          ))}
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
            <Button
              variant="ghost"
              size="icon"
              aria-label={`More for "${rule.name}"`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDuplicate}>
              <Copy /> Duplicate
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

// One condition as a phrase. Several values inside a condition read as a
// list, because that is what they are: any one of them matches.
function conditionPhrase(
  condition: Condition,
  accounts: AccountOption[],
): string {
  switch (condition.kind) {
    case "text":
      return `${FIELD_LABELS[condition.field].toLowerCase()} ${textOpLabel(
        condition.op,
        condition.negate,
      )} ${condition.values.map((value) => `“${value}”`).join(" or ")}`;
    case "amount":
      return `amount ${amountOpLabel(condition.op)} ${dollars(condition.value)}`;
    case "account":
      return `in ${condition.accountIds
        .map(
          (id) =>
            // A rule outlives the account it named if that bank is removed;
            // it then matches nothing rather than matching everything.
            accounts.find((account) => account.id === id)?.label ??
            "an account that is gone",
        )
        .join(" or ")}`;
    case "category":
      return `category ${condition.negate ? "is not" : "is"} ${condition.categoryIds
        .map((id) => (isPfcPrimary(id) ? `any ${pfcLabel(id)}` : pfcLabel(id)))
        .join(" or ")}`;
    case "pending":
      return condition.value ? "still pending" : "already posted";
  }
}

function ActionBadge({ action }: { action: Action }) {
  switch (action.kind) {
    case "setCategory":
      return (
        <Badge variant="secondary">
          Category: {pfcLabel(action.categoryId)}
        </Badge>
      );
    case "rename":
      return <Badge variant="secondary">Title: {action.value}</Badge>;
    case "addTags":
      return (
        <Badge variant="secondary">
          <Tag /> {action.tags.join(", ")}
        </Badge>
      );
    case "hide":
      return (
        <Badge variant="outline" className="text-destructive">
          <EyeOff /> Kept out of Notion
        </Badge>
      );
  }
}

function conditionSummary(
  conditions: Condition[],
  accounts: AccountOption[],
): string {
  if (conditions.length === 0) {
    return "When nothing";
  }
  return `When ${conditions
    .map((condition) => conditionPhrase(condition, accounts))
    .join(" and ")}`;
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
            Rows it already wrote keep what it gave them until those
            transactions next sync
            {rule.actions.some((action) => action.kind === "hide")
              ? ", and rows it hid stay hidden until then"
              : ""}
            .
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

// ---------- the builder ----------

// The editing shape. Identical to Condition except that an amount is held as
// the string the user is typing — "-" and "" are both states a number input
// passes through on the way to a valid number.
type DraftCondition =
  | { kind: "text"; field: TextField; op: TextOp; values: string[]; negate?: boolean }
  | { kind: "amount"; op: AmountOp; value: string }
  | { kind: "account"; accountIds: Id<"accounts">[] }
  | { kind: "category"; categoryIds: string[]; negate?: boolean }
  | { kind: "pending"; value: boolean };

// Actions are held exactly as they are stored; unlike an amount there is no
// half-typed state to keep out of the union.
type Draft = {
  name: string;
  conditions: DraftCondition[];
  actions: Action[];
};

function draftFrom(rule: RuleRow | null): Draft {
  return {
    name: rule?.name ?? "",
    conditions: asStored(
      rule?.conditions ?? [
        { kind: "text", field: "merchant", op: "contains", values: [""] },
      ],
    ).map((condition) =>
      condition.kind === "amount"
        ? { ...condition, value: String(condition.value) }
        : condition,
    ),
    actions: rule?.actions ?? [{ kind: "setCategory", categoryId: "" }],
  };
}

// What the picker offers as a new condition. Only one amount comparison and
// one status make sense per rule in the common case, but nothing stops two
// amount conditions — that is how a range is written.
const CONDITION_KINDS: Array<{ label: string; make: () => DraftCondition }> = [
  {
    label: "Merchant",
    make: () => ({ kind: "text", field: "merchant", op: "contains", values: [""] }),
  },
  {
    label: "Description",
    make: () => ({
      kind: "text",
      field: "description",
      op: "contains",
      values: [""],
    }),
  },
  { label: "Amount", make: () => ({ kind: "amount", op: "gt", value: "" }) },
  { label: "Account", make: () => ({ kind: "account", accountIds: [] }) },
  { label: "Category", make: () => ({ kind: "category", categoryIds: [] }) },
  { label: "Status", make: () => ({ kind: "pending", value: true }) },
];

// What the picker offers as a new action. Nothing stops two of a kind: two
// addTags rows are two sets of tags, and a second rename simply wins.
const ACTION_KINDS: Array<{ label: string; make: () => Action }> = [
  {
    label: "Set the category",
    make: () => ({ kind: "setCategory", categoryId: "" }),
  },
  { label: "Rename it", make: () => ({ kind: "rename", value: "" }) },
  { label: "Add tags", make: () => ({ kind: "addTags", tags: [] }) },
  { label: "Keep it out of Notion", make: () => ({ kind: "hide" }) },
];

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

  const setCondition = (index: number, condition: DraftCondition) =>
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((existing, position) =>
        position === index ? condition : existing,
      ),
    }));

  const removeCondition = (index: number) =>
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.filter((_, position) => position !== index),
    }));

  const setAction = (index: number, action: Action) =>
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((existing, position) =>
        position === index ? action : existing,
      ),
    }));

  const removeAction = (index: number) =>
    setDraft((current) => ({
      ...current,
      actions: current.actions.filter((_, position) => position !== index),
    }));

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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              placeholder="Coffee runs"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>If a transaction matches all of</Label>
            <div className="flex flex-col gap-2">
              {draft.conditions.map((condition, index) => (
                <ConditionRow
                  key={index}
                  condition={condition}
                  accounts={accounts}
                  onChange={(next) => setCondition(index, next)}
                  onRemove={() => removeCondition(index)}
                />
              ))}
            </div>
            <AddCondition
              onAdd={(condition) =>
                setDraft((current) => ({
                  ...current,
                  conditions: [...current.conditions, condition],
                }))
              }
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Then</Label>
            <div className="flex flex-col gap-2">
              {draft.actions.map((action, index) => (
                <ActionRow
                  key={index}
                  action={action}
                  onChange={(next) => setAction(index, next)}
                  onRemove={() => removeAction(index)}
                />
              ))}
            </div>
            <AddAction
              onAdd={(action) =>
                setDraft((current) => ({
                  ...current,
                  actions: [...current.actions, action],
                }))
              }
            />
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

function AddCondition({ onAdd }: { onAdd: (condition: DraftCondition) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-fit">
          <Plus /> Add condition
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {CONDITION_KINDS.map((kind) => (
          <DropdownMenuItem key={kind.label} onClick={() => onAdd(kind.make())}>
            {kind.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddAction({ onAdd }: { onAdd: (action: Action) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-fit">
          <Plus /> Add action
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {ACTION_KINDS.map((kind) => (
          <DropdownMenuItem key={kind.label} onClick={() => onAdd(kind.make())}>
            {kind.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionRow({
  action,
  onChange,
  onRemove,
}: {
  action: Action;
  onChange: (action: Action) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border p-2">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <ActionFields action={action} onChange={onChange} />
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground"
        aria-label="Remove action"
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

function ActionFields({
  action,
  onChange,
}: {
  action: Action;
  onChange: (action: Action) => void;
}) {
  switch (action.kind) {
    case "setCategory":
      return (
        <>
          <span className="text-sm">Category</span>
          <select
            aria-label="Category to set"
            className={`${selectClass} flex-1`}
            value={action.categoryId}
            onChange={(event) =>
              onChange({ kind: "setCategory", categoryId: event.target.value })
            }
          >
            <option value="">Pick a category…</option>
            {PFC_GROUPS.map((group) => (
              <optgroup key={group.primary} label={group.label}>
                {/* No "any Travel" here, unlike the condition: a row lands in
                    one category, not in a group of them. */}
                {group.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </>
      );
    case "rename":
      return (
        <>
          <span className="text-sm">Title</span>
          <Input
            aria-label="Title in Notion"
            placeholder="Coffee"
            className="flex-1"
            value={action.value}
            onChange={(event) =>
              onChange({ kind: "rename", value: event.target.value })
            }
          />
          <Hint label="About renaming">
            Renaming changes the Notion title only. Original Description keeps
            whatever your bank sent.
          </Hint>
        </>
      );
    case "addTags":
      return (
        <>
          <span className="text-sm">Tags</span>
          <Hint label="About tags">
            Added to the Tags column on Transactions, never removed — only one
            rule wins per transaction, so what it took away would be anyone's
            guess. Finny adds the column the first time you save a rule that
            needs it.
          </Hint>
          <TagInput
            tags={action.tags}
            onChange={(tags) => onChange({ kind: "addTags", tags })}
          />
        </>
      );
    case "hide":
      return (
        <>
          <EyeOff className="size-4 text-muted-foreground" />
          <span className="text-sm">Keep it out of Notion</span>
          <Hint label="About keeping transactions out of Notion">
            No row is created, and a row that already exists is archived on its
            next sync. Finny then forgets it, so removing this action only
            brings the row back when the transaction next changes at your bank.
          </Hint>
        </>
      );
  }
}

// Tags are typed one at a time and shown as chips. Enter and comma both
// commit — comma because it is the habit, even though Notion refuses a comma
// inside an option name, which is why it is a separator here rather than
// something that could end up in a tag.
function TagInput({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const commit = (value: string) => {
    const tag = value.trim();
    if (tag && !tags.includes(tag)) {
      onChange([...tags, tag]);
    }
    setDraft("");
  };

  return (
    <div className="flex w-full flex-col gap-1.5">
      <Chips
        values={tags}
        label={(tag) => tag}
        onRemove={(tag) => onChange(tags.filter((existing) => existing !== tag))}
      />
      <Input
        aria-label="Add a tag"
        placeholder="Type a tag, then Enter"
        value={draft}
        onChange={(event) => {
          const value = event.target.value;
          if (value.includes(",")) {
            commit(value.replace(",", ""));
            return;
          }
          setDraft(value);
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(draft);
          }
          if (event.key === "Backspace" && !draft && tags.length) {
            onChange(tags.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

function ConditionRow({
  condition,
  accounts,
  onChange,
  onRemove,
}: {
  condition: DraftCondition;
  accounts: AccountOption[];
  onChange: (condition: DraftCondition) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-2">
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <ConditionFields
            condition={condition}
            accounts={accounts}
            onChange={onChange}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label="Remove condition"
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {condition.kind === "amount" ? (
        // The one hint that has to stay inline: it silently inverts meaning.
        <p className="text-xs text-muted-foreground">
          Money out is positive here — the Notion column shows the opposite
          sign.
        </p>
      ) : null}
    </div>
  );
}

function ConditionFields({
  condition,
  accounts,
  onChange,
}: {
  condition: DraftCondition;
  accounts: AccountOption[];
  onChange: (condition: DraftCondition) => void;
}) {
  switch (condition.kind) {
    case "text":
      return (
        <>
          <select
            aria-label="Field"
            className={`${selectClass} w-36`}
            value={condition.field}
            onChange={(event) =>
              onChange({ ...condition, field: event.target.value as TextField })
            }
          >
            <option value="merchant">Merchant</option>
            <option value="description">Description</option>
          </select>
          <select
            aria-label="Comparison"
            className={`${selectClass} w-44`}
            value={`${condition.op}${condition.negate ? ":not" : ""}`}
            onChange={(event) => {
              const [op, not] = event.target.value.split(":");
              onChange({
                ...condition,
                op: op as TextOp,
                negate: not === "not" ? true : undefined,
              });
            }}
          >
            {TEXT_OP_OPTIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <Hint label="About merchant and description">
            <p className="mb-2">
              <strong className="text-foreground">Merchant</strong> is Plaid's
              cleaned name, falling back to the bank's description — the same
              text Finny puts in the Notion title.
            </p>
            <p>
              <strong className="text-foreground">Description</strong> is the
              raw string from your bank, as synced to Original Description.
            </p>
          </Hint>
          <div className="flex w-full flex-col gap-1.5">
            {condition.values.map((value, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  aria-label={`Text to match${index > 0 ? ` (or ${index + 1})` : ""}`}
                  placeholder={condition.op === "regex" ? "^SQ \\*" : "blue bottle"}
                  value={value}
                  onChange={(event) =>
                    onChange({
                      ...condition,
                      values: condition.values.map((existing, position) =>
                        position === index ? event.target.value : existing,
                      ),
                    })
                  }
                />
                {condition.values.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label="Remove this value"
                    onClick={() =>
                      onChange({
                        ...condition,
                        values: condition.values.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  >
                    <X className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              className="w-fit text-xs text-muted-foreground underline underline-offset-4"
              onClick={() =>
                onChange({ ...condition, values: [...condition.values, ""] })
              }
            >
              + or
            </button>
          </div>
        </>
      );
    case "amount":
      return (
        <>
          <span className="text-sm">Amount</span>
          <select
            aria-label="Amount comparison"
            className={`${selectClass} w-44`}
            value={condition.op}
            onChange={(event) =>
              onChange({ ...condition, op: event.target.value as AmountOp })
            }
          >
            {AMOUNT_OPS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <Input
            aria-label="Amount"
            type="number"
            step="0.01"
            placeholder="25"
            className="w-32"
            value={condition.value}
            onChange={(event) =>
              onChange({ ...condition, value: event.target.value })
            }
          />
        </>
      );
    case "account":
      return (
        <>
          <span className="text-sm">In</span>
          <Chips
            values={condition.accountIds}
            label={(id) =>
              accounts.find((account) => account.id === id)?.label ??
              "an account that is gone"
            }
            onRemove={(id) =>
              onChange({
                ...condition,
                accountIds: condition.accountIds.filter(
                  (existing) => existing !== id,
                ),
              })
            }
          />
          <select
            aria-label="Add an account"
            className={`${selectClass} w-full`}
            value=""
            onChange={(event) =>
              onChange({
                ...condition,
                accountIds: [
                  ...condition.accountIds,
                  event.target.value as Id<"accounts">,
                ],
              })
            }
          >
            <option value="">Add an account…</option>
            {accounts
              .filter((account) => !condition.accountIds.includes(account.id))
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
          </select>
        </>
      );
    case "category":
      return (
        <>
          <span className="text-sm">Category</span>
          <select
            aria-label="Category comparison"
            className={`${selectClass} w-28`}
            value={condition.negate ? "not" : "is"}
            onChange={(event) =>
              onChange({
                ...condition,
                negate: event.target.value === "not" ? true : undefined,
              })
            }
          >
            <option value="is">is</option>
            <option value="not">is not</option>
          </select>
          <Chips
            values={condition.categoryIds}
            label={(id) => (isPfcPrimary(id) ? `any ${pfcLabel(id)}` : pfcLabel(id))}
            onRemove={(id) =>
              onChange({
                ...condition,
                categoryIds: condition.categoryIds.filter(
                  (existing) => existing !== id,
                ),
              })
            }
          />
          <select
            aria-label="Add a category"
            className={`${selectClass} w-full`}
            value=""
            onChange={(event) =>
              onChange({
                ...condition,
                categoryIds: [...condition.categoryIds, event.target.value],
              })
            }
          >
            <option value="">Add a category…</option>
            {PFC_GROUPS.map((group) => (
              <optgroup key={group.primary} label={group.label}>
                {/* Naming the group is usually what people mean, and it keeps
                    working when Plaid adds a category under it. */}
                <option value={group.primary}>Any {group.label}</option>
                {group.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </>
      );
    case "pending":
      return (
        <>
          <span className="text-sm">Transaction is</span>
          <select
            aria-label="Pending status"
            className={`${selectClass} w-40`}
            value={condition.value ? "pending" : "posted"}
            onChange={(event) =>
              onChange({ ...condition, value: event.target.value === "pending" })
            }
          >
            <option value="pending">still pending</option>
            <option value="posted">already posted</option>
          </select>
        </>
      );
  }
}

function Chips<T extends string>({
  values,
  label,
  onRemove,
}: {
  values: T[];
  label: (value: T) => string;
  onRemove: (value: T) => void;
}) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className="flex w-full flex-wrap gap-1.5">
      {values.map((value) => (
        <Badge key={value} variant="secondary" className="gap-1 font-normal">
          {label(value)}
          <button
            type="button"
            aria-label={`Remove ${label(value)}`}
            onClick={() => onRemove(value)}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

// ---------- draft -> mutation args ----------

// Taken from the mutation rather than restated, so the account ids stay the
// branded Id the server expects — the engine's own Condition keeps them as
// plain strings to stay independent of the data model.
type RuleArgs = FunctionArgs<typeof api.rules.create>;

// Turn the form into mutation arguments, or say what is missing. The same
// checks run on the server (convex/rules.ts); doing them here is what makes
// the message specific — and what lets the tester run against a draft.
function buildRule(
  draft: Draft,
  accounts: AccountOption[],
): { value: RuleArgs } | { error: string } {
  const name = draft.name.trim();
  if (!name) {
    return { error: "Give the rule a name" };
  }

  const conditions: RuleArgs["conditions"] = [];
  for (const condition of draft.conditions) {
    switch (condition.kind) {
      case "text": {
        const values = condition.values
          .map((value) => value.trim())
          .filter(Boolean);
        if (values.length === 0) {
          return { error: "Fill in the text to match, or remove that condition" };
        }
        if (condition.op === "regex") {
          for (const value of values) {
            try {
              new RegExp(value);
            } catch {
              return { error: `“${value}” is not a valid regular expression` };
            }
          }
        }
        conditions.push({ ...condition, values });
        break;
      }
      case "amount": {
        const value = Number(condition.value);
        if (condition.value.trim() === "" || !Number.isFinite(value)) {
          return { error: "Fill in an amount to compare against" };
        }
        conditions.push({ kind: "amount", op: condition.op, value });
        break;
      }
      case "account": {
        const accountIds = condition.accountIds.filter((id) =>
          accounts.some((account) => account.id === id),
        );
        if (accountIds.length === 0) {
          return { error: "Pick an account, or remove that condition" };
        }
        conditions.push({ kind: "account", accountIds });
        break;
      }
      case "category": {
        if (condition.categoryIds.length === 0) {
          return { error: "Pick a category, or remove that condition" };
        }
        conditions.push(condition);
        break;
      }
      case "pending":
        conditions.push(condition);
        break;
    }
  }

  if (conditions.length === 0) {
    return {
      error:
        "Add at least one condition — a rule with none would match every transaction",
    };
  }

  const actions: RuleArgs["actions"] = [];
  for (const action of draft.actions) {
    switch (action.kind) {
      case "setCategory":
        if (!action.categoryId) {
          return { error: "Pick a category to set, or remove that action" };
        }
        actions.push(action);
        break;
      case "rename": {
        const value = action.value.trim();
        if (!value) {
          return { error: "Fill in the new title, or remove that action" };
        }
        actions.push({ kind: "rename", value });
        break;
      }
      case "addTags":
        if (action.tags.length === 0) {
          return { error: "Add a tag, or remove that action" };
        }
        actions.push(action);
        break;
      case "hide":
        actions.push(action);
        break;
    }
  }
  if (actions.length === 0) {
    return { error: "Add at least one thing for the rule to do" };
  }

  return { value: { name, conditions, actions } };
}
