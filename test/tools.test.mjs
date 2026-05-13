// Tool-builder tests — no After Effects required.
// Each tool's ExtendScript body is generated from sample args and sanity-checked,
// then run through the bridge in dry-run mode. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { tools } from "../dist/tools.js";
import { runJsx, isDryRun } from "../dist/bridge.js";

// Representative arguments for every tool (only the required-ish fields; zod fills the rest).
const sampleArgs = {
  ae_scene_info: {},
  ae_eval: { code: "return app.version;" },
  ae_setup_comp: { name: "T", durationSeconds: 5 },
  ae_create_shape: { name: "Box", size: [200, 100] },
  ae_morph_size: { layer: "Box", to: [400, 100] },
  ae_add_bounce_expression: { layer: "Box", property: "scale" },
  ae_add_timing_offset: { layer: "Arrow", property: "position", leaderLayer: "Box" },
  ae_add_button_press: { layer: "Box", atTime: 0.3 },
  ae_parent_layer: { child: "Arrow", parent: "Box" },
  ae_link_property: { layer: "Arrow", property: "scale", targetLayer: "Box" },
  ae_add_text_reveal: { text: "HELLO" },
  ae_create_null_path: { layer: "Box", points: [[100, 100], [500, 300]] },
  ae_add_master_camera: { tiltDegrees: 1.5 },
  ae_save_project: { path: "/tmp/openshowreel-test.aep" },
  ae_render_frame: { time: 0.5, outputPath: "/tmp/openshowreel-test.png" },
  ae_render_comp: { outputPath: "/tmp/openshowreel-test.mov" },
  ae_create_solid: { name: "BG" },
  ae_create_text: { text: "Hello" },
  ae_import_media: { filePath: "/tmp/some-image.png" },
  ae_animate_transform: { layer: "Box", property: "position", to: [960, 540] },
  ae_set_easing: { layer: "Box", property: "position", easing: "easeInOut" },
  ae_add_fade: { layer: "Box", fadeIn: true },
  ae_add_effect: { layer: "Box", effect: "Drop Shadow" },
  ae_set_effect_param: { layer: "Box", effect: "Drop Shadow", param: "Opacity", value: 50 },
  ae_add_drop_shadow: { layer: "Box" },
  ae_add_glow: { layer: "Box" },
  ae_add_gaussian_blur: { layer: "Box", blurriness: 12 },
  ae_add_adjustment_layer: { name: "Grade" },
  ae_set_blend_mode: { layer: "Box", mode: "screen" },
  ae_add_mask: { layer: "Box", shape: "rect", bounds: [0, 0, 200, 100] },
  ae_animate_mask: { layer: "Box", mask: 1, property: "expansion", from: -100, to: 0 },
  ae_add_trim_path: { layer: "Box", drawOn: true },
  ae_set_track_matte: { layer: "Box", type: "alpha" },
  ae_set_layer_3d: { layer: "Box", enabled: true },
  ae_add_camera: { name: "Cam" },
  ae_animate_camera: { positionFrom: [960, 540, -1800], positionTo: [960, 540, -900] },
  ae_create_precomp: { layers: ["Box"], name: "Scene 1" },
  ae_add_layer_to_comp: { source: "Scene 1" },
  ae_add_markers: { times: [0.5, 1.0, 1.5], labels: ["a", "b", "c"] },
  ae_enable_time_remap: { layer: "Clip" },
  ae_animate_time_remap: { layer: "Clip", keys: [{ at: 0, source: 0 }, { at: 2, source: 1 }] },
  ae_add_device_frame: { layer: "Box", style: "browser" },
  ae_render_frames: { times: [0.5, 1.0] },
};

test("every tool has a sample-args entry", () => {
  for (const tool of tools) assert.ok(tool.name in sampleArgs, `missing sampleArgs for ${tool.name}`);
});

test("tool definitions are well-formed", () => {
  const seen = new Set();
  for (const tool of tools) {
    assert.match(tool.name, /^ae_[a-z0-9_]+$/, `bad tool name: ${tool.name}`);
    assert.ok(!seen.has(tool.name), `duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
    assert.ok(tool.description && tool.description.length > 10, `${tool.name}: weak description`);
    assert.equal(typeof tool.schema, "object");
    assert.equal(typeof tool.build, "function");
  }
});

for (const tool of tools) {
  test(`${tool.name}: builds valid-looking ExtendScript`, () => {
    const parsed = z.object(tool.schema).parse(sampleArgs[tool.name]);
    const body = tool.build(parsed);
    assert.equal(typeof body, "string");
    assert.ok(body.trim().length > 0, "empty body");
    // template interpolation gaps would leave these literally in the output
    assert.ok(!body.includes("[object Object]"), `'[object Object]' leaked into ${tool.name} body`);
    assert.ok(!body.includes("${"), `unresolved template literal in ${tool.name} body`);
    // every non-trivial tool touches the AE DOM somehow
    if (tool.name !== "ae_eval") assert.match(body, /\b(app|OSR|comp|RQItemStatus)\b/);
  });
}

test("runJsx honours dry-run mode", async () => {
  assert.equal(isDryRun(), true, "set OPENSHOWREEL_DRY_RUN=1 to run this suite");
  const out = await runJsx("var x = 1;\nreturn x;");
  assert.match(out, /dry-run/);
});

test("a tool runs end-to-end through the bridge (dry-run)", async () => {
  const setup = tools.find((t) => t.name === "ae_setup_comp");
  const parsed = z.object(setup.schema).parse(sampleArgs.ae_setup_comp);
  const out = await runJsx(setup.build(parsed), setup.runOptions);
  assert.match(out, /dry-run/);
});
