# bb-plugin-todo

Hierarchical session todos for [BB](https://github.com/get-bb/bb) agents —
nested sub-tasks at any depth, `dependsOn` / `requires`, multi-agent dispatch,
and a live composer checklist.

Pairs with **[bb-plugin-session-goal](https://github.com/agustif/bb-plugin-session-goal)**
(sticky **why**) and **[bb-plugin-notify](https://github.com/agustif/bb-plugin-notify)**
(worker completion pings).

## What you get

- **One agent tool** named `todo` for list / set / add / update / start /
  complete / cancel / remove / clear / move / depend / mark / assign /
  dispatch / link / report
- **Nested trees** via `children` or `parentId` (any depth)
- **Hard dependencies** (`dependsOn` / `blockedBy`) that auto-surface blocked
  vs ready work
- **Soft prerequisites** (`requires`: env, approval, docs, …)
- **Multi-agent** — assign `scout` / `worker` / `reviewer`, dispatch child
  threads or `link` threads that already exist, children `report` back
- **Composer banner** with progress + expandable tree (and a header badge)
- **Rich tool feedback** so the model always sees the tree, blockers, and
  “ready next” without guessing ids
- **Skill** that teaches when and how to use the tool
- **CLI**: `bb todo show --thread thr_…`, `bb todo list-threads`

## Install

Requires **BB ≥ 0.36** and plugin SDK **^0.4.1**.

### From Git (recommended)

```sh
bb plugin install git:https://github.com/agustif/bb-plugin-todo.git@main
bb plugin reload todo
```

Pin a release:

```sh
bb plugin install git:https://github.com/agustif/bb-plugin-todo.git@v0.1.0
```

### From npm (when published)

```sh
bb plugin install npm:bb-plugin-todo@^0.1.0
bb plugin reload todo
```

### From a local checkout

```sh
git clone https://github.com/agustif/bb-plugin-todo.git
cd bb-plugin-todo
npm install
bb plugin install . --yes
bb plugin reload todo
```

## Example tool call

```json
{
  "action": "set",
  "items": [
    {
      "id": "api",
      "content": "Ship API",
      "children": [
        { "id": "api.schema", "content": "Define schema" },
        {
          "id": "api.routes",
          "content": "Add routes",
          "dependsOn": ["api.schema"]
        }
      ]
    }
  ]
}
```

## Notes

- State is stored per thread in the plugin SQLite database.
- The banner hides when every item is completed/cancelled.
- Prefer exactly one `in_progress` item at a time.
- Goal vs todo: use **session-goal** for the sticky why; this plugin is the path.

## Develop

```sh
npm install
npm test
bb plugin types
bb plugin build
bb plugin install . --yes
bb plugin dev
```

## Publish (maintainers)

```sh
npm test && bb plugin build
git tag v0.1.0 && git push origin main --tags
gh release create v0.1.0 --generate-notes
# optional: npm login && npm publish --access public
```

## License

[MIT](./LICENSE)
