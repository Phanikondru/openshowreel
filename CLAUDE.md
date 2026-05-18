# Working in this repo

This MCP drives After Effects from Claude. The bridge writes ExtendScript to a temp file and shoves it through AppleScript → AE. Most of the friction in past sessions came from forgetting how ExtendScript and the bridge differ from a modern JS environment. Read these before editing.

## ExtendScript is ES3

Adobe's scripting engine is locked to ES3-ish syntax. Anything modern will throw `Illegal use of reserved word` at parse time — *before* your script runs, so undo groups don't save you.

**Don't use:**
- `let`, `const` → use `var`
- arrow functions `() =>` → use `function () {}`
- template literals `` `${x}` `` → use string concat `"x=" + x`
- destructuring `{a, b} = obj` → use `var a = obj.a; var b = obj.b;`
- `for…of`, `for…in` over Arrays → use indexed loops
- shorthand object syntax `{a, b}` → use `{a: a, b: b}`
- default parameters → check `arguments.length` or `typeof x === "undefined"`
- spread `...args` → use `arguments` or pass arrays
- `class` → use prototypes (rarely needed here)

**Reserved-word property access:** `obj.default` parses but errors. Use `obj["default"]`. Same for `class`, `for`, `in`, `delete`, `import`, `export`, `enum`.

## The bridge already wraps each call in an undo group

`src/bridge.ts:130` opens `app.beginUndoGroup("OpenShowreel")` before your script and closes it after. **Don't call `app.executeCommand(16)` (undo) yourself** — it will undo *the previous* OpenShowreel group along with whatever you wanted to revert. This is the single biggest foot-gun in this codebase.

If you need to revert, either:
- let the error path unwind (the bridge does it for you on a thrown exception), or
- call `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.open(new File(path))` to reload from disk.

## Layer timing has a load-bearing order

`layer.startTime = X` shifts `inPoint` and `outPoint` along with it. To change one without the others, use this order:

```jsx
layer.outPoint = comp.duration;   // park out far first so nothing clips
layer.startTime = newStart;        // moves in/out with it
layer.inPoint = newIn;
layer.outPoint = newOut;
```

After `replaceSource()`, the in/out points reset to the new source's full duration. Re-apply them afterwards.

## Keyframe gotchas

- `setValueAtTime` on a property with no keyframes creates the keyframe **and** turns the property time-varying. Before the first key, AE holds the first key's value.
- `setTemporalEaseAtKey(idx, inEase, outEase)` — `inEase`/`outEase` must be arrays whose length matches the property's dimension. Position is 3D for 3D layers → 3 elements. Opacity is 1D → 1 element. **Spatial properties (Position, Anchor Point) take a single scalar temporal ease even though their value is multi-component** — that's why `OSR.applyEase` special-cases them (`bridge.ts:88-90`).
- Removing a keyframe shifts later indices down. Iterate from `numKeys` down to 1 when removing in a loop.

## Result size discipline

Every byte the eval returns becomes context tokens. When inspecting:
- Don't dump full layer property trees (text animators alone have 100+ sub-properties). Pull only what you need.
- For lists, return one short line per item.
- The bridge truncates at 6 KB with a `…<N> bytes truncated` tail, so very long responses are silently cut — assume you've lost data if you see the tail.

## OSR helpers (always available in `ae_eval`)

Injected as `PRELUDE` in `bridge.ts`:

- `OSR.comp(name?)` — comp by name or active comp
- `OSR.layer(comp, refOrIndex)` — layer by name or 1-based index
- `OSR.xform(layer)` — Transform group
- `OSR.tprop(layer, "position"|"scale"|"rotation"|"opacity"|"anchor")` — common transform props
- `OSR.dimsOf(prop)` / `OSR.fill(prop, n)` / `OSR.coerce(prop, val)` — dimensionality helpers
- `OSR.applyEase(prop, mode, influence)` — `linear` | `hold` | `easeIn` | `easeOut` | `easeInOut`
- `OSR.findShapeSize(group)` — recursive shape-size lookup
- (Phase 2 additions: `OSR.layerInfo`, `OSR.setTiming`, `OSR.keysOf`, `OSR.setKeys`, `OSR.shiftLayers`)

## When AE times out

`runJsx` throws "After Effects did not respond" after 180 s. **Partial state may be committed.** Don't blindly retry — first run a tiny `ae_eval` to inspect what the previous script managed to do.

If a script is likely to be slow (many layers, many keyframes), break it into smaller calls *upfront* rather than discovering the timeout the hard way.

## Build & test

```sh
npm test              # builds (tsc) then runs node:test against dist/
npm run typecheck     # type-only
npm run build         # tsc
```

Tests live in `test/tools.test.mjs`. Every tool must have a `sampleArgs` entry and the build output must look like real ExtendScript (touches `app`/`OSR`/`comp`/`RQItemStatus`).

## Project conventions

- Tool names: `ae_<snake_case>` (enforced by tests)
- Use `lit(v)` to JSON-encode args into the script body — never raw interpolation of user-supplied data
- Default render paths land in `tmpdir()` via `tmpOut(prefix, ext)`
- `runOptions.timeoutMs` overrides the bridge timeout for slow tools (renders)
