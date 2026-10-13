import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { normalizePath } from "./paths.mjs";

export const TSJS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const IMPORT_RE = /(?:import\s*['"]|(?:import|export)\s+[^;]*?\bfrom\s*['"]|(?:import|require)\s*\(\s*['"])([^'"]+)['"]/g;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// Cache source parsing, then re-resolve targets on every scan: newly created or
// removed modules must change the graph even when their importers are unchanged.
export function createImportGraphCache({ readFile = readFileSync, stat = statSync, maxRoots = 4, maxFiles = 2000, maxBytes = 16 * 1024 * 1024 } = {}) {
  const roots = new Map();
  return (cwd, files) => {
    const root = resolve(cwd);
    const previous = roots.get(root) ?? { files: new Map() };
    roots.delete(root);
    const next = { files: new Map(), graph: new Map(), signature: "" };
    let bytes = 0;
    let cacheable = true;
    const edges = [];
    const targetStats = new Map();
    const isFile = (path) => {
      if (!targetStats.has(path)) {
        try { targetStats.set(path, stat(path).isFile()); } catch { targetStats.set(path, false); }
      }
      return targetStats.get(path);
    };
    for (const file of files) {
      if (!TSJS_EXT.has(extname(file).toLowerCase())) continue;
      let st, record;
      try {
        st = stat(file);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
        const fingerprint = [st.size, st.mtimeMs, st.ctimeMs, st.ino].join(":");
        record = previous.files.get(file);
        if (record?.fingerprint !== fingerprint) {
          const text = readFile(file, "utf8");
          record = { fingerprint, specs: [...text.matchAll(IMPORT_RE)].map((m) => m[1]) };
        }
      } catch { continue; }
      if (next.files.size < maxFiles && bytes + st.size <= maxBytes) {
        next.files.set(file, record);
        bytes += st.size;
      } else cacheable = false;
      for (const spec of record.specs) {
        if (!spec.startsWith(".")) continue;
        const base = resolve(dirname(file), spec);
        const candidates = [base, ...[...TSJS_EXT].map((ext) => base + ext), ...[...TSJS_EXT].map((ext) => join(base, "index" + ext))];
        const target = candidates.find(isFile);
        if (!target) continue;
        const key = normalizePath(target);
        if (!next.graph.has(key)) next.graph.set(key, new Set());
        next.graph.get(key).add(file);
        if (cacheable) edges.push([key, file]);
      }
    }
    if (cacheable) next.signature = JSON.stringify(edges);
    const graph = cacheable && previous.signature === next.signature ? previous.graph : next.graph;
    // Bound retained state even when the requested project exceeds the cache.
    roots.set(root, { files: next.files, ...(cacheable ? { graph, signature: next.signature } : {}) });
    while (roots.size > maxRoots) roots.delete(roots.keys().next().value);
    return graph;
  };
}

export const buildImportGraph = createImportGraphCache();
