import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

/**
 * ExtendScript helpers injected before every tool body. Exposed as `OSR`.
 * Kept ES3-compatible — After Effects ExtendScript has no `let`/`const`/arrow fns.
 */
const PRELUDE = `
var OSR = {
  comp: function (name) {
    if (name) {
      for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === name) return it;
      }
      throw new Error("Composition not found: " + name);
    }
    var c = app.project.activeItem;
    if (!c || !(c instanceof CompItem)) throw new Error("No active composition — run ae_setup_comp or open one in After Effects first.");
    return c;
  },
  layer: function (comp, ref) {
    if (typeof ref === "number") return comp.layer(ref);
    for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === ref) return comp.layer(i);
    throw new Error("Layer not found: '" + ref + "' in comp '" + comp.name + "'");
  },
  xform: function (layer) { return layer.property("ADBE Transform Group"); },
  tprop: function (layer, name) {
    var map = {
      position: "ADBE Position", scale: "ADBE Scale", rotation: "ADBE Rotate Z",
      opacity: "ADBE Opacity", anchor: "ADBE Anchor Point", anchorpoint: "ADBE Anchor Point"
    };
    var mn = map[String(name).toLowerCase()] || name;
    var p = OSR.xform(layer).property(mn);
    if (!p) throw new Error("Transform property not found: " + name);
    return p;
  },
  scaleArray: function (base, factor) {
    var o = [];
    for (var i = 0; i < base.length; i++) o.push(base[i] * factor);
    return o;
  },
  // Number of value components for a property — derived from its type (always safe to read),
  // because the .value getter itself can throw "invalid numeric result" on shape-layer
  // spatial properties that have no keyframes (an Advanced-3D-renderer quirk).
  dimsOf: function (prop) {
    switch (prop.propertyValueType) {
      case PropertyValueType.ThreeD: case PropertyValueType.ThreeD_SPATIAL: return 3;
      case PropertyValueType.TwoD: case PropertyValueType.TwoD_SPATIAL: return 2;
      default: return 1;
    }
  },
  // A vector of the right length filled with n (or n itself for 1-D properties).
  fill: function (prop, n) {
    var d = OSR.dimsOf(prop);
    if (d === 1) return n;
    var a = []; for (var i = 0; i < d; i++) a.push(n); return a;
  },
  // Coerce a user-supplied number-or-array to match a property's dimensionality.
  // Missing components are padded with the property's natural rest value (0, except Scale → 100).
  // A bare number is broadcast to every component.
  coerce: function (prop, val) {
    var d = OSR.dimsOf(prop);
    if (d === 1) return (val instanceof Array) ? val[0] : val;
    var pad = (prop.matchName === "ADBE Scale") ? 100 : 0;
    if (val instanceof Array) {
      var a = []; for (var i = 0; i < d; i++) a.push(i < val.length ? val[i] : pad); return a;
    }
    var b = []; for (var j = 0; j < d; j++) b.push(val); return b;
  },
  easeKeys: function (prop) {
    OSR.applyEase(prop, "easeInOut", 33);
  },
  // Apply an easing preset to every keyframe of a property.
  //   linear | hold | easeIn (ease the incoming side) | easeOut (ease the outgoing side) | easeInOut (Easy Ease)
  applyEase: function (prop, mode, influence) {
    var n = prop.numKeys;
    if (n < 1) return;
    var inf = influence || 33;
    function easeDims() {
      // Spatial properties (Position, Anchor Point) take a single scalar temporal ease,
      // even though their value is a 2D/3D array. Otherwise match the value dimensions.
      var mn = prop.matchName;
      if (mn === "ADBE Position" || mn === "ADBE Anchor Point") return 1;
      return OSR.dimsOf(prop);
    }
    function eases(amount) {
      var d = easeDims(), a = [];
      for (var i = 0; i < d; i++) a.push(new KeyframeEase(0, amount));
      return a;
    }
    for (var k = 1; k <= n; k++) {
      if (mode === "linear") { try { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e) {} continue; }
      if (mode === "hold") { try { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.HOLD); } catch (e) {} continue; }
      try { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); } catch (e) {}
      var inAmount = (mode === "easeOut") ? 0.1 : inf;
      var outAmount = (mode === "easeIn") ? 0.1 : inf;
      try { prop.setTemporalEaseAtKey(k, eases(inAmount), eases(outAmount)); } catch (e) {}
    }
  },
  findShapeSize: function (group) {
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (p.matchName === "ADBE Vector Rect Size" || p.matchName === "ADBE Vector Ellipse Size") return p;
      if (p.numProperties && p.numProperties > 0) { var r = OSR.findShapeSize(p); if (r) return r; }
    }
    return null;
  },
  // ---- Phase 2 helpers ----
  // Compact, opinionated layer summary. Returns a plain object with whatever fields you asked for
  // (defaults to a short set). Avoids dumping the full property tree.
  layerInfo: function (layer, fields) {
    var f = fields || ["in", "out", "start", "name", "index"];
    var has = {}; for (var i = 0; i < f.length; i++) has[f[i]] = true;
    var o = {};
    if (has["name"]) o.name = layer.name;
    if (has["index"]) o.index = layer.index;
    if (has["in"]) o["in"] = layer.inPoint;
    if (has["out"]) o["out"] = layer.outPoint;
    if (has["start"]) o.start = layer.startTime;
    if (has["enabled"]) o.enabled = layer.enabled;
    if (has["parent"]) o.parent = layer.parent ? layer.parent.name : null;
    if (has["blendMode"]) o.blendMode = layer.blendingMode;
    if (has["pos"] || has["position"]) o.pos = OSR.tprop(layer, "position").value;
    if (has["scale"]) o.scale = OSR.tprop(layer, "scale").value;
    if (has["opacity"]) o.opacity = OSR.tprop(layer, "opacity").value;
    if (has["rotation"]) o.rotation = OSR.tprop(layer, "rotation").value;
    if (has["anchor"]) o.anchor = OSR.tprop(layer, "anchor").value;
    return o;
  },
  // Set in/out/start atomically without clipping. AE shifts in/out when startTime moves,
  // so we park outPoint far first, then set startTime, then in/out. Returns prev values.
  setTiming: function (layer, t) {
    var prev = { "in": layer.inPoint, out: layer.outPoint, start: layer.startTime };
    var comp = layer.containingComp;
    var safe = (comp ? comp.duration : 1e6) + 1;
    layer.outPoint = safe;
    if (t.start !== undefined && t.start !== null) layer.startTime = t.start;
    if (t["in"] !== undefined && t["in"] !== null) layer.inPoint = t["in"];
    layer.outPoint = (t.out !== undefined && t.out !== null) ? t.out : prev.out;
    return prev;
  },
  // Resolve a dotted property path like "Transform.Position" or "Effects.Drop Shadow.Opacity".
  // Falls back to matchName lookup for common transform names.
  prop: function (layer, path) {
    if (!path) return layer;
    var parts = (path instanceof Array) ? path : String(path).split(".");
    var p = layer;
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i];
      var next = null;
      try { next = p.property(name); } catch (e) { next = null; }
      if (!next) throw new Error("Property not found at '" + parts.slice(0, i + 1).join(".") + "' (layer '" + (layer.name || "?") + "')");
      p = next;
    }
    return p;
  },
  // Compact keyframe list for a property: [{t, v}]. Skips temporal-ease (use setKeys to set it).
  keysOf: function (prop) {
    var n = prop.numKeys, out = [];
    for (var k = 1; k <= n; k++) out.push({ t: prop.keyTime(k), v: prop.keyValue(k) });
    return out;
  },
  // Replace all keyframes on a property with the given list (atomic).
  // Each key: {t, v, interp?: "linear"|"bezier"|"hold", ease?: "easeIn"|"easeOut"|"easeInOut"|"linear"|"hold"}
  setKeys: function (prop, keys) {
    while (prop.numKeys > 0) prop.removeKey(1);
    if (!keys || keys.length === 0) return 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      prop.setValueAtTime(k.t, k.v);
    }
    var defaultEase = null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var interp = k.interp || "bezier";
      try {
        if (interp === "linear") prop.setInterpolationTypeAtKey(i + 1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        else if (interp === "hold") prop.setInterpolationTypeAtKey(i + 1, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
        else prop.setInterpolationTypeAtKey(i + 1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
      } catch (e) {}
      if (k.ease) {
        if (!defaultEase) defaultEase = k.ease;
      }
    }
    if (defaultEase) OSR.applyEase(prop, defaultEase, 33);
    return keys.length;
  },
  // Bulk shift layers by delta seconds. opts: {minIn, maxIn, excludeNames, excludeIndices,
  // includeNames, extendFullSpan} — extendFullSpan extends outPoint of layers that span to old end.
  shiftLayers: function (comp, opts, delta) {
    var o = opts || {};
    var origDur = comp.duration;
    var shifted = [], extended = [], skipped = [];
    var exNames = {}, inNames = null, exIdx = {};
    if (o.excludeNames) for (var i = 0; i < o.excludeNames.length; i++) exNames[o.excludeNames[i]] = true;
    if (o.includeNames) { inNames = {}; for (var i = 0; i < o.includeNames.length; i++) inNames[o.includeNames[i]] = true; }
    if (o.excludeIndices) for (var i = 0; i < o.excludeIndices.length; i++) exIdx[o.excludeIndices[i]] = true;
    var minIn = (o.minIn !== undefined) ? o.minIn : -Infinity;
    var maxIn = (o.maxIn !== undefined) ? o.maxIn : Infinity;
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      var tag = i + " '" + l.name + "'";
      if (exNames[l.name] || exIdx[i]) { skipped.push(tag + " excluded"); continue; }
      if (inNames && !inNames[l.name]) { skipped.push(tag + " not in include list"); continue; }
      if (l.inPoint >= minIn - 1e-6 && l.inPoint <= maxIn + 1e-6) {
        var prev = OSR.setTiming(l, { start: l.startTime + delta, "in": l.inPoint + delta, out: l.outPoint + delta });
        shifted.push(tag + " in " + prev["in"].toFixed(2) + "->" + l.inPoint.toFixed(2));
      } else if (o.extendFullSpan && Math.abs(l.outPoint - origDur) < 0.1) {
        l.outPoint = l.outPoint + delta;
        extended.push(tag + " out=" + l.outPoint.toFixed(2));
      } else {
        skipped.push(tag + " in=" + l.inPoint.toFixed(2) + " out of range");
      }
    }
    return { shifted: shifted, extended: extended, skipped: skipped };
  }
};
`;

