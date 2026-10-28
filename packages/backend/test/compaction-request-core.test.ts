import { Agent } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

describe("request input leases (real Agent)", () => {
	it("pauses before publishing the initial input and retains it by identity", async () => {
		const stream = vi.fn();
		const agent = new Agent({ streamFn: stream as never });
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});
		agent.preparePendingRequest = async () => ({ action: "end" });
		const input = { role: "user" as const, content: "same", timestamp: 1 };
		await agent.prompt([input]);
		expect(stream).not.toHaveBeenCalled();
		expect(events).toEqual(["agent_start", "turn_start", "agent_end"]);
		expect(agent.getQueuedMessages()).toEqual([input]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("retains distinct messages with identical text, and consumes only selected identities", async () => {
		const agent = new Agent({ streamFn: vi.fn() as never });
		const a = { role: "user" as const, content: "same", timestamp: 1 };
		const b = { role: "user" as const, content: "same", timestamp: 2 };
		agent.followUp(a);
		agent.followUp(b);
		agent.retainPendingMessages([a]);
		expect(agent.getQueuedMessages()).toEqual([a, b]);
		agent.commitPendingMessages([b]);
		expect(agent.getQueuedMessages()).toEqual([a]);
	});

	it("leaves follow-ups queued when a continuation pauses", async () => {
		const agent = new Agent({
			streamFn: vi.fn() as never,
			initialState: { messages: [{ role: "user", content: "old", timestamp: 1 }] },
		});
		const queued = { role: "user" as const, content: "pending", timestamp: 2 };
		agent.followUp(queued);
		agent.preparePendingRequest = async () => ({ action: "end" });
		await agent.continue();
		expect(agent.getQueuedMessages()).toEqual([queued]);
	});

	it("commits published inputs once when final preparation throws a normal request error", async () => {
		const stream = vi.fn();
		const agent = new Agent({
			streamFn: stream as never,
			initialState: { messages: [{ role: "user", content: "earlier input", timestamp: 0 }] },
		});
		const queued = { role: "user" as const, content: "queued requirement", timestamp: 1 };
		agent.steer(queued);
		agent.preparePendingRequest = async (request) => ({ pendingMessages: request.pendingMessages });
		agent.prepareRequest = async () => {
			throw new Error("401 router rejected");
		};
		await agent.continue();
		expect(stream).not.toHaveBeenCalled();
		expect(agent.getQueuedMessages()).toEqual([]);
		expect(agent.state.messages.filter((message) => message === queued)).toHaveLength(1);
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "401 router rejected",
		});
		expect(agent.state.isStreaming).toBe(false);
	});

	it("retains the lease without synthesizing an error when final preparation rejects after cancellation", async () => {
		const stream = vi.fn();
		const agent = new Agent({ streamFn: stream as never });
		const input = { role: "user" as const, content: "cancelled requirement", timestamp: 1 };
		agent.preparePendingRequest = async () => undefined;
		agent.prepareRequest = async () => {
			agent.abort();
			throw new Error("late rejection");
		};
		await agent.prompt([input]);
		expect(stream).not.toHaveBeenCalled();
		expect(agent.getQueuedMessages()).toEqual([input]);
		expect(agent.state.messages).toEqual([input]);
		expect(agent.state.isStreaming).toBe(false);
	});
});
