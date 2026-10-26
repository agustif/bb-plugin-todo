/**
 * Lightweight self-test for model + tool logic (no bb host required).
 * Run: node src/tool.selftest.mjs
 */
import assert from "node:assert/strict";
import {
  nestedToFlat,
  deriveTree,
  countTodos,
  validateAcyclic,
  moveItem,
  waitingOnDeps,
  indexById,
} from "./model.ts";
import { formatSnapshotMarkdown } from "./format.ts";
import { executeTodoTool } from "./tool.ts";
import { applyChildLifecycle } from "./dispatch.ts";

function memoryStore() {
  const map = new Map();
  const links = new Map(); // childThreadId -> { parentThreadId, todoId }
  return {
    get(threadId) {
      return (
        map.get(threadId) ?? {
          threadId,
          updatedAt: 0,
          items: [],
        }
      );
    },
    save(snapshot) {
      map.set(snapshot.threadId, snapshot);
      for (const [child, link] of [...links.entries()]) {
        if (link.parentThreadId === snapshot.threadId) links.delete(child);
      }
      for (const item of snapshot.items) {
        if (item.assigneeThreadId) {
          links.set(item.assigneeThreadId, {
            parentThreadId: snapshot.threadId,
            todoId: item.id,
          });
        }
      }
      return snapshot;
    },
    clear(threadId, now = Date.now()) {
      map.delete(threadId);
      for (const [child, link] of [...links.entries()]) {
        if (link.parentThreadId === threadId) links.delete(child);
      }
      return { threadId, updatedAt: now, items: [] };
    },
    knownThreadIds() {
      return [...map.keys()];
    },
    findByChildThread(childThreadId) {
      const link = links.get(childThreadId);
      if (!link) return null;
      const parent = map.get(link.parentThreadId);
      if (!parent) return null;
      const item = parent.items.find((i) => i.id === link.todoId);
      if (!item) return null;
      return {
        parent,
        item,
        link: { childThreadId, ...link },
      };
    },
    forgetChild(childThreadId) {
      links.delete(childThreadId);
    },
    listChildLinks(parentThreadId) {
      return [...links.entries()]
        .filter(([, link]) => link.parentThreadId === parentThreadId)
        .map(([childThreadId, link]) => ({ childThreadId, ...link }));
    },
  };
}

const now = 1_700_000_000_000;
const { items, errors } = nestedToFlat(
  [
    {
      id: "api",
      content: "Ship API",
      children: [
        { id: "api.schema", content: "Define schema" },
        {
          id: "api.routes",
          content: "Add routes",
          dependsOn: ["api.schema"],
        },
        {
          id: "api.tests",
          content: "Tests",
          children: [
            {
              id: "api.tests.unit",
              content: "Unit tests",
              dependsOn: ["api.routes"],
            },
          ],
        },
      ],
    },
    {
      id: "docs",
      content: "Docs",
      dependsOn: ["api"],
      requires: ["review"],
    },
  ],
  now,
);

assert.equal(errors.length, 0, errors.join("; "));
assert.equal(items.length, 6);
const tree = deriveTree(items);
assert.equal(tree.length, 2);
assert.equal(tree[0].children.length, 3);
assert.equal(tree[0].children[2].children.length, 1);

const byId = indexById(items);
const routes = items.find((i) => i.id === "api.routes");
assert.deepEqual(waitingOnDeps(routes, byId), ["api.schema"]);

const counts = countTodos(items);
assert.equal(counts.total, 6);
assert.equal(counts.blocked, 3); // routes, unit tests, docs (api parent not complete — docs depends on api which is pending)
// Actually docs depends on api which is pending -> blocked
// routes blocked by schema
// unit tests blocked by routes
// api, schema, api.tests are pending ready? api.tests has no dependsOn
assert.ok(counts.ready >= 2);

