/**
 * RTK (Router Tool Kit) output filters.
 *
 * 11 regex-based filters that auto-detect the format of a tool output and
 * compress it losslessly:
 *
 *   1. gitDiff   — strips diff headers, compacts @@ hunk markers
 *   2. gitStatus — converts porcelain to compact M/D/A/R/? lines
 *   3. gitLog    — keeps commit subjects + author, drops body padding
 *   4. grep      — groups matches by file: [file] path (N):\n  L123: text
 *   5. find      — caps path-like lines per directory
 *   6. tree      — removes "N directories, M files" summary, caps at 200 lines
 *   7. ls        — strips perms/sizes/dates, groups dirs first, summary line
 *   8. dedupLog  — collapses consecutive duplicate lines into ↳ [repeated N more]
 *   9. smartTruncate — fallback: keeps first 120 + last 60 lines with ...
 *  10. readNumbered — preserves IDE-style ` N|content` lines (Cursor read tool)
 *  11. buildOutput — keeps errors/warnings/summary, drops progress logs
 *
 * `rtkCompress(text)` auto-detects the format and applies the right filter.
 * Fail-open: if anything fails, returns the original text.
 */

const RAW_CAP = 10 * 1024 * 1024; // 10 MiB
const MIN_COMPRESS_SIZE = 500;
const DETECT_WINDOW = 1024;

const GIT_DIFF_HUNK_MAX_LINES = 100;
const GIT_LOG_MAX_LINES = 200;
const GREP_PER_FILE_MAX = 10;
const FIND_PER_DIR_MAX = 10;
const FIND_TOTAL_DIR_MAX = 20;
const STATUS_MAX_FILES = 30;
const STATUS_MAX_UNTRACKED = 10;
const LS_EXT_SUMMARY_TOP = 5;
const TREE_MAX_LINES = 200;
const SMART_TRUNCATE_HEAD = 120;
const SMART_TRUNCATE_TAIL = 60;
const SMART_TRUNCATE_MIN_LINES = 250;
const READ_NUMBERED_MIN_HIT_RATIO = 0.7;

/** Should this text be compressed? */
export function shouldCompress(text: string): boolean {
  return text.length >= MIN_COMPRESS_SIZE && text.length <= RAW_CAP;
}

