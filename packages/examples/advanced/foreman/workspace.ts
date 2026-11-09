/**
 * What the boss checks for itself, in the workspace the agents work in: the brief's verification
 * command, and what git says changed. These are the signals the cascade promotes on, read by the
 * boss and never taken from the worker's report.
 *
 * Like the agents' coding tools, they run on this machine, not in a sandbox.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

/** A command's outcome: its exit code (null if it didn't finish) and the end of its combined output. */
export interface CheckRun {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/** The last `max` characters of `text`, marked as cut if they are. */
const tail = (text: string, max: number) =>
  text.length <= max ? text : `[…${text.length - max} characters cut]\n${text.slice(-max)}`;

/** Run the brief's verification `command` with bash in `cwd`, killed after `timeoutSeconds`. */
export function runCommand(command: string, cwd: string, timeoutSeconds = 600): Promise<CheckRun> {
  return new Promise((resolve) => {
    // stdout and stderr in one stream, in the order the command wrote them.
    const child = spawn('bash', ['-c', `{ ${command}\n} 2>&1`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      // Keep twice the tail while it runs, so a chatty command doesn't grow this without bound.
      output = (output + chunk.toString()).slice(-6000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, output: String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const end = tail(output, 3000);
      resolve({
        exitCode: code,
        timedOut,
        output: timedOut ? `${end}\n(killed: no exit after ${timeoutSeconds} s)` : end,
      });
    });
  });
}

const execGit = promisify(execFile);

/** git's output in `cwd`, or null if git failed. */
async function git(cwd: string, ...args: string[]) {
  try {
    return (await execGit('git', args, { cwd, maxBuffer: 16 << 20 })).stdout;
  } catch {
    return null;
  }
}

const lines = (text: string | null) => (text ?? '').split('\n').filter(Boolean);

/** What changed in `cwd` since its last commit: the files (tracked and new), and git's diff stat. Null outside a git repository. */
export async function changes(cwd: string): Promise<{ files: string[]; stat: string } | null> {
  if ((await git(cwd, 'rev-parse', '--verify', 'HEAD')) === null) return null;
  const tracked = lines(await git(cwd, 'diff', '--name-only', '--relative', 'HEAD'));
  const added = lines(await git(cwd, 'ls-files', '--others', '--exclude-standard'));
  const stat = ((await git(cwd, 'diff', '--stat', '--relative', 'HEAD')) ?? '').trim();
  return {
    files: [...tracked, ...added],
    stat: [stat, ...added.map((f) => ` ${f} (new)`)].filter(Boolean).join('\n') || '(no changes)',
  };
}

/** The diff of `cwd` since its last commit, new files included, at most `max` characters. */
export async function diffOf(cwd: string, max = 40_000): Promise<string> {
  if ((await git(cwd, 'rev-parse', '--verify', 'HEAD')) === null) {
    return '(the workspace is not a git repository: no diff)';
  }
  let diff = (await git(cwd, 'diff', '--relative', 'HEAD')) ?? '';
  for (const file of lines(await git(cwd, 'ls-files', '--others', '--exclude-standard'))) {
    // `git diff --no-index` exits 1 when the files differ, which they always do here: keep its output anyway.
    diff += await execGit('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd }).then(
      (r) => r.stdout,
      (error: { stdout?: string }) => error.stdout ?? '',
    );
  }
  if (!diff) return '(no changes)';
  return diff.length <= max ? diff : `${diff.slice(0, max)}\n[…${diff.length - max} characters cut]`;
}