const cycle = validateAcyclic([
  ...items,
  {
    ...items[0],
    id: "loop-a",
    dependsOn: ["loop-b"],
    parentId: null,
    content: "A",
    activeForm: null,
    status: "pending",
    priority: "medium",
    requires: [],
    notes: null,
    sortOrder: 99,
    createdAt: now,
    updatedAt: now,
  },
  {
    ...items[0],
    id: "loop-b",
    dependsOn: ["loop-a"],
    parentId: null,
    content: "B",
    activeForm: null,
    status: "pending",
    priority: "medium",
    requires: [],
    notes: null,
    sortOrder: 100,
    createdAt: now,
    updatedAt: now,
  },
]);
assert.equal(cycle.ok, false);

const moved = moveItem(items, "api.tests.unit", "api", null, now);
assert.equal(moved.error, undefined);
assert.equal(
  moved.items.find((i) => i.id === "api.tests.unit").parentId,
  "api",
);

const store = memoryStore();
const publishes = [];
const ctx = {
  threadId: "thr_test",
  projectId: "proj_test",
  store,
  publish: (id) => publishes.push(id),
  bb: {
    sdk: {
      threads: {
        get: async () => ({
          id: "thr_test",
          environmentId: null,
          providerId: "test",
        }),
        spawn: async () => {
          throw new Error("spawn not expected in unit selftest");
        },
      },
    },
  },
};

let out = await executeTodoTool(
  {
    action: "set",
    items: [
      {
        id: "a",
        content: "Parent",
        children: [
          { id: "a1", content: "Child 1" },
          { id: "a2", content: "Child 2", dependsOn: ["a1"] },
        ],
      },
    ],
  },
  ctx,
);
assert.equal(typeof out, "string");
assert.match(out, /a1/);
assert.match(out, /blocked by: a1|Ready next/);
assert.equal(publishes.at(-1), "thr_test");

out = await executeTodoTool(
  {
    action: "mark",
    mark: [
      { id: "a1", status: "completed" },
      { id: "a2", status: "in_progress", activeForm: "Doing child 2" },
    ],
  },
  ctx,
);
assert.match(out, /Doing child 2/);
assert.match(out, /completed a1/);

out = await executeTodoTool(
  { action: "assign", id: "a2", assignee: "worker" },
  ctx,
);
assert.match(out, /assigned a2|@worker|worker/i);

out = await executeTodoTool({ action: "list" }, ctx);
assert.match(out, /1\/3 complete|1\/3 complete/i);

const md = formatSnapshotMarkdown(store.get("thr_test"));
assert.match(md, /\*\*a\*\*/);

