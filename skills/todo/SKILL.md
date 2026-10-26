---
name: todo
description: Plan and track multi-step work with the hierarchical todo tool (nested sub-tasks, dependsOn, requires, assign/dispatch child agents). Use whenever a task needs 3+ steps, has ordering constraints, multi-agent work, or the user asks for a checklist/plan/todos.
---

# Thread todos

Use the **`todo`** tool to maintain a live checklist for the current thread.
BB shows it above the composer, in the thread header, and as a compact
sidebar glyph on rows with open work.

## When to use

- Work needs 3+ distinct steps
- Ordering matters (`dependsOn`)
- Nested breakdown helps (parent → children → …)
- Multi-agent fan-out (scout / worker / reviewer child threads)
- User asks for a plan, checklist, or todos

Skip for trivial single-step asks.

## Actions

```
list | set | add | update | start | complete | cancel | remove | clear
move | depend | mark | assign | dispatch | dispatch-ready | link | release
report
```

Shorthand: pass only `items` → `set`.

### Plan

```json
{
  "action": "set",
  "items": [
    {
      "id": "api",
      "content": "Ship API",
      "children": [
        { "id": "api.schema", "content": "User schema", "assignee": "self" },
        {
          "id": "api.routes",
          "content": "Routes",
          "dependsOn": ["api.schema"],
          "assignee": "worker"
        },
        {
          "id": "api.review",
          "content": "Review routes",
          "dependsOn": ["api.routes"],
          "assignee": "reviewer"
        }
      ]
    }
  ]
}
```

### Multi-agent (first-class BB children)

1. `assign` roles: `self | scout | worker | reviewer | custom`
2. When deps are done: `dispatch` (or `dispatch-ready` for a wave)
3. Child threads get a seeded prompt + parent link
4. Child finishes with:

```json
{ "action": "report", "status": "completed", "summary": "what changed" }
```

5. `release` detaches a child link without deleting the todo

If the worker thread already exists (you, another plugin or an orchestrator
created it), `link` it instead of dispatching. The thread must be in this
project and not archived; the todo's dependencies must be done:

```json
{ "action": "link", "id": "api.routes", "threadId": "thr_…" }
```

The linked thread gets the worker instructions when its agent configuration is
next resolved, and `report`s the same way. It does not get the task prompt a
dispatched worker starts with, so tell it what to do yourself. `link` does not
spawn, message or wake the thread, or change its model.

Parent owns the plan. Children only `report`.

### Progress

```json
{
  "action": "mark",
  "mark": [
    { "id": "api.schema", "status": "completed" },
    { "id": "api.routes", "status": "in_progress", "activeForm": "Adding routes" }
  ]
}
```

## Rules

1. Exactly one parent `in_progress` preferred (children may also run).
2. Mark `completed` only after real completion.
3. Gate `dispatch` on completed `dependsOn`.
4. Prefer `dispatch-ready` over spawning blocked work.
5. Don’t paste the full tree back to the user — the UI shows it.
