import type { BbPluginApi } from "@bb/plugin-sdk";
import { MAX_DISPATCH_BATCH, REPORT_MAX, TEXT_MAX } from "./constants.js";
import {
  deriveTree,
  flattenDerived,
  indexById,
  patchItem,
  waitingOnDeps,
  type TodoItem,
  type TodoSnapshot,
} from "./model.js";
import { roleBrief, roleLabel, type TodoRole } from "./roles.js";
import type { TodoStore } from "./store.js";

function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

export function buildWorkerPrompt(args: {
  parentThreadId: string;
  item: TodoItem;
  snapshot: TodoSnapshot;
}): string {
  const { parentThreadId, item, snapshot } = args;
  const byId = indexById(snapshot.items);
  const deps = item.dependsOn
    .map((id) => {
      const dep = byId.get(id);
      return dep
        ? `- ${id}: ${dep.content} [${dep.status}]`
        : `- ${id}: (missing)`;
    })
    .join("\n");
  const siblings = flattenDerived(deriveTree(snapshot.items))
    .filter((n) => n.id !== item.id)
    .slice(0, 24)
    .map((n) => `- [${n.effectiveStatus}] **${n.id}** ${n.content}`)
    .join("\n");

  const role = item.assigneeRole;
  const brief = roleBrief(role, item.assigneeLabel);

  return [
    `# Assigned todo: ${item.id}`,
    "",
    brief,
    "",
    "## Todo",
    `- **id:** ${item.id}`,
    `- **content:** ${item.content}`,
    item.activeForm ? `- **activeForm:** ${item.activeForm}` : null,
    item.notes
      ? [`- **implementation notes:**`, "", item.notes, ""].join("\n")
      : null,
    item.requires.length
      ? `- **requires:** ${item.requires.join(", ")}`
      : null,
    item.priority !== "medium" ? `- **priority:** ${item.priority}` : null,
    "",
    "## Dependencies",
    deps || "_none_",
    "",
    "## Sibling plan (read-only context)",
    siblings || "_none_",
    "",
    "## Orchestrator thread",
    `- orchestratorThreadId: \`${parentThreadId}\``,
    "- You run as a **root sidebar worker thread** linked via assigneeThreadId (not nested under the parent).",
    "",
    "## When finished",
    "Call the `todo` tool from THIS worker thread:",
    "",
    "```json",
    JSON.stringify(
      {
        action: "report",
        status: "completed",
        summary: "What you did (short)",
        notes: "optional blockers or follow-ups",
      },
      null,
      2,
    ),
    "```",
    "",
    "If blocked, report status \"blocked\" with notes. Do not edit other todos' status except via report.",
    "The parent orchestrator owns the overall plan.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// Todos whose worker is being spawned, keyed by parent thread and todo id.
// Link and dispatch refuse these, so the slow spawn call cannot race another
// assignment of the same todo in this plugin instance.
const starting = new Set<string>();
const startingKey = (parentThreadId: string, todoId: string) =>
  `${parentThreadId}\u0000${todoId}`;

export function canDispatch(
  item: TodoItem,
  snapshot: TodoSnapshot,
): { ok: true } | { ok: false; reason: string } {
  if (item.status === "completed" || item.status === "cancelled") {
    return { ok: false, reason: `Todo ${item.id} is already ${item.status}.` };
  }
  if (item.assigneeRole === "self") {
    return {
      ok: false,
      reason: `Todo ${item.id} is assigned to self — work it in the parent thread (or assign a role first).`,
    };
  }
  if (item.dispatchStatus === "running" && item.assigneeThreadId) {
    return {
      ok: false,
      reason: `Todo ${item.id} already has a running worker (${item.assigneeThreadId}).`,
    };
  }
  // Allow re-dispatch after release/failed/idle without a live thread.
  const waiting = waitingOnDeps(item, indexById(snapshot.items));
  if (waiting.length > 0) {
    return {
      ok: false,
      reason: `Todo ${item.id} is blocked by: ${waiting.join(", ")}.`,
    };
  }
  return { ok: true };
}

/**
 * Link an existing thread to a todo as its worker, without spawning one. The
 * linked thread then receives the worker instructions, can `report`, and its
 * idle/failed/archived/deleted events update the todo like a dispatched child.
 */
export async function linkTodo(args: {
  bb: BbPluginApi;
  store: TodoStore;
  parentThreadId: string;
  projectId: string;
  todoId: string;
  threadId: string;
  publish: (threadId: string) => void;
}): Promise<
  | { ok: true; snapshot: TodoSnapshot; changes: string[] }
  | { ok: false; error: string }
> {
  const { bb, store, parentThreadId, projectId, todoId, publish } = args;
  const threadId = args.threadId.trim();
  if (threadId === parentThreadId) {
    return { ok: false, error: "A thread cannot be linked as its own worker." };
  }

  let thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  try {
    thread = await bb.sdk.threads.get({ threadId });
  } catch (error) {
    return {
      ok: false,
      error: `Could not read thread ${threadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (thread.projectId !== projectId) {
    return {
      ok: false,
      error: `Thread ${threadId} belongs to a different project.`,
    };
  }
  if (thread.archivedAt != null || thread.deletedAt != null) {
    return {
      ok: false,
      error: `Thread ${threadId} is ${thread.deletedAt != null ? "deleted" : "archived"}.`,
    };
  }

  // Read the list after the lookup so an edit made during it is kept.
  const snapshot = store.get(parentThreadId);
  const item = snapshot.items.find((i) => i.id === todoId);
  if (!item) return { ok: false, error: `Unknown id "${todoId}".` };
  if (item.status === "completed" || item.status === "cancelled") {
    return { ok: false, error: `Todo ${item.id} is already ${item.status}.` };
  }
  if (starting.has(startingKey(parentThreadId, item.id))) {
    return { ok: false, error: `Todo ${item.id} is being dispatched.` };
  }
  if (item.assigneeThreadId) {
    return {
      ok: false,
      error: `Todo ${item.id} is already linked to ${item.assigneeThreadId}; release it first.`,
    };
  }
  const existing = store.findByChildThread(threadId);
  if (existing) {
    return {
      ok: false,
      error: `Thread ${threadId} is already the worker for todo ${existing.item.id} in ${existing.parent.threadId}.`,
    };
  }
  const waiting = waitingOnDeps(item, indexById(snapshot.items));
  if (waiting.length > 0) {
    return {
      ok: false,
      error: `Todo ${item.id} is blocked by: ${waiting.join(", ")}.`,
    };
  }

  const now = Date.now();
  const role = item.assigneeRole === "self" ? "worker" : item.assigneeRole;
  const saved = store.save({
    threadId: parentThreadId,
    updatedAt: now,
    items: snapshot.items.map((row) =>
      row.id === item.id
        ? patchItem(
            row,
            {
              status: "in_progress",
              assigneeRole: role,
              assigneeThreadId: threadId,
              dispatchStatus: "running",
              activeForm:
                row.activeForm ??
                `Working via ${roleLabel(role, row.assigneeLabel)}`,
            },
            now,
          )
        : row,
    ),
  });
  publish(parentThreadId);
  return { ok: true, snapshot: saved, changes: [`linked ${item.id} → ${threadId}`] };
}

export async function dispatchTodos(args: {
  bb: BbPluginApi;
  store: TodoStore;
  parentThreadId: string;
  projectId: string;
  todoIds: string[];
  publish: (threadId: string) => void;
  visibility?: "visible" | "hidden";
  /**
   * - `root` (default): top-level sidebar thread; linked only via todo assigneeThreadId.
   * - `child`: nested under orchestrator via parentThreadId.
   */
  attach?: "root" | "child";
}): Promise<{
  snapshot: TodoSnapshot;
  changes: string[];
  errors: string[];
  warnings: string[];
}> {
  const {
    bb,
    store,
    parentThreadId,
    projectId,
    publish,
    visibility = "visible",
    attach = "root",
  } = args;
  const changes: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = Date.now();

  let snapshot = store.get(parentThreadId);
  const ids = [...new Set(args.todoIds)].slice(0, MAX_DISPATCH_BATCH);
  if (args.todoIds.length > MAX_DISPATCH_BATCH) {
    warnings.push(
      `Dispatch batch capped at ${MAX_DISPATCH_BATCH} (got ${args.todoIds.length}).`,
    );
  }

  let parentMeta: {
    environmentId: string | null;
    providerId: string;
  } | null = null;
  try {
    const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
    parentMeta = {
      environmentId: parent.environmentId,
      providerId: parent.providerId,
    };
  } catch (error) {
    warnings.push(
      `Could not read parent thread metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Worker model: prefer Grok (xAI via Pi route) now that the user is logged in.
  const PREFERRED_GROK = "exe-dev-xai/grok-4.5@llm";
  const FALLBACK_OPENAI = "exe-dev-openai/gpt-5.6-sol@llm";
  let spawnModel: string = PREFERRED_GROK;
  try {
    const providerId = parentMeta?.providerId ?? "pi";
    const catalog = await bb.sdk.providers.models({
      providerId,
      ...(parentMeta?.environmentId
        ? { environmentId: parentMeta.environmentId }
        : {}),
    });
    const rows = catalog.models ?? [];
    const pick = (m: (typeof rows)[number] | undefined) =>
      (typeof m?.model === "string" && m.model) ||
      (typeof m?.id === "string" && m.id) ||
      undefined;
    const grok =
      rows.find((m) => String(m.id ?? m.model ?? "") === PREFERRED_GROK) ??
      rows.find(
        (m) =>
          String(m.id ?? "").includes("exe-dev-xai") &&
          String(m.id ?? "").includes("grok"),
      );
    const openai =
      rows.find(
        (m) => String(m.id ?? "").includes("exe-dev-openai") && m.isDefault,
      ) ?? rows.find((m) => String(m.id ?? "").includes("exe-dev-openai"));
    spawnModel =
      pick(grok) ??
      pick(openai) ??
      pick(rows.find((m) => m.isDefault)) ??
      pick(rows[0]) ??
      PREFERRED_GROK;
    warnings.push(`Workers use model ${spawnModel}.`);
  } catch (error) {
    warnings.push(
      `Could not resolve spawn model catalog: ${
        error instanceof Error ? error.message : String(error)
      }; defaulting to ${PREFERRED_GROK}`,
    );
    spawnModel = PREFERRED_GROK;
  }
  void FALLBACK_OPENAI;

  for (const todoId of ids) {
    snapshot = store.get(parentThreadId);
    const item = snapshot.items.find((i) => i.id === todoId);
    if (!item) {
      errors.push(`Unknown id "${todoId}".`);
      continue;
    }
    const gate = canDispatch(item, snapshot);
    if (!gate.ok) {
      errors.push(gate.reason);
      continue;
    }
    const key = startingKey(parentThreadId, todoId);
    if (starting.has(key)) {
      errors.push(`Todo ${todoId} is being dispatched.`);
      continue;
    }
    const priorAssignee = item.assigneeThreadId;

    const title = `[${roleLabel(item.assigneeRole, item.assigneeLabel)}:${item.id}] ${item.content}`.slice(
      0,
      120,
    );
    const prompt = buildWorkerPrompt({
      parentThreadId,
      item,
      snapshot,
    });

    try {
      const spawnArgs: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0] = {
        projectId,
        title,
        prompt,
        visibility,
        // Root workers are preferred: still tracked on the todo via
        // assigneeThreadId + assignee_index. Nested children optional.
        ...(attach === "child" ? { parentThreadId } : {}),
        environment: parentMeta?.environmentId
          ? { type: "reuse", environmentId: parentMeta.environmentId }
          : { type: "project-default" },
      };
      if (parentMeta?.providerId) {
        spawnArgs.providerId = parentMeta.providerId;
      }
      if (spawnModel) {
        spawnArgs.model = spawnModel;
      }

      starting.add(key);
      let child: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["spawn"]>>;
      try {
        child = await bb.sdk.threads.spawn(spawnArgs);
      } finally {
        starting.delete(key);
      }
      // Re-read after the spawn and change only this todo, so edits, reports
      // and links saved meanwhile are kept.
      snapshot = store.get(parentThreadId);
      const current = snapshot.items.find((row) => row.id === todoId);
      // An idle or failed worker assigned before the spawn is replaced, as
      // before; only an assignment that changed during the spawn conflicts.
      const conflict = !current
        ? "was removed"
        : current.status === "completed" || current.status === "cancelled"
          ? `is now ${current.status}`
          : current.assigneeThreadId &&
              current.assigneeThreadId !== priorAssignee
            ? `is now linked to ${current.assigneeThreadId}`
            : null;
      if (conflict) {
        errors.push(
          `Todo ${todoId} ${conflict}, so worker ${child.id} was started but is not tracked. Link it to a todo or archive it.`,
        );
        continue;
      }
      const nextItems = snapshot.items.map((row) =>
        row.id === todoId
          ? patchItem(
              row,
              {
                status: "in_progress",
                assigneeThreadId: child.id,
                dispatchStatus: "running",
                activeForm:
                  row.activeForm ??
                  `Working via ${roleLabel(row.assigneeRole, row.assigneeLabel)}`,
              },
              now,
            )
          : row,
      );
      snapshot = store.save({
        threadId: parentThreadId,
        updatedAt: now,
        items: nextItems,
      });
      changes.push(`dispatched ${todoId} → ${child.id}`);
    } catch (error) {
      errors.push(
        `Failed to dispatch ${todoId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  publish(parentThreadId);
  return { snapshot: store.get(parentThreadId), changes, errors, warnings };
}

export function applyChildLifecycle(args: {
  store: TodoStore;
  childThreadId: string;
  outcome: "idle" | "failed" | "deleted" | "archived";
  detail?: string | null;
  publish: (threadId: string) => void;
  autoCompleteOnIdle?: boolean;
}): { parentThreadId: string; changes: string[] } | null {
  const found = args.store.findByChildThread(args.childThreadId);
  if (!found) return null;
  const now = Date.now();
  const { parent, item } = found;
  const changes: string[] = [];

  let next = item;
  if (args.outcome === "idle") {
    const summary = args.detail ? clamp(args.detail, REPORT_MAX) : null;
    // Prefer explicit report from the child; idle without report stays in_progress
    // but marks dispatch idle so the orchestrator can inspect.
    if (item.status === "completed" || item.status === "cancelled") {
      next = patchItem(
        item,
        {
          dispatchStatus: "idle",
          lastReport: summary ?? item.lastReport,
        },
        now,
      );
      changes.push(`child idle for ${item.id} (already ${item.status})`);
    } else if (args.autoCompleteOnIdle) {
      next = patchItem(
        item,
        {
          status: "completed",
          dispatchStatus: "idle",
          lastReport: summary ?? item.lastReport ?? "Child thread went idle.",
          activeForm: null,
        },
        now,
      );
      changes.push(`auto-completed ${item.id} on child idle`);
    } else {
      next = patchItem(
        item,
        {
          dispatchStatus: "idle",
          lastReport:
            summary ??
            item.lastReport ??
            "Child went idle — orchestrator should verify and complete/report.",
        },
        now,
      );
      changes.push(`child idle for ${item.id} (awaiting report/verify)`);
    }
  } else if (args.outcome === "failed") {
    next = patchItem(
      item,
      {
        status: item.status === "completed" ? item.status : "blocked",
        dispatchStatus: "failed",
        notes: clamp(
          [item.notes, args.detail ? `child failed: ${args.detail}` : "child failed"]
            .filter(Boolean)
            .join(" · "),
          500,
        ),
        lastReport: args.detail ? clamp(args.detail, REPORT_MAX) : item.lastReport,
      },
      now,
    );
    changes.push(`child failed for ${item.id}`);
  } else {
    // deleted / archived
    next = patchItem(
      item,
      {
        dispatchStatus:
          item.status === "completed" || item.status === "cancelled"
            ? item.dispatchStatus
            : "released",
        assigneeThreadId: null,
        notes: clamp(
          [item.notes, `child ${args.outcome}`].filter(Boolean).join(" · "),
          500,
        ),
      },
      now,
    );
    args.store.forgetChild(args.childThreadId);
    changes.push(`cleared child link for ${item.id} (${args.outcome})`);
  }

  const items = parent.items.map((row) => (row.id === item.id ? next : row));
  args.store.save({
    threadId: parent.threadId,
    updatedAt: now,
    items,
  });
  args.publish(parent.threadId);
  return { parentThreadId: parent.threadId, changes };
}

export function applyReport(args: {
  store: TodoStore;
  childThreadId: string;
  status?: "completed" | "blocked" | "cancelled" | "in_progress";
  summary?: string;
  notes?: string;
  publish: (threadId: string) => void;
}): {
  snapshot: TodoSnapshot;
  changes: string[];
  errors: string[];
} {
  const found = args.store.findByChildThread(args.childThreadId);
  if (!found) {
    return {
      snapshot: {
        threadId: args.childThreadId,
        updatedAt: Date.now(),
        items: [],
      },
      changes: [],
      errors: [
        "This thread is not linked to a parent todo. report only works from a dispatched child.",
      ],
    };
  }
  const now = Date.now();
  const { parent, item } = found;
  const status = args.status ?? "completed";
  const summary = args.summary ? clamp(args.summary, REPORT_MAX) : null;
  const notes = args.notes
    ? clamp([item.notes, args.notes].filter(Boolean).join(" · "), 500)
    : item.notes;

  const next = patchItem(
    item,
    {
      status,
      notes,
      lastReport: summary,
      dispatchStatus:
        status === "completed" || status === "cancelled" ? "idle" : "running",
      activeForm: status === "in_progress" ? item.activeForm : null,
    },
    now,
  );
  const snapshot = args.store.save({
    threadId: parent.threadId,
    updatedAt: now,
    items: parent.items.map((row) => (row.id === item.id ? next : row)),
  });
  args.publish(parent.threadId);
  return {
    snapshot,
    changes: [`report ${item.id} → ${status}`],
    errors: [],
  };
}

export function parseAssigneeInput(
  raw: string | undefined,
): { role: TodoRole; label: string | null } | null {
  if (!raw || !raw.trim()) return null;
  const v = raw.trim();
  const lower = v.toLowerCase();
  if (
    lower === "self" ||
    lower === "scout" ||
    lower === "worker" ||
    lower === "reviewer" ||
    lower === "custom"
  ) {
    return { role: lower, label: null };
  }
  return { role: "custom", label: clamp(v, TEXT_MAX) };
}
