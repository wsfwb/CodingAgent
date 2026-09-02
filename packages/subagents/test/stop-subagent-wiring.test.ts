import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.ts")>("../src/agent-runner.ts");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.ts";
import subagentsExtension from "../src/index.ts";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (result: any): string => result.content[0].text;

async function spawnBackground(tools: Map<string, any>, description: string, signal?: AbortSignal) {
  const result = await tools.get("Agent").execute(
    `spawn-${description}`,
    { prompt: "keep working", description, subagent_type: "general-purpose", run_in_background: true },
    signal,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(result))?.[1] as string;
}

describe("stop_subagent tool wiring", () => {
  const shutdowns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (shutdowns.length) await shutdowns.pop()?.();
    vi.restoreAllMocks();
  });

  it("stops a specific background agent", async () => {
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      childSignal = options.signal;
      return new Promise(() => {});
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    shutdowns.push(async () => lifecycle.get("session_shutdown")?.({}, ctx()));

    const id = await spawnBackground(tools, "long task");
    const result = await tools.get("stop_subagent").execute(
      "stop-one",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toContain(`Stopped agent ${id}`);
    expect(childSignal?.aborted).toBe(true);
  });

  it("cascades a hard parent abort to a background agent", async () => {
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      childSignal = options.signal;
      return new Promise(() => {});
    });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    shutdowns.push(async () => lifecycle.get("session_shutdown")?.({}, ctx()));
    const parent = new AbortController();

    await spawnBackground(tools, "abort with parent", parent.signal);
    expect(childSignal?.aborted).toBe(false);

    parent.abort();
    expect(childSignal?.aborted).toBe(true);
  });

  it("stops every running and queued background agent", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    shutdowns.push(async () => lifecycle.get("session_shutdown")?.({}, ctx()));

    await spawnBackground(tools, "first task");
    await spawnBackground(tools, "second task");
    const result = await tools.get("stop_subagent").execute(
      "stop-all",
      { all: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toMatch(/Stopped 2 running or queued subagents/);
  });

  it("requires exactly one stop target", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    shutdowns.push(async () => lifecycle.get("session_shutdown")?.({}, ctx()));

    const neither = await tools.get("stop_subagent").execute("none", {}, undefined, undefined, ctx());
    const both = await tools.get("stop_subagent").execute(
      "both",
      { agent_id: "abc", all: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(neither)).toContain("exactly one");
    expect(textOf(both)).toContain("exactly one");
  });
});