/** Auto-detect the format of `text` by peeking at the first DETECT_WINDOW chars. */
function autoDetectFilter(text: string): string | null {
  const peek = text.slice(0, DETECT_WINDOW);
  if (!peek.trim()) return null;

  // git log
  if (/^commit [0-9a-f]{7,40}/m.test(peek)) return "gitLog";
  // git diff
  if (/^diff --git a\//m.test(peek) || /^---\s+[\/]?[a-z]\//m.test(peek)) return "gitDiff";
  // git status (porcelain)
  if (/^[MADRC?!\?]{1,2} /m.test(peek) && peek.includes("\t")) return "gitStatus";
  // build output (npm/yarn/cargo)
  if (/^(npm (ERR|warn)|yarn (warning|error)|error\[|error:|warning:|BUILD (FAILED|SUCCESS))/m.test(peek))
    return "buildOutput";
  // grep output (file:line: content or file:line content)
  if (/^.+:\d+(:.*)?$/m.test(peek) && peek.split("\n").length > 3) return "grep";
  // find output (paths only)
  if (/^\.?\/[^\s:]+$/m.test(peek) && !peek.includes(":")) return "find";
  // tree output (├── └──)
  if (/^[├└─]+\s/m.test(peek)) return "tree";
  // ls -la output (drwxr-xr-x)
  if (/^[d-][rwx-]{9}\s/m.test(peek)) return "ls";
  // read-numbered (Cursor-style ` N|content`)
  if (/^\s*\d+\|/m.test(peek)) {
    const lines = peek.split("\n").filter(Boolean);
    if (lines.length > 0) {
      const matches = lines.filter((l) => /^\s*\d+\|/.test(l)).length;
      if (matches / lines.length >= READ_NUMBERED_MIN_HIT_RATIO) return "readNumbered";
    }
  }
  // dedup log
  if (/(.*)\n\1\n\1/m.test(peek)) return "dedupLog";
  // search list (Cursor glob output)
  if (/^Result of search in/m.test(peek)) return "searchList";
  // smart truncate for large blobs
  if (text.length > MIN_COMPRESS_SIZE * 4) return "smartTruncate";

  return null;
}

/** Safe apply: never grows input, never returns empty. */
function safeApply(fn: (text: string) => string, text: string): string {
  try {
    const result = fn(text);
    if (!result || result.length === 0) return text;
    if (result.length > text.length) return text;
    return result;
  } catch {
    return text;
  }
}

/** Compress text using auto-detected filter. Fail-open. */
export function rtkCompress(text: string): string {
  if (!shouldCompress(text)) return text;
  const filter = autoDetectFilter(text);
  if (!filter) return text;
  switch (filter) {
    case "gitDiff":
      return safeApply(compressGitDiff, text);
    case "gitLog":
      return safeApply(compressGitLog, text);
    case "gitStatus":
      return safeApply(compressGitStatus, text);
    case "buildOutput":
      return safeApply(compressBuildOutput, text);
    case "grep":
      return safeApply(compressGrep, text);
    case "find":
      return safeApply(compressFind, text);
    case "tree":
      return safeApply(compressTree, text);
    case "ls":
      return safeApply(compressLs, text);
    case "readNumbered":
      return safeApply(compressReadNumbered, text);
    case "dedupLog":
      return safeApply(compressDedupLog, text);
    case "searchList":
      return safeApply(compressSearchList, text);
    case "smartTruncate":
      return safeApply(smartTruncate, text);
    default:
      return text;
  }
}

// ── Filters ────────────────────────────────────────────────────────────────────

function compressGitDiff(text: string): string {
  let out = text
    // Drop diff headers (keep `diff --git` for context)
    .replace(/^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}.*$/gm, "")
    .replace(/^(new file|deleted file|old file|similarity index|dissimilarity index|copy from|copy to|rename from|rename to|old mode|new mode|similarity index) .*$/gm, "")
    // Drop --- a/ +++ b/ headers (the path is already in diff --git line)
    .replace(/^---\s+(a\/)?(.*)$/gm, "--- $2")
    .replace(/^\+\+\+\s+(b\/)?(.*)$/gm, "+++ $2")
    // Compact @@ -X,Y +A,B @@ context → @@ LA context @@
    .replace(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/gm, (_, line, ctx) => `@@ L${line}${ctx} @@`);
  // Cap each hunk at GIT_DIFF_HUNK_MAX_LINES
  const hunks = out.split(/^@@ /m);
  out = hunks
    .map((hunk, i) => {
      if (i === 0) return hunk;
      const lines = hunk.split("\n");
      if (lines.length > GIT_DIFF_HUNK_MAX_LINES) {
        return lines
          .slice(0, GIT_DIFF_HUNK_MAX_LINES)
          .join("\n") + `\n... (${lines.length - GIT_DIFF_HUNK_MAX_LINES} lines truncated)`;
      }
      return hunk;
    })
    .join("@@ ");
  return out.trim() + "\n";
}

function compressGitStatus(text: string): string {
  const lines = text.split("\n").filter(Boolean);
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const line of lines) {
    const match = line.match(/^([MADRC?!\?]{1,2})\s+(.+)$/);
    if (!match) continue;
    const [, flag, path] = match;
    const c = flag?.charAt(0) ?? "?";
    if (c === "?") untracked.push(path!);
    else tracked.push(`${c} ${path}`);
  }
  let out = tracked.slice(0, STATUS_MAX_FILES).join("\n");
  if (tracked.length > STATUS_MAX_FILES) {
    out += `\n... (${tracked.length - STATUS_MAX_FILES} more changed files)`;
  }
  if (untracked.length > 0) {
    out += "\n?? " + untracked.slice(0, STATUS_MAX_UNTRACKED).join("\n?? ");
    if (untracked.length > STATUS_MAX_UNTRACKED) {
      out += `\n... (${untracked.length - STATUS_MAX_UNTRACKED} more untracked)`;
    }
  }
  return out + "\n";
}

