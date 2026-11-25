/** Undo/redo over whole-drawing snapshots. Callers record the state from
 * *before* each change; stepping back hands that state back (and keeps the
 * current one so the step can be redone). */
export class History<T> {
	private readonly past: T[] = [];
	private readonly future: T[] = [];

	constructor(private readonly limit: number) {}

	/** Remembers `before` as an undo step. A new change ends any redo chain. */
	record(before: T): void {
		this.past.push(before);
		if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
		this.future.length = 0;
	}

	/** Forgets the latest step (its change turned out to be a no-op). */
	dropLatest(): void {
		this.past.pop();
	}

	/** The state to restore for an undo, or undefined if there is none. */
	back(current: T): T | undefined {
		return this.step(this.past, this.future, current);
	}

	/** The state to restore for a redo, or undefined if there is none. */
	forward(current: T): T | undefined {
		return this.step(this.future, this.past, current);
	}

	private step(from: T[], to: T[], current: T): T | undefined {
		if (from.length === 0) return undefined;
		to.push(current);
		return from.pop();
	}
}