function wrap(body: string, resultPath: string): string {
  return `
(function () {
  var __rf = new File(${JSON.stringify(resultPath)});
  function __out(status, msg) {
    __rf.encoding = "UTF-8";
    __rf.lineFeed = "Unix";
    __rf.open("w");
    __rf.write(status + "\\n" + (msg === undefined || msg === null ? "" : String(msg)));
    __rf.close();
  }
  var __undo = false;
  try {
    app.beginUndoGroup("OpenShowreel"); __undo = true;
    var __r = (function () {
${PRELUDE}
${body}
    })();
    if (__undo) { app.endUndoGroup(); __undo = false; }
    __out("OK", __r === undefined ? "done" : __r);
  } catch (e) {
    try { if (__undo) app.endUndoGroup(); } catch (ee) {}
    __out("ERR", (e && e.message) ? e.message : e);
  }
})();
`;
}

let cachedAppName: string | undefined;

async function resolveAppName(): Promise<string> {
  if (process.env.AE_APP_NAME) return process.env.AE_APP_NAME;
  if (cachedAppName) return cachedAppName;
  try {
    const entries = await readdir("/Applications");
    const ae = entries
      .filter((e) => /^Adobe After Effects/i.test(e))
      .map((e) => e.replace(/\.app$/i, ""))
      .sort()
      .reverse()[0];
    cachedAppName = ae ?? "Adobe After Effects 2026";
  } catch {
    cachedAppName = "Adobe After Effects 2026";
  }
  return cachedAppName;
}

