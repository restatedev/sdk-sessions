// Claude Code's process, as the integration starts it: killed with SIGKILL
// when its run ends, and, on Linux with `setpriv` (util-linux), killed by the
// kernel when this process dies (its parent-death signal), so that a crashed
// handler's process leaves no Claude Code going on with the turn alone.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

/** `setpriv`, if this machine has it: a parent that dies takes Claude Code along. */
const SETPRIV = ['/usr/bin/setpriv', '/bin/setpriv'].find((path) => process.platform === 'linux' && existsSync(path));

/** Whether Claude Code dies with this process (see the module's comment). */
export const tied = SETPRIV !== undefined;

/** Start `command` with `args`, tied to this process's life where it can be. */
export function spawnTied(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): ChildProcess {
  const [file, argv] = SETPRIV ? [SETPRIV, ['--pdeathsig', 'SIGKILL', '--', command, ...args]] : [command, args];
  const child = spawn(file, argv, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', () => {});
  return child;
}
