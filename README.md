# OpenShowreel

An open-source **Model Context Protocol (MCP) server for Adobe After Effects** — built so an AI assistant can drive After Effects the way a senior motion designer does: not just dropping keyframes, but applying the mechanics that make a showreel feel *premium*.

The goal is simple: let an agent take a brief ("animate this UI walkthrough as a 60fps showreel") and produce buttery-smooth, organically-timed motion using the same techniques pros reach for by hand.

---

## Why this exists

Most automated AE tooling produces stiff, robotic motion — linear paths, simultaneous movement, hard fades. The difference between "a computer animated this" and "a designer animated this" comes down to a handful of repeatable mechanics. OpenShowreel encodes those mechanics as MCP tools so they can be composed programmatically.

---

## Core After Effects mechanics the server models

### 1. 60 FPS + Motion Blur (the baseline for "premium")
Before anything is animated, the composition is set to **60 frames per second** and **motion blur is enabled**. This is the single biggest lever for a "buttery smooth" look — every other technique builds on top of it.

### 2. Morphing shapes
Basic shape layers become expressive when you **uncheck "Constrain Proportions"** on the Size property. That lets the X and Y axes scale independently — e.g. a moving button can appear to physically *push and stretch* a background frame as it travels.

### 3. Expressions over manual keyframes
Instead of hand-animating physics, the server pastes **bounce expressions** (small code snippets) into the stopwatch of properties like Scale or Position. Physics for free, tweakable by parameter.

### 4. Timing offsets — the secret to organic motion
Nested elements should never move *with* their parent — they lag, just slightly. By appending `.valueAtTime(time - 0.1)` to an expression, child elements (an arrow inside a button, an icon inside a card) are mathematically forced to animate a fraction of a second behind their container. This kills the stiff, "everything moves at once" feel.

### 5. Simulated micro-interactions
To make a digital interface feel *tactile*, the server adds a quick **scale-down "button press"** keyframe right before a major on-screen movement begins — the same anticipation beat a real tap would produce.

---

## Essential tools the server wraps

### Parenting & the Pick Whip
Linking properties together: pick-whip an icon's Scale to its container's Scale, or parent text to a moving shape so it tracks along automatically.

### Text Animators + Expression Selectors
Premium text reveals don't just fade in. A **Text Animator** pushes the starting Position off-screen (e.g. Y → -100) with Opacity at 0%, then an **Expression Selector** pulls the text into place per-word or per-character — staggered, not all at once.

### Null Objects for curved paths
Straight linear motion looks unnatural, so paths are drawn with the **pen tool** and curved. But curve data can make an object *drift* when it's meant to be stationary. The fix: snap an **invisible Null Object's anchor point** to the shape's center, parent the shape to the Null, and animate the Null instead — clean movement, no drift.

### The master "camera" finisher
The ultimate polish: create one final **master Null Object**, attach every otherwise-unlinked element to it, apply an expression, and add a very slight rotation (a small positive tilt followed by a negative one). Moving the whole composition together "stitches it all" into a single cinematic move.

---

---

## How it works

OpenShowreel is a Node MCP server. Each tool generates a small ExtendScript snippet and runs it inside a running After Effects via macOS AppleScript (`osascript` → `DoScript`), wrapped in an undo group, with the result handed back through a temp file. No After Effects panel/extension to install — just the CLI server.

```
MCP client (Claude, etc.)  ──stdio──►  openshowreel server  ──osascript/DoScript──►  After Effects
```

### Requirements

- macOS with **Adobe After Effects** installed (auto-detects the newest `Adobe After Effects <year>` under `/Applications`; override with `AE_APP_NAME`).
- After Effects must be **running**, with **Preferences ▸ Scripting & Expressions ▸ "Allow Scripts to Write Files and Access Network"** enabled.
- Node.js ≥ 18.

### Build & run