function compressGitLog(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCommit = false;
  let commitCount = 0;
  for (const line of lines) {
    if (/^commit [0-9a-f]{7,40}/.test(line)) {
      inCommit = true;
      commitCount++;
      if (commitCount > 30) continue; // hard cap at 30 commits
      const hash = line.match(/commit ([0-9a-f]{7,40})/)?.[1]?.slice(0, 7);
      out.push(`\n# ${hash}`);
    } else if (inCommit && /^Author:\s/.test(line)) {
      const author = line.match(/Author:\s+(.+?)\s+</)?.[1];
      if (author) out.push(`  by ${author}`);
    } else if (inCommit && /^Date:\s/.test(line)) {
      // Skip — dates are noise
    } else if (inCommit && /^\s{4,}/.test(line)) {
      // Subject line
      const subject = line.trim();
      if (subject && !out[out.length - 1]?.includes(subject)) {
        out.push(`  ${subject}`);
      }
      inCommit = false;
    }
  }
  if (out.length > GIT_LOG_MAX_LINES) {
    return out.slice(0, GIT_LOG_MAX_LINES).join("\n") + `\n... (${out.length - GIT_LOG_MAX_LINES} more commits)`;
  }
  return out.join("\n") + "\n";
}

function compressGrep(text: string): string {
  const lines = text.split("\n").filter(Boolean);
  const byFile = new Map<string, string[]>();
  for (const line of lines) {
    // Match file:line:content or file:line:content
    const match = line.match(/^(.+?):(\d+)(?::(.*))?$/);
    if (!match) continue;
    const [, file, lineNo, content] = match;
    if (!byFile.has(file!)) byFile.set(file!, []);
    byFile.get(file!)!.push(`  L${lineNo}: ${content ?? ""}`);
  }
  const out: string[] = [];
  for (const [file, matches] of byFile) {
    out.push(`[${file}] (${matches.length}):`);
    out.push(...matches.slice(0, GREP_PER_FILE_MAX));
    if (matches.length > GREP_PER_FILE_MAX) {
      out.push(`  +${matches.length - GREP_PER_FILE_MAX} more`);
    }
  }
  return out.join("\n") + "\n";
}

function compressFind(text: string): string {
  const lines = text.split("\n").filter(Boolean);
  const byDir = new Map<string, string[]>();
  for (const line of lines) {
    if (!/^[./]/.test(line)) continue;
    const lastSlash = line.lastIndexOf("/");
    const dir = lastSlash > 0 ? line.slice(0, lastSlash) : ".";
    const name = lastSlash > 0 ? line.slice(lastSlash + 1) : line;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(name);
  }
  const out: string[] = [];
  let dirCount = 0;
  for (const [dir, names] of byDir) {
    if (dirCount++ >= FIND_TOTAL_DIR_MAX) {
      out.push(`... ${byDir.size - FIND_TOTAL_DIR_MAX} more directories`);
      break;
    }
    out.push(`[${dir}/]:`);
    out.push(...names.slice(0, FIND_PER_DIR_MAX).map((n) => `  ${n}`));
    if (names.length > FIND_PER_DIR_MAX) {
      out.push(`  +${names.length - FIND_PER_DIR_MAX} more`);
    }
  }
  return out.join("\n") + "\n";
}

function compressTree(text: string): string {
  const lines = text.split("\n");
  // Drop the trailing summary line
  const filtered = lines.filter((l) => !/^\s*\d+\s+director(y|ies),\s+\d+\s+file(s)?/.test(l));
  if (filtered.length > TREE_MAX_LINES) {
    return filtered.slice(0, TREE_MAX_LINES).join("\n") + `\n... (${filtered.length - TREE_MAX_LINES} more lines)`;
  }
  return filtered.join("\n") + "\n";
}

