// The attempt's VM (`src/vm.ts`, `native/src/vm.rs`) against the core's fake
// runtime: shared-core's explicit recovery state machine, fed the bytes
// Restate would send, and the bytes it writes read back and checked by the
// fake. Nothing of @restatedev/sessions stands between, and no SDK: this is
// the binding alone.
import { describe, expect, it } from 'vitest';
import { explicitRecoveryProtocolRange, isShutDown, refusedStatus, Vm } from '../src/vm.ts';
import { ACTION, members, num, RECORD, str } from './wire.ts';
import { answer, CONTENT_TYPE, drain, newVm, runtime, startedVm, take, TYPE, V8 } from './vm-support.ts';

/** The fake found nothing wrong in what the VM sent. */
const clean = (rt: { violations(): string[] }) => expect(rt.violations()).toEqual([]);

describe('the attempt VM on the explicit recovery protocol', () => {
  it('negotiates the protocol and answers a response head', () => {
    const vm = newVm();
    expect(vm.getResponseHead()).toEqual({
      statusCode: 200,
      headers: [{ key: 'content-type', value: CONTENT_TYPE }],
    });
    expect(vm.state()).toBe('starting');
    expect(explicitRecoveryProtocolRange()).toEqual({ minVersion: 1, maxVersion: 1 });
  });

  it('refuses another family or version with 415, the status to answer', () => {
    for (const type of [V8, 'application/vnd.restate.invocation.explicitrecovery.v2', 'text/plain']) {
      let refused: unknown;
      try {
        expect(new Vm([{ key: 'content-type', value: type }])).toBeUndefined();
      } catch (error) {
        refused = error;
      }
      expect(refusedStatus(refused)).toBe(415);
    }
  });

  it('is ready once the start is in, and gives the input and the attempt', () => {
    const rt = runtime('hello');
    const vm = newVm();
    expect(vm.isReadyToExecute()).toBe(false);
    vm.notifyInput(rt.startAttempt());
    expect(vm.isReadyToExecute()).toBe(true);
    const input = vm.input();
    expect(input.invocationId).toBe('inv_test');
    expect(input.key).toBe('thekey');
    expect(input.attempt).toBe(1);
    expect(Buffer.from(input.input).toString()).toBe('"hello"');
    expect(vm.state()).toBe('running');
  });

  it('a state value the invocation knows completes at once, asking Restate nothing', () => {
    const { vm } = startedVm('hello', { state: { greeting: '"hi"' } });
    const handle = vm.getState('object', 'greeting');
    expect(drain(vm)).toEqual([{ handle, kind: 'success', bytes: Buffer.from('"hi"') }]);
    expect(vm.takeOutput()).toHaveLength(0);
  });

  it('a state value a complete state does not hold completes as void', () => {
    const { vm } = startedVm('hello');
    const handle = vm.getState('object', 'missing');
    expect(drain(vm)).toEqual([{ handle, kind: 'void' }]);
    expect(vm.takeOutput()).toHaveLength(0);
  });

  it('a state value of a partial state is read from Restate, and its result notifies the handle', () => {
    const { vm, rt } = startedVm('hello', { lazy: true, state: { greeting: '"hi"' } });
    const handle = vm.getState('object', 'greeting', { record: 'none' });
    expect(drain(vm)).toEqual([]);
    const [read] = take(vm, rt);
    expect(read?.type).toBe(TYPE.getState);
    expect(str(read!, 2)).toBe('greeting');
    expect(num(read!, ACTION.record)).toBe(RECORD.none);
    answer(vm, rt);
    expect(drain(vm)).toEqual([{ handle, kind: 'success', bytes: Buffer.from('"hi"') }]);
    clean(rt);
  });

  it('a write wants its result only if asked, and gets it once Restate applied it', () => {
    const { vm, rt } = startedVm('hello');
    const wanted = vm.setState('object', 'a', Buffer.from('1'), true);
    const unwanted = vm.setState('object', 'b', Buffer.from('2'));
    expect(wanted).toBeTypeOf('number');
    expect(unwanted).toBeNull();
    expect(take(vm, rt).map((m) => m.type)).toEqual([TYPE.setState, TYPE.setState]);
    answer(vm, rt);
    expect(drain(vm)).toEqual([{ handle: wanted, kind: 'void' }]);
    expect(rt.objectState().map(({ key }) => key)).toEqual(['a', 'b']);
    clean(rt);
  });

  it('a value written by the attempt is read back without asking Restate', () => {
    const { vm, rt } = startedVm('hello', { lazy: true });
    vm.setState('object', 'greeting', Buffer.from('"hi"'));
    take(vm, rt);
    const handle = vm.getState('object', 'greeting');
    expect(drain(vm)).toEqual([{ handle, kind: 'success', bytes: Buffer.from('"hi"') }]);
    expect(vm.takeOutput()).toHaveLength(0);
  });

  it('an atomic group leaves as one action, with its own result', () => {
    const { vm, rt } = startedVm('hello');
    vm.atomicGroupStart();
    vm.setState('object', 'row', Buffer.from('r'), false, { record: 'none' });
    const sent = vm.send({ service: 'Mail', handler: 'notify', key: 'a' }, Buffer.from('"m"'));
    const group = vm.atomicGroupEnd(true, { name: 'commit' });
    const [message, ...rest] = take(vm, rt);
    expect(rest).toEqual([]);
    expect(message?.type).toBe(TYPE.atomicGroup);
    expect(str(message!, ACTION.name)).toBe('commit');
    expect(members(message!).map((m) => m.type)).toEqual([TYPE.setState, TYPE.call]);
    answer(vm, rt);
    const notified = drain(vm);
    expect(notified).toContainEqual({ handle: group, kind: 'void' });
    expect(notified.find((n) => n.handle === sent)?.kind).toBe('invocationId');
    expect(rt.calls().map((c) => `${c.service}/${c.handler}`)).toEqual(['Mail/notify']);
    clean(rt);
  });

  it('an aborted group sends nothing, and returns the handles never notified', () => {
    const { vm, rt } = startedVm('hello');
    vm.atomicGroupStart();
    vm.setState('object', 'row', Buffer.from('r'));
    const sent = vm.send({ service: 'Mail', handler: 'notify', key: 'a' }, Buffer.from('"m"'));
    expect(vm.atomicGroupAbort()).toEqual([sent]);
    expect(vm.takeOutput()).toHaveLength(0);
    expect(rt.objectState()).toEqual([]);
  });

  it('the cancel signal is a notification on the reserved handle, and isCancelled once taken', () => {
    const { vm, rt } = startedVm('hello');
    expect(vm.isCancelled()).toBe(false);
    rt.cancel();
    answer(vm, rt);
    expect(vm.isCancelled()).toBe(false);
    expect(drain(vm)).toEqual([{ handle: vm.cancelHandle(), kind: 'void' }]);
    expect(vm.cancelHandle()).toBe(1);
    expect(vm.isCancelled()).toBe(true);
  });

  it('an attempt of a cancelled invocation knows from the start', () => {
    const rt = runtime('hello');
    rt.startAttempt();
    rt.loseAttempt();
    rt.cancel();
    const vm = newVm();
    vm.notifyInput(rt.startAttempt());
    expect(vm.input().attempt).toBe(2);
    expect(vm.isCancelled()).toBe(true);
    expect(drain(vm)).toEqual([]);
  });

  it('a signal read waits for the signal, which its arrival answers', () => {
    const { vm, rt } = startedVm('hello');
    const handle = vm.signalRead('approval', 0);
    take(vm, rt);
    answer(vm, rt);
    expect(drain(vm)).toEqual([]);
    rt.sendSignal('approval', { bytes: Buffer.from('"yes"') });
    answer(vm, rt);
    expect(drain(vm)).toEqual([{ handle, kind: 'success', bytes: Buffer.from('"yes"') }]);
    clean(rt);
  });

  it('invocation state is the invocation own, apart from the object', () => {
    const { vm, rt } = startedVm('hello');
    vm.setState('invocation', 'step', Buffer.from('reserved'));
    const flushed = vm.flush();
    take(vm, rt);
    answer(vm, rt);
    expect(drain(vm)).toEqual([{ handle: flushed, kind: 'void' }]);
    expect(rt.invocationState().map(({ key, value }) => [key, value.toString()])).toEqual([['step', 'reserved']]);
    expect(rt.objectState()).toEqual([]);
    clean(rt);
  });

  it('spans nest, and actions name the span they are inside of', () => {
    const { vm, rt } = startedVm('hello');
    const turn = vm.spanStart('turn');
    const model = vm.spanStart('model', turn);
    vm.call({ service: 'Model', handler: 'generate' }, Buffer.from('"p"'), undefined, {
      name: 'generate',
      parentSpan: model,
    });
    vm.spanEnd(model, Buffer.from('"done"'));
    vm.spanEnd(turn, null, { code: 500, message: 'the turn failed', metadata: [] });
    const sent = take(vm, rt);
    expect(sent.map((m) => m.type)).toEqual([TYPE.spanStart, TYPE.spanStart, TYPE.call, TYPE.spanEnd, TYPE.spanEnd]);
    expect(str(sent[0]!, ACTION.name)).toBe('turn');
    expect(num(sent[1]!, ACTION.parentSpan)).toBe(turn);
    expect(str(sent[2]!, ACTION.name)).toBe('generate');
    expect(num(sent[2]!, ACTION.parentSpan)).toBe(model);
    clean(rt);
  });

  it('end writes the output, and the response closes after the runtime closed its side', () => {
    const { vm, rt } = startedVm('hello');
    vm.endSuccess(Buffer.from('"done"'));
    expect(take(vm, rt).map((m) => m.type)).toEqual([TYPE.end]);
    expect(vm.state()).toBe('closed');
    expect(vm.shouldCloseOutput()).toBe(false);
    answer(vm, rt);
    expect(vm.shouldCloseOutput()).toBe(true);
    rt.sdkClosed();
    expect(rt.status()).toEqual({ status: 'completed', output: { kind: 'success', bytes: Buffer.from('"done"') } });
    clean(rt);
  });

  it('closing the input while the handler runs shuts the attempt down, saying what it processed', () => {
    const { vm, rt } = startedVm('hello', { lazy: true });
    vm.getState('object', 'greeting');
    take(vm, rt);
    rt.shutDown('own');
    answer(vm, rt);
    expect(take(vm, rt).map((m) => m.type)).toEqual([TYPE.shutdown]);
    let thrown: unknown;
    try {
      drain(vm);
    } catch (error) {
      thrown = error;
    }
    expect(isShutDown(thrown)).toBe(true);
    expect(vm.state()).toBe('closed');
    expect(vm.shouldCloseOutput()).toBe(true);
    rt.sdkClosed();
    expect(rt.outcomes()).toEqual([{ kind: 'restarted', rule: 1 }]);
    clean(rt);
  });

  it('an attempt the SDK ends on its own (SIGTERM) is an unasked shutdown: restarted, no retry counted', () => {
    const { vm, rt } = startedVm('hello');
    vm.shutdown();
    expect(take(vm, rt).map((m) => m.type)).toEqual([TYPE.shutdown]);
    expect(vm.state()).toBe('closed');
    answer(vm, rt);
    rt.sdkClosed();
    expect(rt.outcomes().map((o) => o.kind)).toEqual(['restarted']);
    clean(rt);
  });

  it('a handler that fails the attempt writes an error, and ends no invocation', () => {
    const { vm, rt } = startedVm('hello');
    vm.notifyError('the model is down', 'at model.ts:1');
    expect(take(vm, rt).map((m) => m.type)).toEqual([TYPE.error]);
    expect(vm.state()).toBe('closed');
    answer(vm, rt);
    rt.sdkClosed();
    expect(rt.outcomes().map((o) => o.kind)).toEqual(['failed']);
    expect(rt.status().status).toBe('ready');
  });
});