// link: attach an existing thread as a todo's worker without spawning one.
{
  const linkStore = memoryStore();
  const threads = {
    thr_worker: { projectId: "proj_test" },
    thr_worker2: { projectId: "proj_test" },
    thr_elsewhere: { projectId: "proj_other" },
    thr_archived: { projectId: "proj_test", archivedAt: 1 },
    thr_deleted: { projectId: "proj_test", deletedAt: 1 },
  };
  const linkCtx = {
    ...ctx,
    threadId: "thr_parent",
    store: linkStore,
    bb: {
      sdk: {
        threads: {
          get: async ({ threadId }) => {
            const row = threads[threadId];
            if (!row) throw new Error("thread not found");
            return { id: threadId, archivedAt: null, deletedAt: null, ...row };
          },
          spawn: async () => {
            throw new Error("link must not spawn");
          },
        },
      },
    },
  };
  await executeTodoTool(
    {
      action: "set",
      items: [
        { id: "first", content: "First" },
        { id: "second", content: "Second", dependsOn: ["first"] },
        { id: "third", content: "Third" },
        { id: "done", content: "Done", status: "completed" },
        { id: "dropped", content: "Dropped", status: "cancelled" },
      ],
    },
    linkCtx,
  );
  // Successful calls return markdown; failures return an isError result.
  const text = (result) =>
    typeof result === "string" ? result : `ERROR: ${result.content[0].text}`;
  const link = async (id, threadId) =>
    text(await executeTodoTool({ action: "link", id, threadId }, linkCtx));
  const itemOf = (id) =>
    linkStore.get("thr_parent").items.find((item) => item.id === id);

  assert.match(
    text(await executeTodoTool({ action: "link", id: "first" }, linkCtx)),
    /^ERROR: link requires `id` and `threadId`/,
  );
  assert.match(await link("first", "thr_parent"), /^ERROR: .*own worker/);
  assert.match(await link("first", "thr_missing"), /^ERROR: Could not read thread thr_missing/);
  assert.match(await link("first", "thr_elsewhere"), /^ERROR: .*different project/);
  assert.match(await link("first", "thr_archived"), /^ERROR: .*archived/);
  assert.match(await link("first", "thr_deleted"), /^ERROR: .*deleted/);
  assert.match(await link("second", "thr_worker"), /^ERROR: .*blocked by: first/);
  assert.match(await link("done", "thr_worker"), /^ERROR: .*already completed/);
  assert.match(await link("dropped", "thr_worker"), /^ERROR: .*already cancelled/);
  assert.match(await link("nope", "thr_worker"), /^ERROR: Unknown id/);
  assert.equal(itemOf("first").assigneeThreadId, null);

  const linked = await link("first", "thr_worker");
  assert.match(linked, /linked first → thr_worker/);
  assert.equal(itemOf("first").status, "in_progress");
  assert.equal(itemOf("first").assigneeThreadId, "thr_worker");
  assert.equal(itemOf("first").dispatchStatus, "running");
  assert.equal(itemOf("first").assigneeRole, "worker");
  assert.equal(publishes.at(-1), "thr_parent");

  assert.match(await link("first", "thr_worker2"), /^ERROR: .*already linked to thr_worker; release it first/);
  assert.match(await link("third", "thr_worker"), /^ERROR: .*already the worker for todo first/);

  // The linked thread reports like a dispatched child.
  const report = text(
    await executeTodoTool(
      { action: "report", status: "completed", summary: "Shipped" },
      { ...linkCtx, threadId: "thr_worker" },
    ),
  );
  assert.match(report, /report first → completed/);
  assert.equal(itemOf("first").status, "completed");
  assert.equal(itemOf("first").lastReport, "Shipped");

  // Releasing frees the thread for another todo.
  await executeTodoTool({ action: "release", id: "first" }, linkCtx);
  assert.match(await link("third", "thr_worker"), /linked third → thr_worker/);
}

