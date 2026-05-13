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
    description: "Create a premium staggered text reveal: a Text Animator pushes each glyph off-screen (Position offset) at 0% opacity, and an Expression Selector pulls them into place one character/word/line at a time — not a flat fade.",
    schema: {
      comp: z.string().optional(),
      text: z.string(),
      name: z.string().optional().describe("Layer name. Defaults to the text content."),
      position: Vec2.optional().describe("Layer position. Defaults to comp center."),
      fontSize: z.number().positive().default(120),
      color: Color.default([1, 1, 1]),
      font: z.string().optional().describe("PostScript font name, e.g. 'Inter-Bold'."),
      basedOn: z.enum(["characters", "words", "lines"]).default("characters"),
      offsetY: z.number().default(-120).describe("How far (px) each glyph starts above its final spot."),
      startTime: z.number().default(0),
      staggerSeconds: z.number().positive().default(0.9).describe("Total time across which the whole reveal staggers."),
    },
    build: (a) => {
      // Selector amount 100 = "animator fully applied" = glyph off-screen at 0% opacity;
      // amount 0 = glyph at rest (revealed). So each glyph eases 100 -> 0 over its slot.
      const expr =
        `n = textTotal;\n` +
        `seg = ${a.staggerSeconds ?? 0.9} / Math.max(n, 1);\n` +
        `t = time - inPoint - ${a.startTime ?? 0} - (textIndex - 1) * seg;\n` +
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
props.addProperty("ADBE Text Position 3D").setValue([0, A.offsetY, 0]);
props.addProperty("ADBE Text Opacity").setValue(0);
var sels = anim.property("ADBE Text Selectors");
while (sels.numProperties > 0) { try { sels.property(1).remove(); } catch (e) { break; } }
var es = sels.addProperty("ADBE Text Expressible Selector");
try { es.property("ADBE Text Range Type2").setValue(${basedOnInt(a.basedOn ?? "characters")}); } catch (e) {}
es.property("ADBE Text Expressible Amount").expression = ${lit(expr)};
return "Text reveal '" + tl.name + "' created — staggered per " + A.basedOn + " over " + A.staggerSeconds + "s from " + A.startTime + "s.";
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
];
