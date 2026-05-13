// Builds a small demo composition end-to-end through the OpenShowreel tools.
// Usage:  npm run build  &&  node examples/demo-showreel.mjs
// Requires After Effects to be open with "Allow Scripts to Write Files and Access Network" enabled.
import { z } from "zod";
import { runJsx } from "../dist/bridge.js";
import { tools } from "../dist/tools.js";

const byName = Object.fromEntries(tools.map((t) => [t.name, { build: t.build, parser: z.object(t.schema) }]));

async function call(name, args = {}) {
  const tool = byName[name];
  if (!tool) throw new Error(`unknown tool ${name}`);
  process.stdout.write(`${name} … `);
  try {
    const out = await runJsx(tool.build(tool.parser.parse(args)));
    console.log(`ok — ${out}`);
  } catch (err) {
    console.log(`FAILED — ${err.message ?? err}`);
  }
}

await call("ae_setup_comp", { name: "OpenShowreel Demo", durationSeconds: 8 });
await call("ae_create_shape", { name: "Frame", size: [900, 380], position: [960, 540], color: [0.12, 0.13, 0.16], roundness: 28 });
await call("ae_create_shape", { name: "Button", size: [320, 110], position: [700, 540], color: [0.16, 0.5, 1], roundness: 18 });
await call("ae_create_shape", { name: "Arrow", size: [40, 12], position: [820, 540], color: [1, 1, 1] });
await call("ae_parent_layer", { child: "Arrow", parent: "Button" });
await call("ae_morph_size", { layer: "Frame", to: [1300, 380], startTime: 0.3, endTime: 1.0 });
await call("ae_add_button_press", { layer: "Button", atTime: 0.3 });
await call("ae_add_bounce_expression", { layer: "Button", property: "scale" });
await call("ae_create_null_path", { layer: "Button", points: [[700, 540], [1100, 360], [1500, 540]], startTime: 0.3, endTime: 1.4 });
await call("ae_add_timing_offset", { layer: "Arrow", property: "position", leaderLayer: "Button", delaySeconds: 0.08 });
await call("ae_link_property", { layer: "Arrow", property: "opacity", targetLayer: "Button", targetProperty: "opacity" });
await call("ae_add_text_reveal", { text: "OPEN SHOWREEL", fontSize: 140, position: [960, 220], staggerSeconds: 0.9 });
await call("ae_add_master_camera", { tiltDegrees: 1.5 });
await call("ae_scene_info");
