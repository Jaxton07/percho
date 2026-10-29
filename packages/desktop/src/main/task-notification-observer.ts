import {
	type EnvironmentRef,
	environmentKey,
	reduceTaskRun,
	type SessionEventEnvelope,
	type SessionMeta,
	type TaskNotificationTarget,
	type TaskRunState,
} from "@percho/shared";

interface Ports {
	enabled(): boolean;
	background(): boolean;
	ready(): Promise<void>;
	send(kind: "completed" | "failed", target: TaskNotificationTarget, valid: () => boolean): Promise<unknown>;
}
interface Run {
	state: TaskRunState;
	target: Promise<TaskNotificationTarget | undefined>;
	valid: () => boolean;
}
/** Main-owned bounded per-session observation; no messages or history are retained. */
export class TaskNotificationObserver {
	private runs = new Map<string, Run>();
	private sequences = new Map<string, number>();
	private epochs = new Map<string, number>();
	private deletions = new Map<string, object>();
	private stopped = false;
	constructor(private readonly ports: Ports) {}
	observe(
		environment: EnvironmentRef,
		payload: SessionEventEnvelope,
		getMeta: () => SessionMeta | undefined | Promise<SessionMeta | undefined>,
	) {
		if (this.stopped) return;
		const key = JSON.stringify([environmentKey(environment), payload.sessionId]);
		if (payload.sequence !== undefined) {
			if (payload.sequence <= (this.sequences.get(key) ?? -1)) return;
			this.sequences.set(key, payload.sequence);
		}
		let run = this.runs.get(key);
		const next = reduceTaskRun(run?.state, payload.event);
		if (!run && next.state) {
			const envKey = environmentKey(environment),
				epoch = this.epochs.get(envKey) ?? 0;
			const marker = this.deletions.get(key) ?? {};
			this.deletions.set(key, marker);
			const valid = () =>
				!this.stopped && this.deletions.get(key) === marker && (this.epochs.get(envKey) ?? 0) === epoch;
			const target = Promise.resolve()
				.then(getMeta)
				.then((meta) =>
					meta && !meta.readOnly
						? { environment, sessionId: meta.sessionId, sessionFile: meta.sessionFile }
						: undefined,
				)
				.catch(() => undefined);
			run = { state: next.state, target, valid };
			this.runs.set(key, run);
			return;
		}
		if (!run) return;
		if (next.state) {
			run.state = next.state;
			return;
		}
		this.runs.delete(key);
		if (!next.outcome || !this.ports.enabled() || !this.ports.background()) return;
		const outcome = next.outcome;
		const finished = run;
		void Promise.all([finished.target, this.ports.ready()])
			.then(([target]) => {
				if (target && finished.valid() && this.ports.enabled() && this.ports.background())
					return this.ports.send(outcome, target, finished.valid);
			})
			.catch(() => {});
	}
	unload(environment: EnvironmentRef, sessionId: string) {
		// GC releases running state and its sequence counter; file-backed click targets remain valid.
		const key = JSON.stringify([environmentKey(environment), sessionId]);
		this.runs.delete(key);
		this.sequences.delete(key);
	}
	delete(environment: EnvironmentRef, sessionId: string) {
		const key = JSON.stringify([environmentKey(environment), sessionId]);
		this.runs.delete(key);
		this.sequences.delete(key);
		this.deletions.delete(key);
	}
	detach(environment: EnvironmentRef) {
		const key = environmentKey(environment);
		this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
		for (const session of this.deletions.keys())
			if (JSON.parse(session)[0] === key) {
				this.runs.delete(session);
				this.sequences.delete(session);
				this.deletions.delete(session);
			}
	}
	stop() {
		this.stopped = true;
		this.runs.clear();
		this.sequences.clear();
		this.deletions.clear();
		this.epochs.clear();
	}
}
