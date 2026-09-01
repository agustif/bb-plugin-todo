import { type BbPluginApi } from "@bb/plugin-sdk";
import { REALTIME_CHANNEL, TOOL_NAME } from "./src/constants.js";
import { applyChildLifecycle } from "./src/dispatch.js";
import { openTodoSummary, snapshotForUi } from "./src/format.js";
import { rpcContract } from "./src/rpc.js";
import { TOOL_DESCRIPTION, todoToolInputSchema } from "./src/schemas.js";
import { openTodoStore } from "./src/store.js";
import { executeTodoTool } from "./src/tool.js";

export { rpcContract } from "./src/rpc.js";

export default async function plugin(bb: BbPluginApi) {
  const store = openTodoStore(bb);

  const publish = (threadId: string) => {
    try {
      bb.realtime.publish(REALTIME_CHANNEL, { threadId, kind: "todos-changed" });
    } catch (error) {
      bb.log.warn(
        `realtime publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  bb.rpc.register(rpcContract, {
    getTodos({ threadId }) {
      const snap = store.get(threadId);
      if (snap.items.length === 0) {
        return { snapshot: null };
      }
      return { snapshot: snapshotForUi(snap) };
    },
    listOpenSummaries() {
      const summaries = [];
      for (const threadId of store.knownThreadIds()) {
        const summary = openTodoSummary(store.get(threadId));
        if (summary) summaries.push(summary);
      }
      return { summaries };
    },
  });

  bb.agents.registerTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    instructions:
      "Use the `todo` tool to plan multi-step work and keep the user-visible checklist current. Prefer nested children + dependsOn for ordering. Assign roles (scout/worker/reviewer) and dispatch child BB threads for parallel work. Keep exactly one parent item in_progress unless children are running. After meaningful progress, call todo again (mark/complete/start/dispatch/report) before ending your turn.",
    presentation: {
      label: {
        pending: "Updating todos",
        completed: "Updated todos",
      },
    },
    parameters: todoToolInputSchema,
    async execute(input, ctx) {
      return executeTodoTool(input, {
        threadId: ctx.threadId,
        projectId: ctx.projectId,
        store,
        publish,
        bb,
      });
    },
  });

  bb.agents.configure(({ threadId }) => {
    const linked = store.findByChildThread(threadId);
    if (linked) {
      return {
        tools: [TOOL_NAME],
        skills: ["todo"],
        instructions: [
          `You are a dispatched worker for parent todo **${linked.item.id}** (${linked.item.content}).`,
          `Parent thread: ${linked.parent.threadId}.`,
          `When finished, call todo with action "report" and status completed|blocked plus a short summary.`,
          `Do not rewrite the parent plan; only report on your assigned item.`,
        ].join(" "),
      };
    }
    return {
      tools: [TOOL_NAME],
      skills: ["todo"],
    };
  });

  bb.agents.contributeInstructions(({ threadId }) => {
    const linked = store.findByChildThread(threadId);
    if (!linked) return null;
    return [
      `Dispatched todo worker for \`${linked.item.id}\`: ${linked.item.content}.`,
      `Report via todo action "report" when done.`,
    ].join(" ");
  });

  const onChildSettle = (
    childThreadId: string,
    outcome: "idle" | "failed" | "deleted" | "archived",
    detail?: string | null,
  ) => {
    try {
      applyChildLifecycle({
        store,
        childThreadId,
        outcome,
        detail,
        publish,
        // Prefer explicit report from the child; idle alone does not complete.
        autoCompleteOnIdle: false,
      });
    } catch (error) {
      bb.log.warn(
        `todo lifecycle ${outcome} for ${childThreadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    onChildSettle(thread.id, "idle", lastAssistantText);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    onChildSettle(thread.id, "failed", error);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    onChildSettle(thread.id, "deleted");
  });
  bb.events.on("thread.archived", ({ thread }) => {
    onChildSettle(thread.id, "archived");
  });

  bb.cli.register({
    name: "todo",
    summary: "Inspect hierarchical thread todos",
    commands: [
      {
        name: "show",
        summary: "Print the todo tree for a thread",
        usage: "bb todo show --thread <thr_…>",
      },
      {
        name: "list-threads",
        summary: "List thread ids that have stored todos",
        usage: "bb todo list-threads",
      },
    ],
    async run(argv) {
      if (argv[0] === "list-threads" || argv.includes("list-threads")) {
        const ids = store.knownThreadIds();
        return {
          exitCode: 0,
          stdout: ids.length
            ? `${ids.join("\n")}\n`
            : "(no todo lists stored)\n",
        };
      }
      const threadFlag = argv.indexOf("--thread");
      const threadId =
        threadFlag >= 0
          ? argv[threadFlag + 1]
          : argv.find((a) => typeof a === "string" && a.startsWith("thr_"));
      if (!threadId) {
        return {
          exitCode: 2,
          stderr:
            "Usage: bb todo show --thread <thr_…>\n       bb todo list-threads\n",
        };
      }
      const snap = store.get(threadId);
      const { formatSnapshotMarkdown } = await import("./src/format.js");
      return {
        exitCode: 0,
        stdout: `${formatSnapshotMarkdown(snap)}\n`,
      };
    },
  });

  bb.log.info("todo plugin ready");
}
