// How often the addon asks JavaScript to tick the attempt's VM (`setScheduler`)
// for what the database's store does to the object's state: once until the
// tick begins (it writes the output of every action issued before it), and
// anew for an action issued after. And the tick is where the store's waits
// are answered: the addon takes no notification of its own.
import { describe, expect, it } from 'vitest';
import { openOnVm } from '../src/database.ts';
import { answer, drain, startedVm, take, TYPE } from './vm-support.ts';

/** Wait until `done`: the threadsafe function's calls arrive on the event loop, when they do. */
async function until(done: () => boolean): Promise<void> {
  for (const start = Date.now(); !done();) {
    if (Date.now() - start > 10_000) throw new Error('the awaited calls did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let calls that should not come, come: the ones that did are counted after. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('the tick the addon asks for', () => {
  it('is asked for once for the actions a commit issues, and answers the commit', async () => {
    const { vm, rt } = startedVm('in', { lazy: true });
    let asked = 0;
    let groups = 0;
    // The driver's tick, by hand: the output to the runtime, its answers to
    // the VM, and the notifications taken, which hands the store its own.
    const tick = () => {
      groups += take(vm, rt).filter((m) => m.type === TYPE.atomicGroup).length;
      answer(vm, rt);
      expect(drain(vm)).toEqual([]);
    };
    vm.setScheduler(() => {
      asked++;
      setImmediate(tick);
    });
    const db = await openOnVm('tick-commit', vm, {});

    // A commit is one atomic group: its pages and its head, one request for the tick.
    asked = 0;
    await db.execute('CREATE TABLE t(x)');
    await settle();
    expect(asked).toBe(1);
    expect(groups).toBe(1);

    // An action issued once the tick began asks anew.
    asked = 0;
    await db.execute('INSERT INTO t VALUES(1)');
    await until(() => asked > 0);
    await settle();
    expect(asked).toBe(1);
    expect(groups).toBe(2);
    expect(await db.values('SELECT x FROM t')).toEqual([[1]]);
    expect(rt.objectState().some(({ key }) => key === 'v22/head')).toBe(true);
    expect(rt.violations()).toEqual([]);
  });
});