```bash
npm install
npm run build
npm start          # or: npm run dev   (runs from source via tsx)
npm test           # tool-builder + dry-run tests — no After Effects needed
```

> Set `OPENSHOWREEL_DRY_RUN=1` to make every tool report what it *would* run instead of touching After Effects — handy for testing the wiring.

### Register with an MCP client

```jsonc
{
  "mcpServers": {
    "openshowreel": {
      "command": "node",
      "args": ["/absolute/path/to/openshowreel/dist/index.js"]
      // optional: "env": { "AE_APP_NAME": "Adobe After Effects 2025" }
    }
  }
}
```

---

## Tools

**Composition & inspection**

| Tool | What it does |
| --- | --- |
| `ae_scene_info` | Inspect comps, layers, fps, motion-blur state |
| `ae_setup_comp` | New comp at **60 fps + motion blur** — the premium baseline |
| `ae_save_project` | Save / save-as the `.aep` |

**Layers**

| Tool | What it does |
| --- | --- |
| `ae_create_shape` | Rounded-rect / ellipse shape layer with a fill (button, frame…) |
| `ae_create_solid` | Solid-colour layer (background / colour wash) |
| `ae_create_text` | Plain text layer |
| `ae_import_media` | Import an image / video / audio file, optionally place it in a comp |
| `ae_parent_layer` | Layer-level pick-whip / parenting |
| `ae_link_property` | Pick-whip one property to another via expression |

**Motion mechanics**

| Tool | Maps to the mechanic |
| --- | --- |
| `ae_animate_transform` | Keyframe position / scale / rotation / opacity A→B with an easing preset |
| `ae_set_easing` | Re-ease existing keyframes (linear / easeIn / easeOut / easeInOut / hold) |
| `ae_add_fade` | Opacity fade-in / fade-out at the layer in/out points |
| `ae_morph_size` | Animate Size on one axis only — the "constrain proportions OFF" stretch |
| `ae_add_bounce_expression` | Paste a physics **bounce/overshoot expression** onto scale / position / rotation |
| `ae_add_timing_offset` | `.valueAtTime(time − delay)` — make a child trail its parent for organic motion |
| `ae_add_button_press` | Tactile scale-down dip just before a major move |
| `ae_add_text_reveal` | Text Animator + Expression Selector staggered reveal (per char / word / line) |
| `ae_create_null_path` | Pin a layer to an invisible Null, keyframe a curved, drift-free path |
| `ae_add_master_camera` | One master Null over everything + slight tilt expression — the cinematic stitch |

**Output & escape hatch**

| Tool | What it does |
| --- | --- |
| `ae_render_frame` | Render one frame to a PNG and return the path — so the agent can *see* its work |
| `ae_render_comp` | Render a comp to a video file via the Render Queue |
| `ae_eval` | Run arbitrary ExtendScript |

A typical sequence: `ae_setup_comp` → `ae_create_shape` (button) → `ae_create_shape` (background frame) → `ae_morph_size` (frame stretches as the button moves) → `ae_add_button_press` → `ae_add_bounce_expression` on the button → `ae_create_null_path` to fly it in on a curve → child arrow gets `ae_add_timing_offset` → `ae_add_text_reveal` for the headline → finish with `ae_add_master_camera` → `ae_render_frame` to check it. See [`examples/demo-showreel.mjs`](examples/demo-showreel.mjs) for exactly that, runnable against a live After Effects.

> **Notes:** ExtendScript match-names target current After Effects builds — if a tool errors on another version, `ae_eval` lets you patch around it (PRs welcome). Under the **Advanced 3D renderer** the `.value` getter on shape-layer spatial properties can throw, so OpenShowreel never reads it: pass `from` explicitly to `ae_animate_transform` if you need a non-default start value.

---

## Status

🚧 Early development — the bridge and ~24 tools above are in place and verified live against After Effects 2026. Live behaviour depends on your After Effects version; expect to file/fix the odd match-name.

## License

MIT — see [LICENSE](LICENSE).