export type RunOptions = {
  /** Hard timeout for the AppleScript round-trip. Default 180 s. Bump it for renders. */
  timeoutMs?: number;
  /** Cap the result string at this many bytes (default 6144). Set 0 to disable. */
  maxResultBytes?: number;
};

const DEFAULT_MAX_RESULT_BYTES = 6144;

function truncateResult(s: string, max: number): string {
  if (!max || s.length <= max) return s;
  return s.slice(0, max) + `\n…<${s.length - max} bytes truncated; ask for a narrower query>`;
}

/**
 * Run an ExtendScript body inside After Effects and return its result string.
 * The body may `return` any value; it is wrapped in an undo group and a try/catch
 * that writes the outcome to a temp file we read back (DoScript has no return channel).
 */
/** When OPENSHOWREEL_DRY_RUN is set, tools don't touch After Effects — useful for tests/CI. */
export const isDryRun = (): boolean => !!process.env.OPENSHOWREEL_DRY_RUN;

export async function runJsx(body: string, opts: RunOptions = {}): Promise<string> {
  if (isDryRun()) return `[dry-run] would execute ${body.split("\n").length} lines of ExtendScript in After Effects`;
  const dir = await mkdtemp(join(tmpdir(), "openshowreel-"));
  const scriptPath = join(dir, "osr.jsx");
  const resultPath = join(dir, "result.txt");
  await writeFile(scriptPath, wrap(body, resultPath), "utf8");

  const appName = await resolveAppName();
  // After Effects' DoScript only accepts a script *string*, not a file. Pass a tiny
  // bootstrap that reads our (possibly large, multi-line) script file and evals it —
  // avoids escaping the whole script into an AppleScript string literal.
  const bootstrap = `var __sf=new File(${JSON.stringify(scriptPath)});__sf.encoding="UTF-8";__sf.open("r");var __code=__sf.read();__sf.close();eval(__code);`;
  const asLiteral = `"${bootstrap.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  let execErr: unknown;
  try {
    await execFileP(
      "osascript",
      ["-e", `tell application ${JSON.stringify(appName)} to DoScript ${asLiteral}`],
      { timeout: opts.timeoutMs ?? 180_000 },
    );
  } catch (e) {
    execErr = e;
  }

  let raw: string | undefined;
  try {
    raw = await readFile(resultPath, "utf8");
  } catch {
    /* no result file written */
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  if (raw === undefined) {
    const stderr = (execErr as { stderr?: string } | undefined)?.stderr?.trim();
    const isTimeout = (execErr as { killed?: boolean; signal?: string } | undefined)?.killed === true;
    if (isTimeout) {
      throw new Error(
        `After Effects did not finish within ${opts.timeoutMs ?? 180_000} ms. ` +
          `Partial state may be committed — run a small ae_eval to inspect what changed before retrying. ` +
          `Split long-running scripts into smaller batches; never call app.executeCommand(16) (undo) to "recover" — it undoes prior wrapped operations too.`,
      );
    }
    throw new Error(
      stderr ||
        `After Effects did not respond. Is "${appName}" installed and able to run scripts? ` +
          `(Preferences ▸ Scripting & Expressions ▸ "Allow Scripts to Write Files and Access Network" must be on.)`,
    );
  }

  const normalized = raw.replace(/\r\n?/g, "\n");
  const nl = normalized.indexOf("\n");
  const status = (nl === -1 ? normalized : normalized.slice(0, nl)).trim();
  const message = (nl === -1 ? "" : normalized.slice(nl + 1)).trim();
  const cap = opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (status === "OK") return truncateResult(message || "done", cap);
  throw new Error(truncateResult(message || "Unknown After Effects error", cap));
}
