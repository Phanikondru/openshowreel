// Builds a small demo composition end-to-end through the OpenShowreel tools, then
// renders a couple of frames so you can see the result.
// Usage:  npm run build  &&  node examples/demo-showreel.mjs
// Requires After Effects to be open with "Allow Scripts to Write Files and Access Network" enabled.
import { z } from "zod";
import { runJsx } from "../dist/bridge.js";
import { tools } from "../dist/tools.js";

const byName = Object.fromEntries(tools.map((t) => [t.name, { build: t.build, runOptions: t.runOptions, parser: z.object(t.schema) }]));

async function call(name, args = {}) {
  const tool = byName[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  process.stdout.write(`${name} … `);
  try {
    const out = await runJsx(tool.build(tool.parser.parse(args)), tool.runOptions);
    console.log(`ok — ${out}`);
  } catch (err) {
    console.log(`FAILED — ${err.message ?? err}`);
  }
}

const COMP = "OpenShowreel Demo";

await call("ae_setup_comp", { name: COMP, durationSeconds: 6 });
await call("ae_create_solid", { name: "BG", color: [0.04, 0.05, 0.07] });

await call("ae_create_shape", { name: "Frame", size: [820, 360], position: [960, 540], color: [0.11, 0.12, 0.15], roundness: 26 });
await call("ae_morph_size", { layer: "Frame", to: [1240, 360], startTime: 0.3, endTime: 1.0 });

await call("ae_create_shape", { name: "Button", size: [300, 100], position: [640, 540], color: [0.16, 0.5, 1], roundness: 16 });
await call("ae_add_button_press", { layer: "Button", atTime: 0.3 });
await call("ae_animate_transform", { layer: "Button", property: "position", from: [640, 540], to: [1180, 540], startTime: 0.3, endTime: 1.1, easing: "easeInOut" });
await call("ae_animate_transform", { layer: "Button", property: "scale", from: 70, to: 100, startTime: 0.3, endTime: 0.7, easing: "easeOut" });
await call("ae_add_bounce_expression", { layer: "Button", property: "position", amplitude: 0.06 });

await call("ae_create_shape", { name: "Arrow", size: [44, 14], position: [760, 540], color: [1, 1, 1] });
await call("ae_parent_layer", { child: "Arrow", parent: "Button" });
await call("ae_add_timing_offset", { layer: "Arrow", property: "position", leaderLayer: "Button", delaySeconds: 0.08 });

await call("ae_create_shape", { name: "Dot", kind: "ellipse", size: [70, 70], position: [200, 180], color: [1, 0.45, 0.2] });
await call("ae_create_null_path", { layer: "Dot", points: [[200, 180], [700, 360], [1300, 180], [1720, 420]], startTime: 0.2, endTime: 1.6 });

await call("ae_create_text", { text: "OPEN SHOWREEL", fontSize: 120, color: [1, 1, 1], position: [960, 250] });
await call("ae_add_fade", { layer: "OPEN SHOWREEL", fadeIn: true, durationSeconds: 0.4 });
await call("ae_add_text_reveal", { text: "after effects, on autopilot", fontSize: 52, color: [0.55, 0.6, 0.7], position: [960, 800], staggerSeconds: 0.9, startTime: 0.8 });

await call("ae_add_master_camera", { tiltDegrees: 1.2 });

await call("ae_render_frame", { comp: COMP, time: 0.6, outputPath: "/tmp/openshowreel-demo-0.6s.png" });
await call("ae_render_frame", { comp: COMP, time: 1.4, outputPath: "/tmp/openshowreel-demo-1.4s.png" });
await call("ae_render_frame", { comp: COMP, time: 3.0, outputPath: "/tmp/openshowreel-demo-3.0s.png" });

await call("ae_scene_info");