// dispatch holds a todo while its worker spawns, and saves only that todo
// afterwards, so links and edits made during the spawn are kept.
{
  const raceStore = memoryStore();
  const spawns = [];
  const raceCtx = {
    ...ctx,
    threadId: "thr_parent",
    store: raceStore,
    bb: {
      sdk: {
        threads: {
          get: async ({ threadId }) => ({
            id: threadId,
            projectId: "proj_test",
            environmentId: null,
            providerId: "test",
            archivedAt: null,
            deletedAt: null,
          }),
          // Each spawn waits until the test resolves it.
          spawn: () =>
            new Promise((resolve, reject) => {
              spawns.push((id, error) => (error ? reject(error) : resolve({ id })));
            }),
        },
      },
    },
  };
  const text = (result) =>
    typeof result === "string" ? result : `ERROR: ${result.content[0].text}`;
  const run = async (input) => text(await executeTodoTool(input, raceCtx));
  const itemOf = (id) =>
    raceStore.get("thr_parent").items.find((item) => item.id === id);
  // Wait until a dispatch call reaches its pending spawn.
  const spawnStarted = async (count) => {
    while (spawns.length < count) await new Promise((r) => setImmediate(r));
  };
  await run({
    action: "set",
    items: [
      { id: "a", content: "A", assignee: "worker" },
      { id: "b", content: "B" },
      { id: "c", content: "C", assignee: "worker" },
      { id: "d", content: "D", assignee: "worker" },
      { id: "e", content: "E", assignee: "worker" },
    ],
  });

  // A link to another todo during the spawn survives the dispatch save.
  const dispatchA = run({ action: "dispatch", id: "a" });
  await spawnStarted(1);
  assert.match(await run({ action: "link", id: "b", threadId: "thr_w" }), /linked b → thr_w/);
  // The todo being dispatched cannot be linked or dispatched again meanwhile.
  assert.match(await run({ action: "link", id: "a", threadId: "thr_x" }), /^ERROR: .*a is being dispatched/);
  assert.match(await run({ action: "dispatch", id: "a" }), /a is being dispatched/);
  spawns[0]("thr_n");
  assert.match(await dispatchA, /dispatched a → thr_n/);
  assert.equal(itemOf("a").assigneeThreadId, "thr_n");
  assert.equal(itemOf("b").assigneeThreadId, "thr_w");
  assert.equal(raceStore.findByChildThread("thr_w").item.id, "b");
  assert.equal(raceStore.findByChildThread("thr_n").item.id, "a");
  assert.equal(spawns.length, 1, "the refused dispatch did not spawn");

  // If the todo is closed during the spawn, the result names the untracked
  // worker instead of reopening the todo.
  const dispatchC = run({ action: "dispatch", id: "c" });
  await spawnStarted(2);
  await run({ action: "cancel", id: "c" });
  spawns[1]("thr_late");
  assert.match(await dispatchC, /c is now cancelled, so worker thr_late was started but is not tracked/);
  assert.equal(itemOf("c").status, "cancelled");
  assert.equal(itemOf("c").assigneeThreadId, null);
  assert.equal(raceStore.findByChildThread("thr_late"), null);
  // A failed spawn releases the hold, so the todo can be linked.
  const dispatchD = run({ action: "dispatch", id: "d" });
  await spawnStarted(3);
  spawns[2](null, new Error("spawn refused"));
  assert.match(await dispatchD, /Failed to dispatch d: spawn refused/);
  assert.match(await run({ action: "link", id: "d", threadId: "thr_y" }), /linked d → thr_y/);

  // Redispatching after the worker went idle or failed replaces it, as before:
  // the unchanged earlier assignment is not a conflict.
  const lifecycle = (childThreadId, outcome) =>
    applyChildLifecycle({ store: raceStore, childThreadId, outcome, publish: () => {} });
  const redispatch = async (oldWorker, outcome, newWorker) => {
    lifecycle(oldWorker, outcome);
    assert.equal(itemOf("a").dispatchStatus, outcome);
    assert.equal(itemOf("a").assigneeThreadId, oldWorker);
    const pending = run({ action: "dispatch", id: "a" });
    const index = spawns.length;
    await spawnStarted(index + 1);
    spawns[index](newWorker);
    assert.match(await pending, new RegExp(`dispatched a → ${newWorker}`));
    assert.equal(itemOf("a").assigneeThreadId, newWorker);
    assert.equal(itemOf("a").dispatchStatus, "running");
    assert.equal(raceStore.findByChildThread(newWorker).item.id, "a");
    assert.equal(raceStore.findByChildThread(oldWorker), null);
  };
  await redispatch("thr_n", "idle", "thr_n2");
  await redispatch("thr_n2", "failed", "thr_n3");

  // A todo removed during the spawn is not recreated; the worker is named.
  const dispatchE = run({ action: "dispatch", id: "e" });
  const indexE = spawns.length;
  await spawnStarted(indexE + 1);
  await run({ action: "remove", id: "e" });
  spawns[indexE]("thr_gone");
  assert.match(await dispatchE, /e was removed, so worker thr_gone was started but is not tracked/);
  assert.equal(itemOf("e"), undefined);
  assert.equal(raceStore.findByChildThread("thr_gone"), null);
}

console.log("ok — todo selftest passed");
