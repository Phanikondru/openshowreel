import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RunOptions } from "./bridge.js";

export type ShowreelTool = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  build: (args: Record<string, any>) => string;
  /** Per-tool overrides for the AppleScript round-trip (e.g. a longer timeout for renders). */
  runOptions?: RunOptions;
};

/** JSON-encode a JS value into an ExtendScript-safe literal. */
const lit = (v: unknown): string => JSON.stringify(v);

/** A timestamped path under the OS temp dir, for default render outputs. */
const tmpOut = (prefix: string, ext: string): string => join(tmpdir(), `${prefix}-${Date.now()}.${ext}`);

const Vec2 = z.tuple([z.number(), z.number()]);
const Color = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);

const exprPropName = (p: string): string =>
  ({ position: "position", scale: "scale", rotation: "rotation", opacity: "opacity" } as Record<string, string>)[p] ?? p;

const basedOnInt = (b: string): number => ({ characters: 1, words: 3, lines: 4 } as Record<string, number>)[b] ?? 1;

// ---------------------------------------------------------------------------

export const tools: ShowreelTool[] = [
  {
    name: "ae_scene_info",
    description: "Inspect the After Effects project: lists every composition with its size, frame rate, duration, motion-blur state, and layers (with parents). Use this first to see what exists.",
    schema: {},
    build: () => `
var p = app.project;
var out = "Project: " + (p.file ? p.file.name : "(unsaved)") + "\\n";
var ac = p.activeItem;
out += "Active comp: " + (ac && ac instanceof CompItem ? ac.name : "(none)") + "\\n";
for (var i = 1; i <= p.numItems; i++) {
  var it = p.item(i);
  if (!(it instanceof CompItem)) continue;
  out += "\\nComp '" + it.name + "'  " + it.width + "x" + it.height + " @ " + it.frameRate + "fps  dur=" + it.duration.toFixed(2) + "s  motionBlur=" + it.motionBlur + "\\n";
  for (var l = 1; l <= it.numLayers; l++) {
    var L = it.layer(l);
    out += "  [" + l + "] " + L.name + (L.parent ? "  (parent: " + L.parent.name + ")" : "") + "\\n";
  }
}
return out;
`,
  },

  {
    name: "ae_eval",
    description: "Escape hatch: run arbitrary ExtendScript inside After Effects. The code may `return` a value. Helpers under `OSR` are available (OSR.comp, OSR.layer, OSR.tprop, ...). Prefer the specific tools when one fits.",
    schema: { code: z.string().describe("ExtendScript / After Effects scripting code to execute") },
    build: (a) => a.code,
  },

  {
    name: "ae_setup_comp",
    description: "Create a composition configured for premium motion: 60 fps and motion blur ON by default — the baseline 'buttery smooth' look. Returns the comp name.",
    schema: {
      name: z.string().default("Showreel"),
      width: z.number().int().positive().default(1920),
      height: z.number().int().positive().default(1080),
      fps: z.number().positive().default(60).describe("Frame rate. 60 is the recommended showreel default."),
      durationSeconds: z.number().positive().default(12),
      motionBlur: z.boolean().default(true),
      pixelAspect: z.number().positive().default(1),
      makeActive: z.boolean().default(true).describe("Open the new comp in the viewer."),
    },
    build: (a) => `
var A = ${lit(a)};
var c = app.project.items.addComp(A.name, A.width, A.height, A.pixelAspect, A.durationSeconds, A.fps);
c.motionBlur = A.motionBlur;
if (A.makeActive) c.openInViewer();
return "Created comp '" + c.name + "': " + A.width + "x" + A.height + " @ " + A.fps + "fps, " + A.durationSeconds + "s, motion blur " + (A.motionBlur ? "ON" : "off");
`,
  },

  {
    name: "ae_create_shape",
    description: "Add a shape layer (rounded rectangle or ellipse) with a solid fill — e.g. a UI button or a background frame. Position is the layer's transform position; the shape geometry is drawn around it.",
    schema: {
      comp: z.string().optional().describe("Composition name. Defaults to the active comp."),
      name: z.string().default("Shape"),
      kind: z.enum(["rect", "ellipse"]).default("rect"),
      size: Vec2.default([400, 160]).describe("[width, height] of the shape geometry."),
      position: Vec2.optional().describe("Layer position. Defaults to comp center."),
      color: Color.default([0.1, 0.5, 1]).describe("Fill colour as [r, g, b] in 0–1."),
      roundness: z.number().min(0).default(24).describe("Corner radius (rect only)."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var layer = comp.layers.addShape();
layer.name = A.name;
var contents = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").property("ADBE Vectors Group");
var sizeName;
if (A.kind === "ellipse") {
  contents.addProperty("ADBE Vector Shape - Ellipse"); sizeName = "ADBE Vector Ellipse Size";
} else {
  var r = contents.addProperty("ADBE Vector Shape - Rect"); sizeName = "ADBE Vector Rect Size";
  if (A.roundness != null) r.property("ADBE Vector Rect Roundness").setValue(A.roundness);
}
OSR.findShapeSize(contents).setValue([A.size[0], A.size[1]]);
contents.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([A.color[0], A.color[1], A.color[2], 1]);
var pos = (A.position && A.position.length === 2) ? A.position : [comp.width / 2, comp.height / 2];
OSR.tprop(layer, "position").setValue(pos);
return "Created " + A.kind + " '" + layer.name + "' (" + A.size[0] + "x" + A.size[1] + ") at [" + pos[0] + ", " + pos[1] + "]";
`,
  },

  {
    name: "ae_morph_size",
    description: "Animate a shape's Size on one axis independently (the 'constrain proportions OFF' trick) — so a moving button can look like it physically stretches a background frame. Keyframes the layer's first rectangle/ellipse Size between two times.",
    schema: {
      comp: z.string().optional(),
      layer: z.string().describe("Name of the shape layer."),
      to: Vec2.describe("Target [width, height]."),
      from: Vec2.optional().describe("Start [width, height]. Defaults to the current value."),
      startTime: z.number().default(0),
      endTime: z.number().default(0.6),
      ease: z.boolean().default(true),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var sz = OSR.findShapeSize(L.property("ADBE Root Vectors Group"));
if (!sz) throw new Error("No rectangle/ellipse Size found on shape layer '" + L.name + "'");
var from = (A.from && A.from.length === 2) ? A.from : ((function () { try { return sz.value; } catch (e) { return A.to; } })());
sz.setValueAtTime(A.startTime, [from[0], from[1]]);
sz.setValueAtTime(A.endTime, [A.to[0], A.to[1]]);
if (A.ease) OSR.easeKeys(sz);
return "Morphed Size of '" + L.name + "': [" + from[0] + "x" + from[1] + "] -> [" + A.to[0] + "x" + A.to[1] + "] over " + A.startTime + "s-" + A.endTime + "s";
`,
  },

  {
    name: "ae_add_bounce_expression",
    description: "Apply a physics 'bounce' (overshoot) expression to a property (scale, position, or rotation) instead of hand-keying springiness. Once applied, any keyframe you set on that property will overshoot and settle naturally. Based on the well-worn Dan Ebberts overshoot — robust against overflow.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      property: z.enum(["scale", "position", "rotation"]).default("scale"),
      amplitude: z.number().default(0.12).describe("Overshoot scale — multiplies the post-keyframe velocity."),
      frequency: z.number().default(2.5).describe("Oscillations per second."),
      decay: z.number().default(5.0).describe("How quickly the bounce settles (higher = snappier)."),
    },
    build: (a) => {
      const expr =
        `amp = ${a.amplitude ?? 0.12};\n` +
        `freq = ${a.frequency ?? 2.5};\n` +
        `decay = ${a.decay ?? 5.0};\n` +
        `n = 0;\n` +
        `if (numKeys > 0){ n = nearestKey(time).index; if (key(n).time > time) n--; }\n` +
        `if (n > 0){\n` +
        `  t = time - key(n).time;\n` +
        `  v = velocityAtTime(key(n).time - thisComp.frameDuration/10);\n` +
        `  w = freq*Math.PI*2;\n` +
        `  value + v*amp*(Math.sin(t*w)/Math.exp(decay*t)/w);\n` +
        `} else value`;
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
OSR.tprop(L, A.property).expression = ${lit(expr)};
return "Bounce expression on " + A.property + " of '" + L.name + "' (amp=" + A.amplitude + ", freq=" + A.frequency + ", decay=" + A.decay + "). Set keyframes on that property to trigger bounces.";
`;
    },
  },

  {
    name: "ae_add_timing_offset",
    description: "The 'organic motion' trick: make a nested element trail its parent/leader by a fraction of a second using `.valueAtTime(time - delay)`, so things don't move in stiff unison (e.g. an arrow inside a button arrives just after the button).",
    schema: {
      comp: z.string().optional(),
      layer: z.string().describe("The follower layer (the one that should lag)."),
      property: z.enum(["position", "scale", "rotation", "opacity"]).default("position"),
      leaderLayer: z.string().describe("The layer whose matching transform property the follower should copy, delayed."),
      delaySeconds: z.number().default(0.1).describe("How far behind the leader to lag."),
    },
    build: (a) => {
      const expr = `var d = ${a.delaySeconds ?? 0.1};\nthisComp.layer(${lit(a.leaderLayer)}).transform.${exprPropName(a.property ?? "position")}.valueAtTime(time - d)`;
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
OSR.layer(comp, A.leaderLayer); // validate leader exists
OSR.tprop(L, A.property).expression = ${lit(expr)};
return A.property + " of '" + L.name + "' now trails '" + A.leaderLayer + "' by " + A.delaySeconds + "s";
`;
    },
  },

  {
    name: "ae_add_button_press",
    description: "Add a tactile 'button press' micro-interaction: a quick scale-down dip and release just before a major on-screen movement begins. Inserts three Scale keyframes around `atTime` (assumes the layer rests at 100% scale).",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      atTime: z.number().describe("Time (s) at which the press releases / the main move starts."),
      depth: z.number().min(0).max(1).default(0.92).describe("Scale multiplier at the deepest point of the press."),
      durationSeconds: z.number().positive().default(0.09).describe("Total length of the press dip."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var s = OSR.tprop(L, "scale");
var base = OSR.fill(s, 100); // press assumes the layer rests at 100% scale
var t0 = A.atTime - A.durationSeconds, t1 = A.atTime - A.durationSeconds * 0.5, t2 = A.atTime;
s.setValueAtTime(t0, OSR.scaleArray(base, 1));
s.setValueAtTime(t1, OSR.scaleArray(base, A.depth));
s.setValueAtTime(t2, OSR.scaleArray(base, 1));
OSR.easeKeys(s);
return "Added button-press micro-interaction to '" + L.name + "' around " + A.atTime + "s (dip to " + Math.round(A.depth * 100) + "%)";
`,
  },

  {
    name: "ae_parent_layer",
    description: "Parent one layer to another (the layer-level 'pick whip'): the child then inherits the parent's transforms. Pass parent=null to unparent. Visual position is preserved.",
    schema: {
      comp: z.string().optional(),
      child: z.string(),
      parent: z.string().nullable().optional().describe("Parent layer name, or null/empty to unparent."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var c = OSR.layer(comp, A.child);
if (A.parent === null || A.parent === undefined || A.parent === "") { c.setParentWithJump(null); return "Unparented '" + c.name + "'"; }
var p = OSR.layer(comp, A.parent);
c.setParentWithJump(p);
return "'" + c.name + "' parented to '" + p.name + "'";
`,
  },

  {
    name: "ae_link_property",
    description: "Pick-whip one property to another via an expression — e.g. link an icon's Scale to its container's Scale so they always match. Defaults the target property to the same name as the source property.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      property: z.enum(["scale", "position", "rotation", "opacity"]),
      targetLayer: z.string(),
      targetProperty: z.enum(["scale", "position", "rotation", "opacity"]).optional().describe("Defaults to the same as `property`."),
    },
    build: (a) => {
      const tProp = exprPropName(a.targetProperty ?? a.property);
      const expr = `thisComp.layer(${lit(a.targetLayer)}).transform.${tProp}`;
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
OSR.layer(comp, A.targetLayer); // validate target exists
OSR.tprop(L, A.property).expression = ${lit(expr)};
return A.property + " of '" + L.name + "' linked to ${tProp} of '" + A.targetLayer + "'";
`;
    },
  },

  {
    name: "ae_add_text_reveal",
    description: "Word-by-word staggered text reveal — not a flat fade. A Text Animator pushes each unit off-screen (Position offset) at 0% opacity; an Expression Selector pulls one chunk into place at a time. Defaults to words; set chunkSize=2 to reveal two words at a time, or basedOn=characters for a typewriter feel.",
    schema: {
      comp: z.string().optional(),
      text: z.string(),
      name: z.string().optional().describe("Layer name. Defaults to the text content."),
      position: Vec2.optional().describe("Layer position. Defaults to comp center."),
      fontSize: z.number().positive().default(120),
      color: Color.default([1, 1, 1]),
      font: z.string().optional().describe("PostScript font name, e.g. 'Inter-Bold'."),
      basedOn: z.enum(["characters", "words", "lines"]).default("words").describe("Reveal unit. Default 'words' shows one word at a time. Use 'characters' for typewriter, 'lines' for whole lines."),
      chunkSize: z.number().int().positive().default(1).describe("How many units (words/chars/lines) reveal together as one chunk. 2 = two words at a time."),
      offsetY: z.number().default(-60).describe("How far (px) each unit starts above its final spot. Negative = drops down into place."),
      offsetX: z.number().default(0).describe("How far (px) each unit starts to the side of its final spot."),
      startTime: z.number().default(0),
      perChunkSeconds: z.number().positive().default(0.35).describe("How long each chunk takes to reveal AND how long until the next chunk starts. Higher = slower, more visible reveal per word/chunk."),
    },
    build: (a) => {
      const chunkSize = Math.max(1, Math.floor((a.chunkSize ?? 1) as number));
      const perChunk = (a.perChunkSeconds ?? 0.35) as number;
      const startTime = (a.startTime ?? 0) as number;
      // Selector amount 100 = animator fully applied = unit off-screen at 0% opacity;
      // amount 0 = unit at rest (revealed). Each chunk eases 100 -> 0 over `perChunk` seconds,
      // and the chunk after it starts `perChunk` later, so reveals are visibly sequential.
      const expr =
        `size = ${chunkSize};\n` +
        `seg = ${perChunk};\n` +
        `ci = Math.floor((textIndex - 1) / size);\n` +
        `t = time - inPoint - ${startTime} - ci * seg;\n` +
        `clamp(ease(t, 0, seg, 100, 0), 0, 100)`;
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var tl = comp.layers.addText(A.text);
tl.name = A.name || A.text;
var td = tl.property("ADBE Text Properties").property("ADBE Text Document");
var doc = td.value;
doc.fontSize = A.fontSize;
if (A.font) doc.font = A.font;
doc.applyFill = true;
doc.fillColor = [A.color[0], A.color[1], A.color[2]];
try { doc.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (e) {}
td.setValue(doc);
var pos = (A.position && A.position.length === 2) ? A.position : [comp.width / 2, comp.height / 2];
OSR.tprop(tl, "position").setValue(pos);
var anim = tl.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
anim.name = "Reveal";
var props = anim.property("ADBE Text Animator Properties");
props.addProperty("ADBE Text Position 3D").setValue([A.offsetX || 0, A.offsetY, 0]);
props.addProperty("ADBE Text Opacity").setValue(0);
// Remove the default Range Selector that AE attaches when an animator is created —
// otherwise it selects all chars at 100% and combines with our Expression Selector
// (default mode = Add, clamped to 100), making everything permanently invisible.
var sels = anim.property("ADBE Text Selectors");
while (sels.numProperties > 0) { try { sels.property(1).remove(); } catch (e) { break; } }
var es = sels.addProperty("ADBE Text Expressible Selector");
try { es.property("ADBE Text Range Type2").setValue(${basedOnInt(a.basedOn ?? "words")}); } catch (e) {}
es.property("ADBE Text Expressible Amount").expression = ${lit(expr)};
return "Text reveal '" + tl.name + "' created — " + A.basedOn + (A.chunkSize > 1 ? " (chunks of " + A.chunkSize + ")" : "") + ", " + ${perChunk} + "s per chunk, from " + ${startTime} + "s.";
`;
    },
  },

  {
    name: "ae_create_null_path",
    description: "Move a layer along a (optionally curved) path the safe way: create an invisible Null whose pivot the layer is pinned to, parent the layer to the Null, and keyframe the Null's position through your points. When the Null is stationary the layer can't drift — which raw curved keyframes on the layer itself would cause. NOTE: the layer is repositioned to ride the Null, so make points[0] its desired start.",
    schema: {
      comp: z.string().optional(),
      layer: z.string().describe("The layer to move."),
      points: z.array(Vec2).min(2).describe("Path points [[x,y], ...] the layer travels through, in order. points[0] is where the layer starts."),
      startTime: z.number().default(0),
      endTime: z.number().default(2),
      curved: z.boolean().default(true).describe("Auto-bezier the spatial path (vs. straight linear segments)."),
      nullName: z.string().optional().describe("Defaults to '<layer> PATH'."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var nul = comp.layers.addNull(comp.duration);
nul.name = A.nullName || (L.name + " PATH");
nul.label = 9;
OSR.tprop(nul, "anchor").setValue([50, 50]); // null source is 100x100 — centre its pivot
var pts = A.points, t0 = A.startTime, t1 = A.endTime;
var np = OSR.tprop(nul, "position");
np.setValue([pts[0][0], pts[0][1]]);
L.parent = nul;
OSR.tprop(L, "position").setValue([50, 50]); // pin the layer to the null's pivot so it rides the path exactly
for (var i = 0; i < pts.length; i++) {
  var f = (pts.length === 1) ? 0 : (i / (pts.length - 1));
  np.setValueAtTime(t0 + (t1 - t0) * f, [pts[i][0], pts[i][1]]);
}
for (var k = 1; k <= np.numKeys; k++) {
  if (A.curved) { try { np.setSpatialAutoBezierAtKey(k, true); } catch (e) {} }
  else { try { np.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e) {} }
}
return "Null '" + nul.name + "' created, '" + L.name + "' parented to it, and a " + (A.curved ? "curved" : "linear") + " path animated through " + pts.length + " points (" + t0 + "s-" + t1 + "s). Drift-free when the Null is stationary.";
`,
  },

  {
    name: "ae_add_master_camera",
    description: "The cinematic finisher: create one master Null at the comp's centre, parent every otherwise-unparented layer to it, and add a Rotation expression with a very slight tilt (positive easing to negative) so the whole composition moves together as one — 'stitching it all'.",
    schema: {
      comp: z.string().optional(),
      layers: z.array(z.string()).optional().describe("Layer names to attach. Defaults to every top-level layer without a parent (excluding cameras/lights/the master)."),
      tiltDegrees: z.number().default(1.5).describe("Peak tilt magnitude in degrees."),
      driftPx: z.number().default(0).describe("Optional subtle position drift in px across the comp."),
      nullName: z.string().default("MASTER CAMERA"),
    },
    build: (a) => {
      const rotExpr = `amp = ${a.tiltDegrees ?? 1.5};\nease(time, inPoint, outPoint, amp, -amp)`;
      const driftExpr = `amp = ${a.driftPx ?? 0};\n[ value[0] + ease(time, inPoint, outPoint, -amp, amp), value[1] ]`;
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var master = comp.layers.addNull(comp.duration);
master.name = A.nullName; master.label = 11;
OSR.tprop(master, "anchor").setValue([comp.width / 2, comp.height / 2]);
OSR.tprop(master, "position").setValue([comp.width / 2, comp.height / 2]);
master.moveToBeginning();
var only = (A.layers && A.layers.length) ? A.layers : null;
var attached = [];
for (var i = 1; i <= comp.numLayers; i++) {
  var L = comp.layer(i);
  if (L === master) continue;
  if (only) {
    var hit = false;
    for (var j = 0; j < only.length; j++) if (only[j] === L.name) hit = true;
    if (!hit) continue;
  } else {
    if (L.parent) continue;
    if (L instanceof CameraLayer || L instanceof LightLayer) continue;
  }
  L.setParentWithJump(master);
  attached.push(L.name);
}
OSR.tprop(master, "rotation").expression = ${lit(rotExpr)};
if (A.driftPx) OSR.tprop(master, "position").expression = ${lit(driftExpr)};
return "Master camera '" + master.name + "' created; attached " + attached.length + " layer(s): " + attached.join(", ") + ". Whole comp now gets a subtle " + A.tiltDegrees + " deg tilt.";
`;
    },
  },

  // ── Phase 1: output & project lifecycle ───────────────────────────────────

  {
    name: "ae_save_project",
    description: "Save the After Effects project (.aep). Pass a path to save-as / create the file; omit it to save in place (requires the project to already have a file).",
    schema: {
      path: z.string().optional().describe("Absolute .aep path. Omit to save in place."),
    },
    build: (a) => `
var A = ${lit(a)};
if (A.path) { app.project.save(new File(A.path)); }
else { if (!app.project.file) throw new Error("Project has never been saved — pass a path."); app.project.save(); }
return "Saved project: " + app.project.file.fsName;
`,
  },

  {
    name: "ae_render_frame",
    description: "Render a single frame of a composition to a PNG and return its file path — use it to actually look at what you've built. Fast (no Render Queue).",
    schema: {
      comp: z.string().optional(),
      time: z.number().default(0).describe("Time in seconds of the frame to capture."),
      outputPath: z.string().optional().describe("Absolute .png path. Defaults to a timestamped file in the OS temp dir."),
    },
    build: (a) => {
      const out = a.outputPath ?? tmpOut("openshowreel-frame", "png");
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var dst = ${lit(out)};
if (typeof comp.saveFrameToPng !== "function") throw new Error("This After Effects version has no saveFrameToPng — use the Render Queue (ae_render_comp) instead.");
comp.saveFrameToPng(A.time, new File(dst));
return "Saved frame at " + A.time + "s of '" + comp.name + "' to " + dst;
`;
    },
  },

  {
    name: "ae_render_comp",
    description: "Render a composition to a video file via the Render Queue. Blocking — can take a while. Returns the output path on success.",
    schema: {
      comp: z.string().optional(),
      outputPath: z.string().describe("Absolute output path, e.g. /tmp/showreel.mov or .mp4."),
      template: z.string().optional().describe("Output Module template name to apply (varies by install, e.g. 'H.264 - Match Render Settings - 15 Mbps'). Optional — falls back to the install default."),
      renderSettingsTemplate: z.string().optional().describe("Render Settings template name. Optional."),
    },
    runOptions: { timeoutMs: 30 * 60_000 },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var rq = app.project.renderQueue;
var item = rq.items.add(comp);
if (A.renderSettingsTemplate) { try { item.applyTemplate(A.renderSettingsTemplate); } catch (e) {} }
var om = item.outputModule(1);
if (A.template) { try { om.applyTemplate(A.template); } catch (e) {} }
om.file = new File(A.outputPath);
item.render = true;
rq.render();
if (item.status === RQItemStatus.DONE) return "Rendered '" + comp.name + "' to " + om.file.fsName;
throw new Error("Render finished with status " + item.status + " for '" + comp.name + "'");
`,
  },

  // ── Phase 2: core layer primitives ────────────────────────────────────────

  {
    name: "ae_create_solid",
    description: "Add a solid-colour layer — handy as a background or a colour wash. Defaults to comp size.",
    schema: {
      comp: z.string().optional(),
      name: z.string().default("Solid"),
      color: Color.default([0, 0, 0]),
      width: z.number().int().positive().optional().describe("Defaults to comp width."),
      height: z.number().int().positive().optional().describe("Defaults to comp height."),
      position: Vec2.optional().describe("Defaults to comp center."),
      opacity: z.number().min(0).max(100).default(100),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var w = A.width || comp.width, h = A.height || comp.height;
var L = comp.layers.addSolid([A.color[0], A.color[1], A.color[2]], A.name, w, h, comp.pixelAspect);
if (A.position && A.position.length === 2) OSR.tprop(L, "position").setValue(A.position);
if (A.opacity != null) OSR.tprop(L, "opacity").setValue(A.opacity);
return "Created solid '" + L.name + "' " + w + "x" + h;
`,
  },

  {
    name: "ae_create_text",
    description: "Add a plain text layer (no animator). For an animated reveal use ae_add_text_reveal instead.",
    schema: {
      comp: z.string().optional(),
      text: z.string(),
      name: z.string().optional().describe("Defaults to the text content."),
      position: Vec2.optional().describe("Defaults to comp center."),
      fontSize: z.number().positive().default(100),
      color: Color.default([1, 1, 1]),
      font: z.string().optional().describe("PostScript font name, e.g. 'Inter-Bold'."),
      justification: z.enum(["left", "center", "right"]).default("center"),
    },
    build: (a) => {
      const just = { left: "LEFT_JUSTIFY", center: "CENTER_JUSTIFY", right: "RIGHT_JUSTIFY" }[(a.justification ?? "center") as "left" | "center" | "right"];
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = comp.layers.addText(A.text);
L.name = A.name || A.text;
var td = L.property("ADBE Text Properties").property("ADBE Text Document");
var doc = td.value;
doc.fontSize = A.fontSize;
if (A.font) doc.font = A.font;
doc.applyFill = true;
doc.fillColor = [A.color[0], A.color[1], A.color[2]];
try { doc.justification = ParagraphJustification.${just}; } catch (e) {}
td.setValue(doc);
var pos = (A.position && A.position.length === 2) ? A.position : [comp.width / 2, comp.height / 2];
OSR.tprop(L, "position").setValue(pos);
return "Created text layer '" + L.name + "' at [" + pos[0] + ", " + pos[1] + "]";
`;
    },
  },

  {
    name: "ae_import_media",
    description: "Import an image / video / audio file into the project, and optionally place it in a composition.",
    schema: {
      filePath: z.string().describe("Absolute path to the media file."),
      addToComp: z.boolean().default(true),
      comp: z.string().optional().describe("Target comp when addToComp is true. Defaults to the active comp."),
      position: Vec2.optional().describe("Layer position when added. Defaults to comp center."),
      scaleToFit: z.boolean().default(false).describe("Scale the layer to cover the comp frame."),
    },
    build: (a) => `
var A = ${lit(a)};
var f = new File(A.filePath);
if (!f.exists) throw new Error("File not found: " + A.filePath);
var item = app.project.importFile(new ImportOptions(f));
var msg = "Imported '" + item.name + "'";
if (A.addToComp) {
  var comp = OSR.comp(A.comp);
  var L = comp.layers.add(item);
  if (A.position && A.position.length === 2) OSR.tprop(L, "position").setValue(A.position);
  if (A.scaleToFit && item.width && item.height) {
    var s = Math.max(comp.width / item.width, comp.height / item.height) * 100;
    OSR.tprop(L, "scale").setValue([s, s]);
  }
  msg += " → comp '" + comp.name + "' as layer '" + L.name + "'";
}
return msg;
`,
  },

  // ── Phase 3: animation primitives & easing ────────────────────────────────

  {
    name: "ae_animate_transform",
    description: "Keyframe a transform property (position / scale / rotation / opacity) from one value to another between two times, with an easing preset. The general-purpose 'move this from A to B smoothly' tool. If `from` is omitted it defaults to a sensible rest value (position→comp centre, scale→100%, rotation→0°, opacity→0%) — pass it explicitly to start somewhere else.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      property: z.enum(["position", "scale", "rotation", "opacity"]),
      to: z.union([z.number(), z.array(z.number())]).describe("Target value. Number for rotation/opacity (or to set all scale axes uniformly); [x,y] for position/scale."),
      from: z.union([z.number(), z.array(z.number())]).optional().describe("Start value. Defaults to a rest value for the property."),
      startTime: z.number().default(0),
      endTime: z.number().default(1),
      easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).default("easeInOut"),
      influence: z.number().min(0.1).max(100).default(33).describe("Ease influence % (Easy Ease ≈ 33)."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var prop = OSR.tprop(L, A.property);
function restValue() {
  if (A.property === "position") return OSR.coerce(prop, [comp.width / 2, comp.height / 2]);
  if (A.property === "scale") return OSR.fill(prop, 100);
  if (A.property === "opacity") return 0;
  return 0; // rotation
}
var from = (A.from === undefined || A.from === null) ? restValue() : OSR.coerce(prop, A.from);
var to = OSR.coerce(prop, A.to);
prop.setValueAtTime(A.startTime, from);
prop.setValueAtTime(A.endTime, to);
OSR.applyEase(prop, A.easing, A.influence);
function fmt(v) { return (v instanceof Array) ? "[" + v.join(", ") + "]" : String(v); }
return "Animated " + A.property + " of '" + L.name + "': " + fmt(from) + " -> " + fmt(to) + " over " + A.startTime + "s-" + A.endTime + "s (" + A.easing + ")";
`,
  },

  {
    name: "ae_set_easing",
    description: "Re-ease the existing keyframes of a transform property with a preset (linear / easeIn / easeOut / easeInOut / hold). Use after manual keyframing, or to dial in the feel of an already-animated property.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      property: z.enum(["position", "scale", "rotation", "opacity"]),
      easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).default("easeInOut"),
      influence: z.number().min(0.1).max(100).default(33),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var prop = OSR.tprop(L, A.property);
if (prop.numKeys < 1) throw new Error(A.property + " of '" + L.name + "' has no keyframes to ease.");
OSR.applyEase(prop, A.easing, A.influence);
return "Re-eased " + prop.numKeys + " keyframe(s) of " + A.property + " on '" + L.name + "' (" + A.easing + ")";
`,
  },

  {
    name: "ae_add_fade",
    description: "Add an opacity fade-in and/or fade-out at the layer's in/out points, eased.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      fadeIn: z.boolean().default(true),
      fadeOut: z.boolean().default(false),
      durationSeconds: z.number().positive().default(0.4),
    },
    build: (a) => `
var A = ${lit(a)};
if (!A.fadeIn && !A.fadeOut) throw new Error("Enable fadeIn and/or fadeOut.");
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var op = OSR.tprop(L, "opacity");
var d = A.durationSeconds, inP = L.inPoint, outP = L.outPoint;
if (A.fadeIn) { op.setValueAtTime(inP, 0); op.setValueAtTime(inP + d, 100); }
if (A.fadeOut) { op.setValueAtTime(Math.max(inP, outP - d), 100); op.setValueAtTime(outP, 0); }
OSR.applyEase(op, "easeInOut", 33);
return "Fade on '" + L.name + "'" + (A.fadeIn ? " in" : "") + (A.fadeOut ? " out" : "") + " (" + d + "s)";
`,
  },

  // ── Phase 5: effects, adjustment layers, blend modes ──────────────────────

  {
    name: "ae_add_effect",
    description: "Add an effect to a layer by name or match-name (e.g. 'Drop Shadow', 'Gaussian Blur', 'CC Light Sweep', or a match-name like 'ADBE Drop Shadow'). Returns the effect's parameter names so you know what ae_set_effect_param can target.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      effect: z.string().describe("Effect display name or match-name."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var fx = L.property("ADBE Effect Parade");
if (!fx.canAddProperty(A.effect)) throw new Error("Effect not available: '" + A.effect + "'");
var e = fx.addProperty(A.effect);
var params = [];
for (var i = 1; i <= e.numProperties; i++) { var p = e.property(i); params.push(p.name + (p.matchName ? " [" + p.matchName + "]" : "")); }
return "Added effect '" + e.name + "' to '" + L.name + "'. Params: " + params.join(" | ");
`,
  },

  {
    name: "ae_set_effect_param",
    description: "Set a parameter of an effect on a layer (or keyframe it at a time). Reference the effect and parameter by name or 1-based index.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      effect: z.union([z.string(), z.number().int().positive()]).describe("Effect name or index on the layer."),
      param: z.union([z.string(), z.number().int().positive()]).describe("Parameter name or index within the effect."),
      value: z.union([z.number(), z.boolean(), z.array(z.number())]).describe("New value. Number/boolean for sliders/checkboxes/angles; [x,y] for points; [r,g,b] or [r,g,b,a] for colours."),
      atTime: z.number().optional().describe("If given, set as a keyframe at this time instead of a static value."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var e = L.property("ADBE Effect Parade").property(A.effect);
if (!e) throw new Error("Effect not found on '" + L.name + "': " + A.effect);
var p = e.property(A.param);
if (!p) throw new Error("Parameter not found on effect '" + e.name + "': " + A.param);
var v = A.value;
if (v instanceof Array && v.length === 3 && p.propertyValueType === PropertyValueType.COLOR) v = [v[0], v[1], v[2], 1];
if (A.atTime !== undefined && A.atTime !== null) p.setValueAtTime(A.atTime, v);
else p.setValue(v);
return "Set " + e.name + " > " + p.name + " = " + (v instanceof Array ? "[" + v.join(", ") + "]" : v) + " on '" + L.name + "'" + (A.atTime != null ? " @" + A.atTime + "s" : "");
`,
  },

  {
    name: "ae_add_drop_shadow",
    description: "Convenience: add a soft Drop Shadow to a layer with sensible defaults (you can fine-tune via ae_set_effect_param afterwards).",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      opacity: z.number().min(0).max(100).default(45).describe("Shadow opacity %."),
      softness: z.number().min(0).default(40).describe("Blur radius (px)."),
      distance: z.number().min(0).default(16).describe("Offset distance (px)."),
      direction: z.number().default(135).describe("Direction in degrees."),
      color: Color.default([0, 0, 0]),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var e = L.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
try { e.property("ADBE Drop Shadow-0001").setValue([A.color[0], A.color[1], A.color[2], 1]); } catch (x) {}
try { e.property("ADBE Drop Shadow-0002").setValue(A.opacity * 2.55); } catch (x) {}
try { e.property("ADBE Drop Shadow-0003").setValue(A.direction); } catch (x) {}
try { e.property("ADBE Drop Shadow-0004").setValue(A.distance); } catch (x) {}
try { e.property("ADBE Drop Shadow-0005").setValue(A.softness); } catch (x) {}
return "Added '" + e.name + "' (Drop Shadow) to '" + L.name + "' — opacity " + A.opacity + "%, softness " + A.softness + "px, distance " + A.distance + "px. Reference it as '" + e.name + "' in ae_set_effect_param.";
`,
  },

  {
    name: "ae_add_glow",
    description: "Convenience: add a Glow effect to a layer (great for UI highlights / logos). Tune further with ae_set_effect_param.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      threshold: z.number().min(0).max(100).default(50).describe("Glow threshold %."),
      radius: z.number().min(0).default(30).describe("Glow radius."),
      intensity: z.number().min(0).default(1.5).describe("Glow intensity."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var e = L.property("ADBE Effect Parade").addProperty("ADBE Glo2");
try { e.property("ADBE Glo2-0002").setValue(A.threshold); } catch (x) {}
try { e.property("ADBE Glo2-0003").setValue(A.radius); } catch (x) {}
try { e.property("ADBE Glo2-0004").setValue(A.intensity); } catch (x) {}
return "Added '" + e.name + "' (Glow) to '" + L.name + "' — threshold " + A.threshold + "%, radius " + A.radius + ", intensity " + A.intensity + ". Reference it as '" + e.name + "' in ae_set_effect_param.";
`,
  },

  {
    name: "ae_add_gaussian_blur",
    description: "Convenience: add Gaussian Blur to a layer (use a small amount for depth, or keyframe it for a focus pull / transition).",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      blurriness: z.number().min(0).default(20),
      repeatEdgePixels: z.boolean().default(true),
      atTime: z.number().optional().describe("If given, keyframe the blurriness at this time instead of a static value."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var e = L.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
var amt = e.property("ADBE Gaussian Blur 2-0001");
if (A.atTime !== undefined && A.atTime !== null) amt.setValueAtTime(A.atTime, A.blurriness); else amt.setValue(A.blurriness);
try { e.property("ADBE Gaussian Blur 2-0003").setValue(A.repeatEdgePixels ? 1 : 0); } catch (x) {}
return "Added '" + e.name + "' (Gaussian Blur) to '" + L.name + "' = " + A.blurriness + (A.atTime != null ? " @" + A.atTime + "s" : "") + ". Reference it as '" + e.name + "' in ae_set_effect_param.";
`,
  },

  {
    name: "ae_add_adjustment_layer",
    description: "Add a full-frame adjustment layer at the top of the stack — apply effects to it (e.g. via ae_add_effect / ae_add_glow) to grade or treat the whole comp at once.",
    schema: {
      comp: z.string().optional(),
      name: z.string().default("Adjustment"),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = comp.layers.addSolid([1, 1, 1], A.name, comp.width, comp.height, comp.pixelAspect);
L.adjustmentLayer = true;
L.moveToBeginning();
return "Added adjustment layer '" + L.name + "' at the top of '" + comp.name + "'";
`,
  },

  {
    name: "ae_set_blend_mode",
    description: "Set a layer's blending mode (normal, multiply, screen, overlay, add, lighten, darken, soft-light, hard-light, color-dodge, color-burn, difference, luminosity).",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      mode: z.enum([
        "normal", "multiply", "screen", "overlay", "add", "lighten", "darken",
        "soft_light", "hard_light", "color_dodge", "color_burn", "difference", "luminosity",
      ]).default("normal"),
    },
    build: (a) => {
      const map: Record<string, string> = {
        normal: "NORMAL", multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", add: "ADD",
        lighten: "LIGHTEN", darken: "DARKEN", soft_light: "SOFT_LIGHT", hard_light: "HARD_LIGHT",
        color_dodge: "CLASSIC_COLOR_DODGE", color_burn: "CLASSIC_COLOR_BURN", difference: "DIFFERENCE", luminosity: "LUMINOSITY",
      };
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
L.blendingMode = BlendingMode.${map[(a.mode ?? "normal") as string]};
return "Blend mode of '" + L.name + "' set to ${a.mode ?? "normal"}";
`;
    },
  },

  // ── Phase 6: masks, trim paths, track mattes, 3D & camera ─────────────────

  {
    name: "ae_add_mask",
    description: "Add a rectangular or elliptical mask to a layer. Bounds are in the layer's own pixel space ([left, top, right, bottom]); omit them to mask the whole layer. Combine with ae_animate_mask for wipe-style reveals.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      shape: z.enum(["rect", "ellipse"]).default("rect"),
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("[left, top, right, bottom] in layer space. Defaults to the whole layer."),
      feather: z.number().min(0).default(0),
      expansion: z.number().default(0).describe("Mask expansion (px). Negative shrinks."),
      mode: z.enum(["add", "subtract", "intersect", "none"]).default("add"),
      inverted: z.boolean().default(false),
      name: z.string().optional(),
    },
    build: (a) => {
      const modeMap: Record<string, string> = { add: "ADD", subtract: "SUBTRACT", intersect: "INTERSECT", none: "NONE" };
      const maskMode = `MaskMode.${modeMap[(a.mode ?? "add") as string]}`;
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var b = (A.bounds && A.bounds.length === 4) ? A.bounds : [0, 0, (L.width || comp.width), (L.height || comp.height)];
var l = b[0], t = b[1], r = b[2], bt = b[3];
var s = new Shape();
if (A.shape === "ellipse") {
  var cx = (l + r) / 2, cy = (t + bt) / 2, rx = (r - l) / 2, ry = (bt - t) / 2, k = 0.5522847498;
  s.vertices = [[cx, t], [r, cy], [cx, bt], [l, cy]];
  s.inTangents = [[-rx * k, 0], [0, -ry * k], [rx * k, 0], [0, ry * k]];
  s.outTangents = [[rx * k, 0], [0, ry * k], [-rx * k, 0], [0, -ry * k]];
} else {
  s.vertices = [[l, t], [r, t], [r, bt], [l, bt]];
}
s.closed = true;
var m = L.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
if (A.name) m.name = A.name;
m.maskMode = ${maskMode};
m.property("ADBE Mask Shape").setValue(s);
if (A.feather) m.property("ADBE Mask Feather").setValue([A.feather, A.feather]);
if (A.expansion) m.property("ADBE Mask Offset").setValue(A.expansion);
m.inverted = !!A.inverted;
return "Added " + A.shape + " mask '" + m.name + "' to '" + L.name + "' (mode ${a.mode ?? "add"}" + (A.inverted ? ", inverted" : "") + ")";
`;
    },
  },

  {
    name: "ae_animate_mask",
    description: "Keyframe a mask's expansion or feather between two values — e.g. animate expansion from a small value to large to wipe a layer on/off.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      mask: z.union([z.string(), z.number().int().positive()]).default(1).describe("Mask name or 1-based index on the layer."),
      property: z.enum(["expansion", "feather"]).default("expansion"),
      from: z.number(),
      to: z.number(),
      startTime: z.number().default(0),
      endTime: z.number().default(1),
      easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).default("easeInOut"),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var m = L.property("ADBE Mask Parade").property(A.mask);
if (!m) throw new Error("Mask not found on '" + L.name + "': " + A.mask);
var p = (A.property === "feather") ? m.property("ADBE Mask Feather") : m.property("ADBE Mask Offset");
var isArr = (A.property === "feather");
p.setValueAtTime(A.startTime, isArr ? [A.from, A.from] : A.from);
p.setValueAtTime(A.endTime, isArr ? [A.to, A.to] : A.to);
OSR.applyEase(p, A.easing, 33);
return "Animated mask " + A.property + " on '" + L.name + "': " + A.from + " -> " + A.to + " (" + A.startTime + "s-" + A.endTime + "s)";
`,
  },

  {
    name: "ae_add_trim_path",
    description: "Add Trim Paths to a shape layer and (by default) animate it so the stroke draws on. Adds a stroke first if the shape has none. Best on shapes made by ae_create_shape.",
    schema: {
      comp: z.string().optional(),
      layer: z.string().describe("A shape layer."),
      drawOn: z.boolean().default(true).describe("Animate End 0→100% over the time range."),
      startTime: z.number().default(0),
      endTime: z.number().default(1),
      addStroke: z.boolean().default(true),
      strokeColor: Color.default([1, 1, 1]),
      strokeWidth: z.number().positive().default(8),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var root = L.property("ADBE Root Vectors Group");
if (!root) throw new Error("'" + L.name + "' is not a shape layer.");
// pick the first vector group, or create one
var grp = null;
for (var i = 1; i <= root.numProperties; i++) { if (root.property(i).matchName === "ADBE Vector Group") { grp = root.property(i); break; } }
if (!grp) { grp = root.addProperty("ADBE Vector Group"); }
var contents = grp.property("ADBE Vectors Group");
// ensure a stroke exists in this group
var hasStroke = false;
for (var j = 1; j <= contents.numProperties; j++) { if (contents.property(j).matchName === "ADBE Vector Graphic - Stroke") { hasStroke = true; break; } }
if (!hasStroke && A.addStroke) {
  var st = contents.addProperty("ADBE Vector Graphic - Stroke");
  try { st.property("ADBE Vector Stroke Color").setValue([A.strokeColor[0], A.strokeColor[1], A.strokeColor[2], 1]); } catch (e) {}
  try { st.property("ADBE Vector Stroke Width").setValue(A.strokeWidth); } catch (e) {}
}
var trim = contents.addProperty("ADBE Vector Filter - Trim");
var endP = trim.property("ADBE Vector Trim End");
if (A.drawOn) {
  endP.setValueAtTime(A.startTime, 0);
  endP.setValueAtTime(A.endTime, 100);
  OSR.applyEase(endP, "easeInOut", 33);
} else {
  endP.setValue(100);
}
return "Trim Paths added to '" + L.name + "'" + (A.drawOn ? " — draws on " + A.startTime + "s-" + A.endTime + "s" : "");
`,
  },

  {
    name: "ae_set_track_matte",
    description: "Use the layer directly above as a track matte for this layer (alpha or luma, normal or inverted). Pass 'none' to clear it. The matte layer should be just above the target in the layer stack.",
    schema: {
      comp: z.string().optional(),
      layer: z.string().describe("The layer that gets matted (the one below)."),
      type: z.enum(["alpha", "alpha_inverted", "luma", "luma_inverted", "none"]).default("alpha"),
    },
    build: (a) => {
      const map: Record<string, string> = {
        alpha: "ALPHA", alpha_inverted: "ALPHA_INVERTED", luma: "LUMA", luma_inverted: "LUMA_INVERTED", none: "NO_TRACK_MATTE",
      };
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
L.trackMatteType = TrackMatteType.${map[(a.type ?? "alpha") as string]};
return "Track matte of '" + L.name + "' set to ${a.type ?? "alpha"}";
`;
    },
  },

  {
    name: "ae_set_layer_3d",
    description: "Toggle a layer's 3D switch (or every layer in the comp). Required before a camera move affects 2D layers.",
    schema: {
      comp: z.string().optional(),
      layer: z.string().optional().describe("A single layer. Ignored if allLayers is true."),
      allLayers: z.boolean().default(false).describe("Apply to every layer in the comp."),
      enabled: z.boolean().default(true),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var n = 0;
if (A.allLayers) {
  for (var i = 1; i <= comp.numLayers; i++) { var L = comp.layer(i); if (L.threeDLayer !== undefined) { try { L.threeDLayer = !!A.enabled; n++; } catch (e) {} } }
} else {
  if (!A.layer) throw new Error("Provide a layer name, or set allLayers: true.");
  OSR.layer(comp, A.layer).threeDLayer = !!A.enabled;
  n = 1;
}
return (A.enabled ? "Enabled" : "Disabled") + " 3D on " + n + " layer(s) in '" + comp.name + "'";
`,
  },

  {
    name: "ae_add_camera",
    description: "Add a Camera layer to the comp (becomes the active camera). Animate it with ae_animate_camera — remember 2D layers need their 3D switch on (ae_set_layer_3d) to be affected.",
    schema: {
      comp: z.string().optional(),
      name: z.string().default("Camera"),
      enableDepthOfField: z.boolean().default(false),
      focusDistance: z.number().positive().optional(),
      aperture: z.number().positive().optional(),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var cam = comp.layers.addCamera(A.name, [comp.width / 2, comp.height / 2]);
var co = cam.property("ADBE Camera Options Group");
if (A.enableDepthOfField) { try { co.property("ADBE Camera Depth of Field").setValue(1); } catch (e) {} }
if (A.focusDistance != null) { try { co.property("ADBE Camera Focus Distance").setValue(A.focusDistance); } catch (e) {} }
if (A.aperture != null) { try { co.property("ADBE Aperture").setValue(A.aperture); } catch (e) {} }
return "Added camera '" + cam.name + "' to '" + comp.name + "'" + (A.enableDepthOfField ? " (DOF on)" : "");
`,
  },

  {
    name: "ae_animate_camera",
    description: "Keyframe a camera's position and/or point of interest between two 3D points — a dolly / push-in / pan. If no camera name is given, the first camera in the comp is used.",
    schema: {
      comp: z.string().optional(),
      camera: z.string().optional().describe("Camera layer name. Defaults to the first camera."),
      positionFrom: z.array(z.number()).optional().describe("[x,y,z] start position."),
      positionTo: z.array(z.number()).optional().describe("[x,y,z] end position."),
      pointOfInterestFrom: z.array(z.number()).optional().describe("[x,y,z] start look-at point."),
      pointOfInterestTo: z.array(z.number()).optional().describe("[x,y,z] end look-at point."),
      startTime: z.number().default(0),
      endTime: z.number().default(2),
      easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).default("easeInOut"),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var cam = null;
if (A.camera) { cam = OSR.layer(comp, A.camera); }
else { for (var i = 1; i <= comp.numLayers; i++) { if (comp.layer(i) instanceof CameraLayer) { cam = comp.layer(i); break; } } }
if (!cam) throw new Error("No camera in '" + comp.name + "' — add one with ae_add_camera.");
function pad3(v) { var a = []; for (var i = 0; i < 3; i++) a.push(i < v.length ? v[i] : 0); return a; }
function keyPair(prop, from, to) {
  if (from) prop.setValueAtTime(A.startTime, pad3(from));
  if (to) prop.setValueAtTime(A.endTime, pad3(to));
  if (prop.numKeys > 0) OSR.applyEase(prop, A.easing, 33);
}
var t = cam.property("ADBE Transform Group");
var did = [];
if (A.positionFrom || A.positionTo) { keyPair(t.property("ADBE Position"), A.positionFrom, A.positionTo); did.push("position"); }
if (A.pointOfInterestFrom || A.pointOfInterestTo) {
  var poi = t.property("ADBE Pt of Interest") || t.property("ADBE Anchor Point");
  if (!poi) throw new Error("This camera has no Point of Interest (one-node camera).");
  keyPair(poi, A.pointOfInterestFrom, A.pointOfInterestTo); did.push("point of interest");
}
if (!did.length) throw new Error("Provide at least one of positionFrom/To or pointOfInterestFrom/To.");
return "Animated camera '" + cam.name + "' (" + did.join(", ") + ") over " + A.startTime + "s-" + A.endTime + "s";
`,
  },

  // ── Phase 7: precomps/scenes, markers, time remap, device frames, previews ─

  {
    name: "ae_create_precomp",
    description: "Precompose layers into a new composition (a 'scene') — keeps things organised and lets you apply effects/transforms to a whole group at once.",
    schema: {
      comp: z.string().optional().describe("The comp the layers currently live in."),
      layers: z.array(z.string()).min(1).describe("Names of the layers to precompose."),
      name: z.string().default("Scene"),
      moveAllAttributes: z.boolean().default(true).describe("Move attributes (effects/transforms) into the new comp."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var idx = [];
for (var i = 0; i < A.layers.length; i++) idx.push(OSR.layer(comp, A.layers[i]).index);
var pre = comp.layers.precompose(idx, A.name, A.moveAllAttributes);
return "Precomposed " + idx.length + " layer(s) of '" + comp.name + "' into '" + pre.name + "'";
`,
  },

  {
    name: "ae_add_layer_to_comp",
    description: "Add an existing composition (a precomp/scene) or imported footage item into another composition as a layer.",
    schema: {
      targetComp: z.string().optional().describe("The comp to add the layer to. Defaults to the active comp."),
      source: z.string().describe("Name of a composition or footage item in the project."),
      position: Vec2.optional().describe("Layer position. Defaults to comp center."),
    },
    build: (a) => `
var A = ${lit(a)};
var target = OSR.comp(A.targetComp);
var src = null;
for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i).name === A.source) { src = app.project.item(i); break; } }
if (!src) throw new Error("Project item not found: " + A.source);
var L = target.layers.add(src);
if (A.position && A.position.length === 2) OSR.tprop(L, "position").setValue(A.position);
return "Added '" + src.name + "' to '" + target.name + "' as layer '" + L.name + "'";
`,
  },

  {
    name: "ae_add_markers",
    description: "Add markers at the given times — on the composition timeline (for beat/section sync) or on a specific layer. Optional labels.",
    schema: {
      comp: z.string().optional(),
      times: z.array(z.number()).min(1).describe("Marker times in seconds."),
      labels: z.array(z.string()).optional().describe("Comments, parallel to `times`."),
      layer: z.string().optional().describe("If given, add layer markers instead of comp markers."),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var prop = A.layer ? OSR.layer(comp, A.layer).property("ADBE Marker") : comp.markerProperty;
for (var i = 0; i < A.times.length; i++) {
  prop.setValueAtTime(A.times[i], new MarkerValue((A.labels && A.labels[i]) ? A.labels[i] : ""));
}
return "Added " + A.times.length + " marker(s)" + (A.layer ? " to layer '" + A.layer + "'" : " to comp '" + comp.name + "'");
`,
  },

  {
    name: "ae_enable_time_remap",
    description: "Enable Time Remapping on a layer whose source has a duration (footage, comp/precomp). Then keyframe it with ae_animate_time_remap for speed ramps / freeze frames.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
L.timeRemapEnabled = true;
return "Time Remapping enabled on '" + L.name + "'";
`,
  },

  {
    name: "ae_animate_time_remap",
    description: "Keyframe Time Remapping on a layer — each key maps a comp time to a source time (slow-mo, speed-up, freeze, reverse). Enables time remapping first if needed.",
    schema: {
      comp: z.string().optional(),
      layer: z.string(),
      keys: z.array(z.object({ at: z.number().describe("Comp time (s)."), source: z.number().describe("Source time (s) to show at that comp time.") })).min(2),
      easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).default("linear"),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
if (!L.timeRemapEnabled) L.timeRemapEnabled = true;
var tr = L.property("ADBE Time Remapping");
for (var i = 0; i < A.keys.length; i++) tr.setValueAtTime(A.keys[i].at, A.keys[i].source);
OSR.applyEase(tr, A.easing, 33);
return "Time-remapped '" + L.name + "' with " + A.keys.length + " key(s) (" + A.easing + ")";
`,
  },

  {
    name: "ae_add_device_frame",
    description: "Wrap a layer in a mockup frame — 'card' (rounded panel + shadow), 'browser' (panel + a top chrome bar with traffic-light dots), or 'phone' (tall rounded panel). The content layer is parented to the frame so they move together. Best on footage/precomp layers (a screenshot or UI scene).",
    schema: {
      comp: z.string().optional(),
      layer: z.string().describe("The content layer to frame (e.g. a screenshot)."),
      style: z.enum(["card", "browser", "phone"]).default("card"),
      contentSize: Vec2.optional().describe("[w, h] of the content as displayed. Defaults to the layer's source size."),
      padding: z.number().min(0).default(0).describe("Extra frame around the content (px)."),
      cornerRadius: z.number().min(0).default(20),
      frameColor: Color.default([1, 1, 1]),
      shadow: z.boolean().default(true),
    },
    build: (a) => `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
var L = OSR.layer(comp, A.layer);
var cw = (A.contentSize && A.contentSize[0]) ? A.contentSize[0] : (L.width || comp.width);
var ch = (A.contentSize && A.contentSize[1]) ? A.contentSize[1] : (L.height || comp.height);
var chrome = (A.style === "browser") ? 56 : 0;
var fw = cw + A.padding * 2;
var fh = ch + A.padding * 2 + chrome;
// frame shape, placed at the content layer's position (which sits at comp center by default for fresh layers)
var cx = comp.width / 2, cy = comp.height / 2;
var frame = comp.layers.addShape();
frame.name = L.name + " Frame";
frame.moveAfter(L); // frame goes behind the content
var c1 = frame.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").property("ADBE Vectors Group");
var r1 = c1.addProperty("ADBE Vector Shape - Rect");
r1.property("ADBE Vector Rect Size").setValue([fw, fh]);
r1.property("ADBE Vector Rect Roundness").setValue(A.cornerRadius);
c1.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([A.frameColor[0], A.frameColor[1], A.frameColor[2], 1]);
OSR.tprop(frame, "position").setValue([cx, cy]);
if (A.shadow) {
  var e = frame.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
  try { e.property("ADBE Drop Shadow-0002").setValue(110); } catch (x) {}
  try { e.property("ADBE Drop Shadow-0004").setValue(28); } catch (x) {}
  try { e.property("ADBE Drop Shadow-0005").setValue(80); } catch (x) {}
}
// nudge the content inside the frame (account for chrome bar at the top)
OSR.tprop(L, "position").setValue([cx, cy + chrome / 2]);
L.parent = frame;
var madeChrome = false;
if (A.style === "browser") {
  var bar = comp.layers.addShape();
  bar.name = L.name + " Chrome";
  bar.moveBefore(L);
  var rootC = bar.property("ADBE Root Vectors Group");
  var cols = [[0.98, 0.36, 0.34], [0.99, 0.74, 0.18], [0.16, 0.78, 0.34]];
  var dotX = -fw / 2 + 34;
  for (var d = 0; d < 3; d++) {
    var g = rootC.addProperty("ADBE Vector Group");
    var gc = g.property("ADBE Vectors Group");
    var el = gc.addProperty("ADBE Vector Shape - Ellipse");
    el.property("ADBE Vector Ellipse Size").setValue([14, 14]);
    el.property("ADBE Vector Ellipse Position").setValue([dotX + d * 26, 0]);
    gc.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([cols[d][0], cols[d][1], cols[d][2], 1]);
  }
  OSR.tprop(bar, "position").setValue([cx, cy - fh / 2 + chrome / 2]);
  bar.parent = frame;
  madeChrome = true;
}
return "Wrapped '" + L.name + "' in a " + A.style + " frame (" + Math.round(fw) + "x" + Math.round(fh) + ")" + (A.shadow ? " with shadow" : "") + (madeChrome ? " + chrome bar" : "");
`,
  },

  {
    name: "ae_render_frames",
    description: "Render several frames of a composition to PNGs at once — use it to review motion across a range of times. Returns the saved file paths.",
    schema: {
      comp: z.string().optional(),
      times: z.array(z.number()).min(1).describe("Times in seconds to capture."),
      outputDir: z.string().optional().describe("Directory for the PNGs. Defaults to the OS temp dir."),
      prefix: z.string().default("openshowreel-frame"),
    },
    build: (a) => {
      const dir = a.outputDir ?? tmpdir();
      return `
var A = ${lit(a)};
var comp = OSR.comp(A.comp);
if (typeof comp.saveFrameToPng !== "function") throw new Error("This After Effects version has no saveFrameToPng — use ae_render_comp.");
var dir = new Folder(${lit(dir)});
var sep = (dir.fsName.charAt(dir.fsName.length - 1) === "/") ? "" : "/";
var paths = [];
for (var i = 0; i < A.times.length; i++) {
  var p = dir.fsName + sep + A.prefix + "-" + String(A.times[i]).replace(/\\./g, "_") + "s.png";
  comp.saveFrameToPng(A.times[i], new File(p));
  paths.push(p);
}
return "Saved " + paths.length + " frame(s) of '" + comp.name + "':\\n" + paths.join("\\n");
`;
    },
  },
];
