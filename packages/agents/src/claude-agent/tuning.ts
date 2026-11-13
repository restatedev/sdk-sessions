// @internal Test knobs of the Claude Code integration: timings, how a
// steered message is given, and whether a retried turn's ending is read from
// its transcript. Not exported by the package (`./claude-agent` is index.ts
// alone): tests import this module by its path, and set them.

/**
 * @internal
 * - `idleMs`: how long a resumed Claude Code may write no message line to
 *   its transcript (it writes one as it sends the turn's request) before the
 *   attempt fails;
 * - `gateMs`: how long a tool call may wait for its call's line while Claude
 *   Code shows no progress (no message, no streamed event) before the
 *   attempt fails;
 * - `queueMs`: how long a tool call's end waits for Claude Code to queue a
 *   message steered to the turn;
 * - `steerPriority`: how a steered message is given (`'next'`: at the next
 *   step; `'later'`: after the turn, as one not queued in time would be);
 * - `readEnding`: whether a retried turn decides from its transcript how it
 *   ended (`false` rebuilds the hang that the decision prevents);
 * - `lineByLine`: the mirror stores the lines of a batch one at a time, each
 *   in a transaction of its own, as if Claude Code mirrored them so (a
 *   reply's text apart from its calls, say).
 */
export const tuning = {
  idleMs: 60_000,
  gateMs: 60_000,
  queueMs: 2_000,
  steerPriority: 'next' as 'next' | 'later',
  readEnding: true,
  lineByLine: false,
};
