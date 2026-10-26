import type { BbPluginApi, PluginAgentToolResult } from "@bb/plugin-sdk";
import {
  allocateId,
  childrenOf,
  collectDescendantIds,
  emptySnapshot,
  flattenDerived,
  deriveTree,
  indexById,
  moveItem,
  nestedToFlat,
  patchItem,
  type NestedTodoInput,
  type TodoItem,
  type TodoSnapshot,
  validateAcyclic,
} from "./model.js";
import {
  applyReport,
  dispatchTodos,
  linkTodo,
  parseAssigneeInput,
} from "./dispatch.js";
import { formatSnapshotMarkdown } from "./format.js";
import type { TodoStore } from "./store.js";
import { type TodoToolInput, todoToolInputSchema } from "./schemas.js";
import { STATUSES, type TodoStatus } from "./constants.js";

export interface TodoToolContext {
  threadId: string;
  projectId: string;
  store: TodoStore;
  publish: (threadId: string) => void;
  bb: BbPluginApi;
}

function err(message: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function ok(
  snapshot: TodoSnapshot,
  extras?: {
    changes?: string[];
    warnings?: string[];
    errors?: string[];
    note?: string;
  },
): string {
  return formatSnapshotMarkdown(snapshot, extras);
}

function resolveItems(input: TodoToolInput): NestedTodoInput[] | undefined {
  if (input.items && input.items.length > 0) {
    return input.items as NestedTodoInput[];
  }
  if (input.todos && input.todos.length > 0) {
    return input.todos as NestedTodoInput[];
  }
  if (input.items) return input.items as NestedTodoInput[];
  if (input.todos) return input.todos as NestedTodoInput[];
  return undefined;
}

function resolveAction(input: TodoToolInput): NonNullable<TodoToolInput["action"]> {
  if (input.action) return input.action;
  if (input.items || input.todos) return "set";
  if (input.mark) return "mark";
  return "list";
}

function targetIds(input: TodoToolInput): string[] {
  const ids: string[] = [];
  if (input.id) ids.push(input.id);
  if (input.ids) ids.push(...input.ids);
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function mergeDepends(input: TodoToolInput): string[] | undefined {
  if (!input.dependsOn && !input.blockedBy) return undefined;
  return [...(input.dependsOn ?? []), ...(input.blockedBy ?? [])];
}

function setStatuses(
  items: TodoItem[],
  ids: string[],
  status: TodoStatus,
  now: number,
  activeForm?: string,
): { items: TodoItem[]; changes: string[]; missing: string[] } {
  const want = new Set(ids);
  const found = new Set<string>();
  const changes: string[] = [];
  const next = items.map((item) => {
    if (!want.has(item.id)) return item;
    found.add(item.id);
    if (
      item.status === status &&
      (activeForm === undefined || item.activeForm === activeForm)
    ) {
      return item;
    }
    changes.push(`${status} ${item.id}`);
    return patchItem(
      item,
      {
        status,
        ...(activeForm !== undefined
          ? { activeForm: activeForm || null }
          : status !== "in_progress"
            ? {}
            : {}),
      },
      now,
    );
  });
  const missing = ids.filter((id) => !found.has(id));
  return { items: next, changes, missing };
}

function addFromNested(
  current: TodoItem[],
  inputs: NestedTodoInput[],
  parentId: string | null,
  now: number,
): { items: TodoItem[]; changes: string[]; errors: string[] } {
  const { items: fresh, errors } = nestedToFlat(inputs, now, current);
  const topIds = new Set(
    fresh.filter((i) => i.parentId === null).map((i) => i.id),
  );
  const baseOrder =
    childrenOf(current, parentId).reduce(
      (max, item) => Math.max(max, item.sortOrder),
      -1,
    ) + 1;

  let order = baseOrder;
  const adjusted = fresh.map((item) => {
    if (item.parentId === null && topIds.has(item.id)) {
      return {
        ...item,
        parentId,
        sortOrder: order++,
      };
    }
    return item;
  });

  const changes = adjusted.map((item) => `added ${item.id}`);
  return {
    items: [...current, ...adjusted],
    changes,
    errors,
  };
}

function defaultNewItem(
  partial: Omit<
    TodoItem,
    | "assigneeRole"
    | "assigneeLabel"
    | "assigneeThreadId"
    | "dispatchStatus"
    | "lastReport"
  > &
    Partial<
      Pick<
        TodoItem,
        | "assigneeRole"
        | "assigneeLabel"
        | "assigneeThreadId"
        | "dispatchStatus"
        | "lastReport"
      >
    >,
): TodoItem {
  const role = partial.assigneeRole ?? "self";
  return {
    assigneeRole: role,
    assigneeLabel: partial.assigneeLabel ?? null,
    assigneeThreadId: partial.assigneeThreadId ?? null,
    dispatchStatus:
      partial.dispatchStatus ??
      (role === "self" ? "unassigned" : "assigned"),
    lastReport: partial.lastReport ?? null,
    ...partial,
    assigneeRole: role,
  };
}

export async function executeTodoTool(
  rawInput: unknown,
  ctx: TodoToolContext,
): Promise<PluginAgentToolResult | string> {
  const parsed = todoToolInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err(
      `Invalid todo input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const input = parsed.data;
  const action = resolveAction(input);
  const now = Date.now();
  const warnings: string[] = [];
  const errors: string[] = [];
  let changes: string[] = [];

  // report is resolved against the child→parent link, not the caller's list.
  if (action === "report") {
    const result = applyReport({
      store: ctx.store,
      childThreadId: ctx.threadId,
      status:
        input.status === "completed" ||
        input.status === "blocked" ||
        input.status === "cancelled" ||
        input.status === "in_progress"
          ? input.status
          : "completed",
      summary: input.summary ?? input.note,
      notes: typeof input.notes === "string" ? input.notes : undefined,
      publish: ctx.publish,
    });
    if (result.errors.length) {
      return err(result.errors.join("\n"));
    }
    return ok(result.snapshot, {
      changes: result.changes,
      note: input.note,
    });
  }

  let snapshot = ctx.store.get(ctx.threadId);
  let items = snapshot.items;

  if (action === "link") {
    if (!input.id || !input.threadId) {
      return err("link requires `id` and `threadId`.");
    }
    const result = await linkTodo({
      bb: ctx.bb,
      store: ctx.store,
      parentThreadId: ctx.threadId,
      projectId: ctx.projectId,
      todoId: input.id,
      threadId: input.threadId,
      publish: ctx.publish,
    });
    if (!result.ok) return err(result.error);
    return ok(result.snapshot, { changes: result.changes, note: input.note });
  }

  if (action === "dispatch" || action === "dispatch-ready") {
    let ids =
      action === "dispatch-ready"
        ? flattenDerived(deriveTree(items))
            .filter(
              (item) =>
                item.assigneeRole !== "self" &&
                item.effectiveStatus === "pending" &&
                item.dispatchStatus !== "running",
            )
            .map((item) => item.id)
        : targetIds(input);
    if (action === "dispatch" && ids.length === 0) {
      return err('dispatch requires `id` or `ids`.');
    }
    if (action === "dispatch-ready" && ids.length === 0) {
      return ok(snapshot, {
        changes: [],
        warnings: ["No ready non-self todos to dispatch."],
        note: input.note,
      });
    }
    const result = await dispatchTodos({
      bb: ctx.bb,
      store: ctx.store,
      parentThreadId: ctx.threadId,
      projectId: ctx.projectId,
      todoIds: ids,
      publish: ctx.publish,
      visibility: input.visibility,
    });
    if (
      result.changes.length === 0 &&
      result.errors.length > 0 &&
      result.warnings.length === 0
    ) {
      return err(
        `${result.errors.map((e) => `- ${e}`).join("\n")}\n\n${ok(result.snapshot)}`,
      );
    }
    return ok(result.snapshot, {
      changes: result.changes,
      errors: result.errors,
      warnings: result.warnings,
      note: input.note,
    });
  }

  switch (action) {
    case "list": {
      return ok(snapshot, { note: input.note, warnings, errors });
    }
    case "clear": {
      snapshot = ctx.store.clear(ctx.threadId, now);
      ctx.publish(ctx.threadId);
      return ok(snapshot, {
        changes: ["cleared all todos"],
        note: input.note,
      });
    }
    case "set": {
      const setItems = resolveItems(input);
      if (!setItems || setItems.length === 0) {
        snapshot = ctx.store.clear(ctx.threadId, now);
        ctx.publish(ctx.threadId);
        return ok(snapshot, {
          changes: ["set empty list"],
          note: input.note,
        });
      }
      const flat = nestedToFlat(setItems, now);
      errors.push(...flat.errors);
      if (flat.items.length === 0) {
        return err(
          `set produced no items.\n${errors.map((e) => `- ${e}`).join("\n")}`,
        );
      }
      const cycle = validateAcyclic(flat.items);
      if (!cycle.ok) {
        return err(`Dependency cycle: ${cycle.cycle.join(" → ")}`);
      }
      snapshot = ctx.store.save({
        threadId: ctx.threadId,
        updatedAt: now,
        items: flat.items,
      });
      ctx.publish(ctx.threadId);
      return ok(snapshot, {
        changes: [`set ${flat.items.length} item(s)`],
        warnings,
        errors,
        note: input.note,
      });
    }
    case "add": {
      const parentId = input.parentId === undefined ? null : input.parentId;
      if (parentId !== null && !indexById(items).has(parentId)) {
        return err(`Unknown parentId "${parentId}".`);
      }
      const addItems = resolveItems(input);
      if (addItems && addItems.length > 0) {
        const result = addFromNested(items, addItems, parentId, now);
        errors.push(...result.errors);
        items = result.items;
        changes = result.changes;
      } else if (input.content && input.content.trim()) {
        const used = new Set(items.map((i) => i.id));
        const id = allocateId(input.content, used, input.id, parentId);
        const sortOrder =
          childrenOf(items, parentId).reduce(
            (max, item) => Math.max(max, item.sortOrder),
            -1,
          ) + 1;
        const deps = mergeDepends(input) ?? [];
        const byId = indexById(items);
        for (const dep of deps) {
          if (!byId.has(dep) && dep !== id) {
            warnings.push(`dependsOn unknown id "${dep}" (kept).`);
          }
        }
        const assignee = parseAssigneeInput(
          input.assigneeRole ?? input.assignee,
        );
        const row = defaultNewItem({
          id,
          content: input.content.trim(),
          activeForm: input.activeForm?.trim() || null,
          status: input.status ?? "pending",
          priority: input.priority ?? "medium",
          parentId,
          dependsOn: deps,
          requires: input.requires ?? [],
          notes:
            input.notes === undefined || input.notes === null
              ? null
              : input.notes,
          assigneeRole: assignee?.role ?? "self",
          assigneeLabel:
            input.assigneeLabel === undefined
              ? (assignee?.label ?? null)
              : input.assigneeLabel,
          sortOrder,
          createdAt: now,
          updatedAt: now,
        });
        items = [...items, row];
        changes = [`added ${id}`];
      } else {
        return err(
          'add requires `content` or `items`. Example: { "action": "add", "content": "Write tests", "parentId": "api" }',
        );
      }
      break;
    }
    case "update": {
      const id = input.id;
      if (!id) return err("update requires `id`.");
      const byId = indexById(items);
      const existing = byId.get(id);
      if (!existing) return err(`Unknown id "${id}".`);
      if (input.parentId !== undefined && input.parentId !== null) {
        if (!byId.has(input.parentId)) {
          return err(`Unknown parentId "${input.parentId}".`);
        }
        if (
          collectDescendantIds(items, id).has(input.parentId) ||
          input.parentId === id
        ) {
          return err("Invalid parentId (would create a cycle).");
        }
      }
      const deps = mergeDepends(input);
      const assignee = parseAssigneeInput(
        input.assigneeRole ?? input.assignee,
      );
      const next = patchItem(
        existing,
        {
          content: input.content,
          activeForm:
            input.activeForm === undefined
              ? undefined
              : input.activeForm || null,
          status: input.status,
          priority: input.priority,
          parentId: input.parentId,
          dependsOn: deps,
          addDependsOn: input.addDependsOn,
          removeDependsOn: input.removeDependsOn,
          requires: input.requires,
          addRequires: input.addRequires,
          removeRequires: input.removeRequires,
          notes: input.notes,
          assigneeRole: assignee?.role,
          assigneeLabel:
            input.assigneeLabel !== undefined
              ? input.assigneeLabel
              : assignee
                ? assignee.label
                : undefined,
        },
        now,
      );
      items = items.map((row) => (row.id === id ? next : row));
      changes = [`updated ${id}`];
      break;
    }
    case "assign": {
      const ids = targetIds(input);
      if (ids.length === 0) return err("assign requires `id` or `ids`.");
      const assignee = parseAssigneeInput(
        input.assigneeRole ?? input.assignee ?? "worker",
      );
      if (!assignee) return err("assign requires `assignee` role.");
      const byId = indexById(items);
      for (const id of ids) {
        const existing = byId.get(id);
        if (!existing) {
          errors.push(`Unknown id "${id}".`);
          continue;
        }
        const next = patchItem(
          existing,
          {
            assigneeRole: assignee.role,
            assigneeLabel:
              input.assigneeLabel !== undefined
                ? input.assigneeLabel
                : assignee.label,
          },
          now,
        );
        byId.set(id, next);
        changes.push(`assigned ${id} → ${assignee.role}`);
      }
      items = items.map((row) => byId.get(row.id) ?? row);
      break;
    }
    case "release": {
      const ids = targetIds(input);
      if (ids.length === 0) return err("release requires `id` or `ids`.");
      const byId = indexById(items);
      for (const id of ids) {
        const existing = byId.get(id);
        if (!existing) {
          errors.push(`Unknown id "${id}".`);
          continue;
        }
        if (existing.assigneeThreadId) {
          ctx.store.forgetChild(existing.assigneeThreadId);
        }
        const next = patchItem(
          existing,
          {
            assigneeThreadId: null,
            dispatchStatus:
              existing.assigneeRole === "self" ? "unassigned" : "released",
          },
          now,
        );
        byId.set(id, next);
        changes.push(`released ${id}`);
      }
      items = items.map((row) => byId.get(row.id) ?? row);
      break;
    }
    case "start":
    case "complete":
    case "cancel": {
      const ids = targetIds(input);
      if (ids.length === 0) {
        return err(`${action} requires \`id\` or \`ids\`.`);
      }
      const status: TodoStatus =
        action === "start"
          ? "in_progress"
          : action === "complete"
            ? "completed"
            : "cancelled";
      const result = setStatuses(items, ids, status, now, input.activeForm);
      if (result.missing.length > 0) {
        errors.push(`Unknown id(s): ${result.missing.join(", ")}`);
      }
      if (
        result.changes.length === 0 &&
        result.missing.length === ids.length
      ) {
        return err(`No matching todos for ${action}.`);
      }
      items = result.items;
      changes = result.changes;
      break;
    }
    case "remove": {
      const ids = targetIds(input);
      if (ids.length === 0) return err("remove requires `id` or `ids`.");
      const drop = new Set<string>();
      for (const id of ids) {
        if (!indexById(items).has(id)) {
          errors.push(`Unknown id "${id}".`);
          continue;
        }
        for (const d of collectDescendantIds(items, id)) drop.add(d);
      }
      if (drop.size === 0) return err("Nothing to remove.");
      for (const item of items) {
        if (drop.has(item.id) && item.assigneeThreadId) {
          ctx.store.forgetChild(item.assigneeThreadId);
        }
      }
      items = items.filter((item) => !drop.has(item.id));
      items = items.map((item) => ({
        ...item,
        dependsOn: item.dependsOn.filter((d) => !drop.has(d)),
        updatedAt: item.dependsOn.some((d) => drop.has(d))
          ? now
          : item.updatedAt,
      }));
      changes = [...drop].map((id) => `removed ${id}`);
      break;
    }
    case "move": {
      const id = input.id;
      if (!id) return err("move requires `id`.");
      const moved = moveItem(
        items,
        id,
        input.toParentId,
        input.afterId,
        now,
      );
      if (moved.error) return err(moved.error);
      items = moved.items;
      changes = [`moved ${id}`];
      break;
    }
    case "depend": {
      const id = input.id;
      if (!id) return err("depend requires `id`.");
      const existing = indexById(items).get(id);
      if (!existing) return err(`Unknown id "${id}".`);
      const deps = mergeDepends(input);
      if (
        deps === undefined &&
        !input.addDependsOn &&
        !input.removeDependsOn
      ) {
        return err(
          "depend requires dependsOn/blockedBy, addDependsOn, or removeDependsOn.",
        );
      }
      const next = patchItem(
        existing,
        {
          dependsOn: deps,
          addDependsOn: input.addDependsOn,
          removeDependsOn: input.removeDependsOn,
        },
        now,
      );
      items = items.map((row) => (row.id === id ? next : row));
      changes = [`updated deps on ${id}`];
      break;
    }
    case "mark": {
      if (!input.mark || input.mark.length === 0) {
        return err('mark requires `mark: [{ id, status, ... }]`.');
      }
      const byId = indexById(items);
      for (const entry of input.mark) {
        const existing = byId.get(entry.id);
        if (!existing) {
          errors.push(`Unknown id "${entry.id}".`);
          continue;
        }
        if (!STATUSES.includes(entry.status)) {
          errors.push(`Invalid status for ${entry.id}.`);
          continue;
        }
        const next = patchItem(
          existing,
          {
            status: entry.status,
            activeForm:
              entry.activeForm === undefined
                ? undefined
                : entry.activeForm || null,
            content: entry.content,
          },
          now,
        );
        byId.set(entry.id, next);
        changes.push(`${entry.status} ${entry.id}`);
      }
      items = items.map((row) => byId.get(row.id) ?? row);
      break;
    }
    default: {
      return err(`Unknown action: ${action}`);
    }
  }

  const cycle = validateAcyclic(items);
  if (!cycle.ok) {
    return err(
      `Operation rejected — dependency cycle: ${cycle.cycle.join(" → ")}`,
    );
  }

  const idSet = new Set(items.map((i) => i.id));
  items = items.map((item) => {
    const missing = item.dependsOn.filter((d) => !idSet.has(d));
    if (missing.length === 0) return item;
    for (const m of missing) {
      warnings.push(`Dropped missing dependsOn "${m}" from ${item.id}.`);
    }
    return {
      ...item,
      dependsOn: item.dependsOn.filter((d) => idSet.has(d)),
      updatedAt: now,
    };
  });

  const inProgress = items.filter((i) => i.status === "in_progress");
  if (inProgress.length > 1) {
    warnings.push(
      `${inProgress.length} items are in_progress (${inProgress
        .map((i) => i.id)
        .join(", ")}); prefer exactly one on the parent.`,
    );
  }

  snapshot =
    items.length === 0
      ? ctx.store.clear(ctx.threadId, now)
      : ctx.store.save({
          threadId: ctx.threadId,
          updatedAt: now,
          items,
        });
  ctx.publish(ctx.threadId);

  if (changes.length === 0 && errors.length > 0) {
    return err(
      `No changes applied.\n${errors.map((e) => `- ${e}`).join("\n")}\n\n${ok(
        snapshot,
      )}`,
    );
  }

  return ok(snapshot, {
    changes,
    warnings,
    errors,
    note: input.note,
  });
}

export function listSnapshot(
  store: TodoStore,
  threadId: string,
): TodoSnapshot {
  return store.get(threadId) ?? emptySnapshot(threadId);
}
