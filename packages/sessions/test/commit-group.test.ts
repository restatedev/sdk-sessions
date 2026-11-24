// A commit on the attempt's VM is one atomic group, built in the addon in one
// critical section: its writes, then what its transaction gave `commitWith`
// (its sends), named `commit`, its result the commit. Nothing calls back into
// JavaScript on the way, so nothing else the attempt does can land inside it.
import { expect, it } from 'vitest';
import { AttemptDriver } from '../src/driver.ts';
import { openOnVm } from '../src/database.ts';
import { ACTION, members, num, str } from './wire.ts';
import { messages, startedVm, TYPE, type Message } from './vm-support.ts';

/** An attempt whose Restate, the fake runtime, applies and answers what it writes. */
function attempt() {
  const { vm, rt } = startedVm('in');
  const sent: Message[] = [];
  const driver = new AttemptDriver(
    vm,
    (chunk: Uint8Array) => {
      sent.push(...messages(chunk));
      rt.receive(chunk);
      const answer = rt.takeOutput();
      if (answer.length > 0) queueMicrotask(() => driver.notifyInput(answer));
    },
    { service: 'Probe', handler: 'run' },
  );
  vm.setScheduler(() => driver.scheduleTick());
  return { vm, rt, sent };
}

const mail = (body: string) => ({
  target: { service: 'Mail', handler: 'notify', key: body },
  input: new TextEncoder().encode(JSON.stringify(body)),
  name: 'Mail/notify',
});

/** The commits among `sent`: atomic groups whose result is wanted. */
const commits = (sent: Message[]) => sent.filter((m) => m.type === TYPE.atomicGroup && num(m, ACTION.resultId) > 0);

it("a transaction's sends go inside its commit's group, after its writes", async () => {
  const { vm, rt, sent } = attempt();
  const db = await openOnVm('group-sends', vm, {});
  await db.execute('CREATE TABLE t(x)');
  sent.length = 0;
  await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO t VALUES(1)');
    tx.commitWith({ sends: [mail('a'), mail('b')] });
  });
  const [commit, ...more] = commits(sent);
  expect(more).toEqual([]);
  expect(str(commit!, ACTION.name)).toBe('commit');
  const inside = members(commit!);
  expect(inside.slice(-2).map((m) => [m.type, str(m, 3)])).toEqual([
    [TYPE.call, 'a'],
    [TYPE.call, 'b'],
  ]);
  expect(inside.slice(0, -2).every((m) => m.type === TYPE.setState || m.type === TYPE.clearState)).toBe(true);
  expect(rt.calls().map((c) => c.key)).toEqual(['a', 'b']);
  expect(rt.violations()).toEqual([]);
});

it('a transaction that writes nothing makes its sends in a group of their own, and resolves once it is applied', async () => {
  const { vm, rt, sent } = attempt();
  const db = await openOnVm('group-alone', vm, {});
  sent.length = 0;
  await db.transaction(async (tx) => {
    await tx.values('SELECT 1');
    tx.commitWith({ sends: [mail('c')] });
  });
  const [commit] = commits(sent);
  expect(members(commit!).map((m) => m.type)).toEqual([TYPE.call]);
  expect(rt.calls().map((c) => c.key)).toEqual(['c']);
});

it('a transaction that rolls back, or whose COMMIT is refused, sends nothing; the next decides for itself', async () => {
  const { vm, rt, sent } = attempt();
  const db = await openOnVm('group-rollback', vm, {});
  await db.execute('CREATE TABLE p(id INTEGER PRIMARY KEY)');
  sent.length = 0;
  await expect(
    db.transaction(async (tx) => {
      await tx.execute('INSERT INTO p VALUES(1)');
      tx.commitWith({ sends: [mail('rolled back')] });
      throw new Error('abort');
    }),
  ).rejects.toThrow('abort');
  await expect(
    db.transaction(async (tx) => {
      await tx.execute('INSERT INTO p VALUES(1)');
      await tx.execute('INSERT INTO p VALUES(1)');
      tx.commitWith({ sends: [mail('refused')] });
    }),
  ).rejects.toThrow(/constraint|UNIQUE|unique/i);
  expect(rt.calls()).toEqual([]);
  await db.transaction(async (tx) => tx.execute('INSERT INTO p VALUES(2)'));
  expect(commits(sent).every((c) => members(c).every((m) => m.type !== TYPE.call))).toBe(true);
  expect(await db.values('SELECT id FROM p')).toEqual([[2]]);
  expect(rt.calls()).toEqual([]);
});

it("a commit's group is inside the span its transaction gave", async () => {
  const { vm, sent } = attempt();
  const db = await openOnVm('group-span', vm, {});
  const span = vm.spanStart('transaction');
  sent.length = 0;
  await db.transaction(async (tx) => {
    await tx.execute('CREATE TABLE s(x)');
    tx.commitWith({ sends: [mail('d')], parentSpan: span });
  });
  const [commit] = commits(sent);
  expect(num(commit!, ACTION.parentSpan)).toBe(span);
  // Its send is in the span too.
  expect(num(members(commit!).at(-1)!, ACTION.parentSpan)).toBe(span);
});
