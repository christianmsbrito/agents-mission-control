/**
 * Extract the CLI binaries invoked in a shell command string.
 * Heuristic: split on shell separators, skip env-assignments and wrapper
 * commands, take the leading binary of each segment, drop shell builtins and
 * common coreutils so only notable tools (git, gh, kubectl, docker, …) surface.
 */

// Wrappers that precede the real command — skip to the next token.
const WRAPPERS = new Set([
  "sudo", "env", "time", "nohup", "nice", "command", "builtin", "exec", "xargs", "watch", "stdbuf",
]);

// Shell builtins + ubiquitous coreutils — too noisy to surface.
const NOISE = new Set([
  "cd", "ls", "echo", "cat", "pwd", "export", "set", "unset", "source", ".", "true", "false",
  "test", "[", "[[", "]]", "read", "printf", "alias", "type", "mkdir", "rmdir", "rm", "cp", "mv",
  "touch", "chmod", "chown", "ln", "head", "tail", "grep", "egrep", "fgrep", "rg", "sed", "awk",
  "cut", "sort", "uniq", "wc", "tr", "find", "tee", "sleep", "kill", "wait", "trap", "return",
  "exit", "for", "while", "if", "then", "else", "elif", "fi", "case", "esac", "do", "done",
  "function", "local", "eval", "dirname", "basename", "realpath", "which", "xargs", "seq", "yes",
  "continue", "break", "shift", "let", "declare", "readonly", "getopts", "pushd", "popd",
  "taskkill", "true", "false", "open", "pbcopy", "pbpaste", "date", "env",
]);

/** Split a command on top-level &&/||/;/| — ignoring separators inside quotes. */
function splitTopLevel(cmd: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      q = ch;
      cur += ch;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segs.push(cur);
      cur = "";
      i++;
      continue;
    }
    // Split on ; and | only — NOT newlines: multi-line bodies (loops, scripts)
    // would otherwise leak their inner words as bogus "CLIs".
    if (ch === ";" || ch === "|") {
      segs.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) segs.push(cur);
  return segs;
}

export function extractClis(command: string): string[] {
  // Heredoc bodies are data, not commands — drop everything from the first `<<`.
  const hd = command.indexOf("<<");
  const cmd = hd === -1 ? command : command.slice(0, hd);

  const clis = new Set<string>();
  for (const raw of splitTopLevel(cmd)) {
    const seg = raw.trim();
    if (!seg) continue;
    const tokens = seg.split(/\s+/);
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // VAR=value
      if (WRAPPERS.has(t)) { i++; continue; } // sudo/env/…
      break;
    }
    if (i >= tokens.length) continue;
    let cli = tokens[i]!.replace(/^["']|["']$/g, "");
    cli = cli.split("/").pop() || cli; // strip path
    if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(cli)) continue; // skip flags/redirs/quotes/$(…)
    if (NOISE.has(cli)) continue;
    clis.add(cli);
  }
  return [...clis];
}

/** Pull the shell command string out of a tool's input (varied shapes across agents). */
export function commandFromInput(input: any): string | null {
  if (!input) return null;
  const c = input.command ?? input.cmd ?? input.script;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.join(" "); // argv form
  return null;
}
