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
  easeKeys: function (prop) {
    for (var i = 1; i <= prop.numKeys; i++) {
      try { prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); } catch (e) {}
    }
  },
  findShapeSize: function (group) {
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (p.matchName === "ADBE Vector Rect Size" || p.matchName === "ADBE Vector Ellipse Size") return p;
      if (p.numProperties && p.numProperties > 0) { var r = OSR.findShapeSize(p); if (r) return r; }
    }
    return null;
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
};

/**
 * Run an ExtendScript body inside After Effects and return its result string.
 * The body may `return` any value; it is wrapped in an undo group and a try/catch
 * that writes the outcome to a temp file we read back (DoScript has no return channel).
 */
export async function runJsx(body: string, opts: RunOptions = {}): Promise<string> {
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
  if (status === "OK") return message || "done";
  throw new Error(message || "Unknown After Effects error");
}
