// Messages steered to an agentlib turn (the `steer` view), handed to
// agentlib's run as its steering.
import type { ProgressEvent, SteeringUpdate } from '@restatedev/agentlib';
import { channel, type Channel, type Future, type Operation } from '@restatedev/restate-sdk-gen';
import type { Published, Steer } from '../companion.ts';

/**
 * The messages steered to a turn. The turn learns of them when it publishes
 * a change to its companion, which answers with the messages it holds for
 * the turn. They go to the run, all at once, as one steering update, at the
 * run's next progress event after it asks for one.
 */
export class Steering {
  private next?: Channel<string | SteeringUpdate>;
  private waiting: Steer[] = [];
  private readonly handed = new Set<string>();

  /** agentlib's `controls.steering`: the next steering update, once there is one. */
  readonly source = (): Future<string | SteeringUpdate> => {
    this.next = channel<string | SteeringUpdate>();
    return this.next.receive;
  };

  /** Notes the messages that a publish (or the turn's start) says are steered to the turn. */
  saw(published: Published | undefined) {
    for (const steer of published?.steering ?? []) {
      const known = this.handed.has(steer.id) || this.waiting.some((s) => s.id === steer.id);
      if (!known) this.waiting.push(steer);
    }
  }

  /** Hands the waiting messages to the run, if it asked for an update. */
  *hand(): Operation<void> {
    const next = this.next;
    if (!next || this.waiting.length === 0) return;

    const batch = this.waiting.splice(0);
    for (const { id } of batch) this.handed.add(id);
    this.next = undefined;

    const message = batch.map((steer) => steer.text).join('\n\n');
    const ids = batch.map((steer) => steer.id);
    yield* next.send({ message, data: { steer: ids } });
  }
}

/** Returns the ids of the steered messages that a `steering` event says the run took. */
export function takenIds(event: ProgressEvent): string[] {
  if (event.type !== 'steering') return [];
  const ids = (event.data as { steer?: unknown } | undefined)?.steer;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}