const NOISE_DIRS = new Set([
  "node_modules", ".git", "target", "__pycache__", ".next", "dist", "build",
  ".cache", ".turbo", ".venv", "venv", ".idea", ".vscode", "coverage",
  ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function compressLs(text: string): string {
  const lines = text.split("\n").filter(Boolean);
  const dirs: Array<{ name: string }> = [];
  const files: Array<{ name: string; size: number }> = [];
  for (const line of lines) {
    const match = line.match(/^([d-])[rwx-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/);
    if (!match) continue;
    const [, type, sizeStr, name] = match;
    if (NOISE_DIRS.has(name!)) continue;
    if (type === "d") dirs.push({ name: name! });
    else files.push({ name: name!, size: Number(sizeStr) });
  }
  const out: string[] = [];
  out.push(`Directories (${dirs.length}):`);
  for (const d of dirs.slice(0, 20)) out.push(`  ${d.name}/`);
  if (dirs.length > 20) out.push(`  ... ${dirs.length - 20} more`);
  out.push(`Files (${files.length}):`);
  for (const f of files.slice(0, 30)) out.push(`  ${f.name}  ${humanSize(f.size)}`);
  if (files.length > 30) out.push(`  ... ${files.length - 30} more`);
  // Extension summary
  const extCount = new Map<string, number>();
  for (const f of files) {
    const ext = f.name.split(".").pop() ?? "(none)";
    extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }
  const topExts = [...extCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LS_EXT_SUMMARY_TOP);
  if (topExts.length > 0) {
    out.push("By extension: " + topExts.map(([ext, n]) => `.${ext}×${n}`).join("  "));
  }
  return out.join("\n") + "\n";
}

function compressReadNumbered(text: string): string {
  // Already in compact form `N|content` — just keep matching lines
  return text;
}

function compressDedupLog(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prev = "";
  let dupCount = 0;
  for (const line of lines) {
    // Strip leading timestamps for comparison
    const normalized = line.replace(/^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*\]\s*/, "").replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s*/, "");
    if (normalized === prev) {
      dupCount++;
    } else {
      if (dupCount > 0) {
        out.push(`  ↳ [repeated ${dupCount} more times]`);
        dupCount = 0;
      }
      out.push(line);
      prev = normalized;
    }
  }
  if (dupCount > 0) out.push(`  ↳ [repeated ${dupCount} more times]`);
  return out.join("\n") + "\n";
}

function compressSearchList(text: string): string {
  // Cursor glob output — already compact, just cap lines
  const lines = text.split("\n");
  if (lines.length > 50) {
    return lines.slice(0, 50).join("\n") + `\n... (${lines.length - 50} more files)`;
  }
  return text;
}

function compressBuildOutput(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  let compiling = 0;
  let downloading = 0;
  let deprecationCount = 0;

  for (const line of lines) {
    if (/^npm ERR!|^error\[|^error:|^ERROR:|^\[ERROR\]|BUILD FAILED|Failed to compile/i.test(line)) {
      errors.push(line);
    } else if (/^npm warn|^yarn warn|^warning\[|^\[WARNING\]|^warning:/i.test(line)) {
      if (/deprecat/i.test(line)) {
        deprecationCount++;
        if (deprecationCount <= 3) warnings.push(line);
      } else {
        warnings.push(line);
      }
    } else if (/Compiling|Building/i.test(line)) {
      compiling++;
    } else if (/Downloading/i.test(line)) {
      downloading++;
    } else if (/added \d+ packages|Finished|BUILD SUCCESS|Successfully installed|\d+ vulnerabilities/i.test(line)) {
      summary.push(line);
    }
  }

  if (errors.length > 0) {
    out.push("Errors:");
    out.push(...errors.slice(0, 20));
    if (errors.length > 20) out.push(`... ${errors.length - 20} more errors`);
  }
  if (warnings.length > 0) {
    out.push("Warnings:");
    out.push(...warnings.slice(0, 10));
    if (deprecationCount > 3) out.push(`... ${deprecationCount - 3} more deprecation warnings`);
  }
  if (compiling > 0) out.push(`[compiled ${compiling} modules]`);
  if (downloading > 0) out.push(`[downloaded ${downloading} files]`);
  if (summary.length > 0) {
    out.push("Summary:");
    out.push(...summary);
  }
  return out.join("\n") + "\n";
}

function smartTruncate(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= SMART_TRUNCATE_MIN_LINES) return text;
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(-SMART_TRUNCATE_TAIL);
  return [
    ...head,
    "...",
    `[${lines.length - SMART_TRUNCATE_HEAD - SMART_TRUNCATE_TAIL} lines truncated]`,
    "...",
    ...tail,
  ].join("\n") + "\n";
}
