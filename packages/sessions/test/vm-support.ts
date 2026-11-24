// Restate's side of one attempt on the explicit recovery protocol, played by
// the core's fake runtime (`fake.ts`), for the tests of the binding
// (`vm.test.ts`, `vm-tick.test.ts`) and of the driver (`driver.test.ts`): the
// VM is fed the bytes the runtime writes, and the runtime the bytes the VM
// writes, a step at a time, as the test says.
import { Vm, type VmNotification } from '../src/vm.ts';
import { FakeRuntime, type FakeInvocation } from './fake.ts';
import { messages, type Message } from './wire.ts';

export { TYPE } from './wire.ts';

/** The content type of the protocol's invocations, version 1. */
export const CONTENT_TYPE = 'application/vnd.restate.invocation.explicitrecovery.v1';

/** The content type of the durable execution protocol's V8, which this VM refuses. */
export const V8 = 'application/vnd.restate.invocation.v8';

/** A fake runtime of one invocation for `thekey`, with `input` (as JSON), and `state` in the object. */
export function runtime(
  input: unknown,
  { lazy = false, state = {}, ...invocation }: { lazy?: boolean; state?: Record<string, string> } & FakeInvocation = {},
): FakeRuntime {
  const rt = new FakeRuntime({
    invocationId: 'inv_test',
    key: 'thekey',
    input: new TextEncoder().encode(JSON.stringify(input)),
    objectPreload: lazy ? 'lazy' : 'all',
    ...invocation,
  });
  for (const [key, value] of Object.entries(state)) rt.setObjectState(key, new TextEncoder().encode(value));
  return rt;
}

/** A VM, as Restate opens an attempt: its request's headers. */
export const newVm = () => new Vm(FakeRuntime.requestHeaders());

/**
 * A VM started by a fake runtime for `thekey` with `input`, and ready to
 * execute; `lazy`, the object's state is not preloaded.
 */
export function startedVm(
  input: unknown,
  options: { lazy?: boolean; state?: Record<string, string> } & FakeInvocation = {},
): { vm: Vm; rt: FakeRuntime } {
  const rt = runtime(input, options);
  const vm = newVm();
  vm.notifyInput(rt.startAttempt());
  return { vm, rt };
}

/** Every notification the VM has ready now: what the driver's tick takes. */
export function drain(vm: Vm): VmNotification[] {
  const out: VmNotification[] = [];
  for (let n = vm.takeNotification(); n !== null; n = vm.takeNotification()) out.push(n);
  return out;
}

/** The VMs whose input the runtime closed already. */
const closedInput = new WeakSet<Vm>();

/** What the runtime wrote, to the VM; and its close, once it closed its side. */
export function answer(vm: Vm, rt: FakeRuntime): void {
  const output = rt.takeOutput();
  if (output.length > 0) vm.notifyInput(output);
  if (rt.isClosed() && !closedInput.has(vm)) {
    closedInput.add(vm);
    vm.notifyInputClosed();
  }
}

/** What the VM wrote, to the runtime, which applies it: the messages. */
export function take(vm: Vm, rt: FakeRuntime): Message[] {
  const output = vm.takeOutput();
  rt.receive(output);
  return messages(output);
}

/** The types of the messages in `output`, in order. */
export const types = (output: Uint8Array): number[] => messages(output).map((m) => m.type);

export { messages, type Message };
