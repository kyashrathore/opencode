import { IdleProcessFamilyTracker, parseIdleProcessTable, type IdleProcessRow } from "./idle-process-family";

export type ProcessSnapshot = {
  pid: number;
  parentPid: number;
  startTimeMs: number;
  rssBytes: number;
  cpuSeconds: number;
  executable: string;
  command: string;
  /**
   * macOS `ri_phys_footprint` for this process, when the packaged diagnostics
   * helper is available. Reported alongside `rssBytes`, never instead of it:
   * `resource.peak_process_family_rss_mib` is defined on the summed `ps rss`
   * and is deliberately left untouched. Summed RSS charges shared pages to
   * every process that maps them, so a five-process family counts one Electron
   * Framework up to five times; `ri_phys_footprint` is what the OS actually
   * attributes. Recording both makes that difference visible per run instead of
   * arguable.
   */
  physFootprintBytes?: number;
};

export async function readProcessTable(): Promise<ProcessSnapshot[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`process-family observation is unsupported on ${process.platform}`);
  const child = Bun.spawn({ cmd: ["ps", "-axo", "pid=,ppid=,rss=,time=,lstart=,command="], stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`ps failed: ${stderr.trim()}`);
  const parsed = parseProcessTable(stdout);
  if (!parsed.length) throw new Error("ps returned no parseable process rows");
  return parsed;
}

export function parseProcessTable(output: string): ProcessSnapshot[] {
  return parseIdleProcessTable(output).map(fromIdleRow);
}

export function toIdleRows(table: readonly ProcessSnapshot[]): IdleProcessRow[] {
  return table.map((row) => ({ pid: row.pid, ppid: row.parentPid, rssBytes: row.rssBytes, cpuSeconds: row.cpuSeconds, startedAtMs: row.startTimeMs, command: row.command }));
}

export function processFamily(table: readonly ProcessSnapshot[], rootPid: number) {
  const tracker = new IdleProcessFamilyTracker(rootPid);
  const ids = new Set(tracker.observe(toIdleRows(table), performance.now()).pids);
  return table.filter((row) => ids.has(row.pid));
}

export function processLineage(table: readonly ProcessSnapshot[], pid: number) {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const result: ProcessSnapshot[] = [];
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current && !seen.has(current.pid)) { result.push(current); seen.add(current.pid); current = byPid.get(current.parentPid); }
  return result;
}
export function sameProcessIdentity(left: Pick<ProcessSnapshot, "pid" | "startTimeMs">, right: Pick<ProcessSnapshot, "pid" | "startTimeMs">) {
  return left.pid === right.pid && Math.abs(left.startTimeMs - right.startTimeMs) < 1_000;
}

/**
 * The product already ships and locates this helper: `src/main/index.ts` builds
 * `<resourcesPath>/diagnostics/macos-memory-impact` and hands it to the
 * diagnostics worker. Resolve it the same way from the packaged executable so
 * the benchmark reads the same instrument the application reports from, rather
 * than inventing a second definition of physical footprint.
 */
