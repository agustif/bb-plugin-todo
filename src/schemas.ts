import { z } from "zod";
import { ACTIONS, PRIORITIES, STATUSES } from "./constants.js";
import { DISPATCH_STATUSES, ROLES } from "./roles.js";

export const statusSchema = z.enum(STATUSES);
export const prioritySchema = z.enum(PRIORITIES);
export const actionSchema = z.enum(ACTIONS);
export const roleSchema = z.enum(ROLES);
export const dispatchStatusSchema = z.enum(DISPATCH_STATUSES);

// bb >= 0.40 rejects recursive $ref in agent tool parameter schemas
// (assertNoRecursiveJsonSchemaReferences), which the previous z.lazy()
// self-reference emitted. Nesting is unrolled to a fixed maximum depth instead.
export const MAX_NESTED_TODO_DEPTH = 5;

const nestedTodoBaseFields = () => ({
  id: z.string().min(1).max(64).optional(),
  content: z.string().min(1).max(240),
  activeForm: z.string().max(240).optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  dependsOn: z.array(z.string().min(1).max(64)).max(32).optional(),
  blockedBy: z.array(z.string().min(1).max(64)).max(32).optional(),
  requires: z.array(z.string().min(1).max(80)).max(32).optional(),
  notes: z.string().max(500).optional(),
  assignee: z.string().min(1).max(64).optional(),
  assigneeRole: z.string().min(1).max(64).optional(),
  assigneeLabel: z.string().max(240).optional(),
});

const buildNestedTodoSchema = (
  depth: number,
): z.ZodType<NestedTodoInputShape> => {
  if (depth <= 1) {
    return z
      .object(nestedTodoBaseFields())
      .strict() as z.ZodType<NestedTodoInputShape>;
  }
  return z
    .object({
      ...nestedTodoBaseFields(),
      children: z.array(buildNestedTodoSchema(depth - 1)).max(100).optional(),
    })
    .strict() as z.ZodType<NestedTodoInputShape>;
};

export const nestedTodoInputSchema: z.ZodType<NestedTodoInputShape> =
  buildNestedTodoSchema(MAX_NESTED_TODO_DEPTH);

export interface NestedTodoInputShape {
  id?: string;
  content: string;
  activeForm?: string;
  status?: z.infer<typeof statusSchema>;
  priority?: z.infer<typeof prioritySchema>;
  dependsOn?: string[];
  blockedBy?: string[];
  requires?: string[];
  notes?: string;
  assignee?: string;
  assigneeRole?: string;
  assigneeLabel?: string;
  children?: NestedTodoInputShape[];
}

export const markEntrySchema = z
  .object({
    id: z.string().min(1).max(64),
    status: statusSchema,
    activeForm: z.string().max(240).optional(),
    content: z.string().max(240).optional(),
  })
  .strict();

export const todoToolInputSchema = z
  .object({
    action: actionSchema.optional(),
    items: z.array(nestedTodoInputSchema).max(200).optional(),
    todos: z.array(nestedTodoInputSchema).max(200).optional(),
    id: z.string().min(1).max(64).optional(),
    ids: z.array(z.string().min(1).max(64)).max(100).optional(),
    content: z.string().max(240).optional(),
    activeForm: z.string().max(240).optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    parentId: z.string().min(1).max(64).nullable().optional(),
    dependsOn: z.array(z.string().min(1).max(64)).max(32).optional(),
    blockedBy: z.array(z.string().min(1).max(64)).max(32).optional(),
    addDependsOn: z.array(z.string().min(1).max(64)).max(32).optional(),
    removeDependsOn: z.array(z.string().min(1).max(64)).max(32).optional(),
    requires: z.array(z.string().min(1).max(80)).max(32).optional(),
    addRequires: z.array(z.string().min(1).max(80)).max(32).optional(),
    removeRequires: z.array(z.string().min(1).max(80)).max(32).optional(),
    notes: z.string().max(500).nullable().optional(),
    mark: z.array(markEntrySchema).max(100).optional(),
    toParentId: z.string().min(1).max(64).nullable().optional(),
    afterId: z.string().min(1).max(64).nullable().optional(),
    note: z.string().max(500).optional(),
    /** assign / set role: self | scout | worker | reviewer | custom label */
    assignee: z.string().min(1).max(64).optional(),
    assigneeRole: z.string().min(1).max(64).optional(),
    assigneeLabel: z.string().max(240).nullable().optional(),
    /** report from child */
    summary: z.string().max(4000).optional(),
    /** dispatch visibility override */
    visibility: z.enum(["visible", "hidden"]).optional(),
    /** auto-complete parent todo when child goes idle without report (default false) */
    autoCompleteOnIdle: z.boolean().optional(),
  })
  .strict();

export type TodoToolInput = z.infer<typeof todoToolInputSchema>;

export const TOOL_DESCRIPTION = `Create and maintain a hierarchical todo list for the current thread. Surfaces live progress in the BB UI (composer todo card).

Use ONE tool for every todo operation via \`action\`:

- list — read current todos + ready/blocked summary
- set — replace the entire tree (pass nested \`items\` with optional \`children\`)
- add — append item(s); set \`parentId\` to nest; \`items\` may include children
- update — patch fields on \`id\` (content, status, priority, deps, requires, notes, parentId, assignee)
- start — mark id(s) in_progress (exactly one in_progress preferred)
- complete — mark id(s) completed
- cancel — mark id(s) cancelled
- remove — delete id(s) and their descendants
- clear — wipe the list
- move — reparent / reorder (\`toParentId\`, \`afterId\`)
- depend — set/add/remove dependsOn for \`id\`
- mark — batch status updates: [{id, status, activeForm?}]
- assign — set assignee role on id(s): self | scout | worker | reviewer | custom
- dispatch — spawn a BB child thread for id(s) (role must not be self; deps must be done)
- dispatch-ready — dispatch every ready non-self assigned todo (max 8)
- release — detach child thread link from id(s)
- report — from a dispatched CHILD thread: complete/block the linked parent todo

Shorthand: omit action and pass \`items\` ⇒ set.

## Item fields
- id (optional stable slug; auto-generated from content if omitted)
- content (required) — short actionable title
- activeForm — present-tense label while in_progress ("Running tests")
- status — pending | in_progress | completed | cancelled | blocked
- priority — high | medium | low
- dependsOn / blockedBy — other todo ids that must be **completed** first
- requires — freeform prerequisites (env, approval, docs)
- assignee / assigneeRole — self | scout | worker | reviewer | custom label
- children — nested sub-tasks, any depth
- notes — short private note

## Multi-agent (first-class BB)
1. Plan with set/add + dependsOn.
2. assign roles: { "action":"assign", "id":"api.routes", "assignee":"worker" }
3. dispatch when unblocked: { "action":"dispatch", "id":"api.routes" }
   → spawns a child thread (parentThreadId=this), seeds prompt, links assigneeThreadId.
4. Child finishes with: { "action":"report", "status":"completed", "summary":"…" }
5. Parent may dispatch-ready to fan out the next wave.

Rules: prefer exactly one in_progress on the parent; children own their thread.
Do not use for trivial single-step requests.
`;
