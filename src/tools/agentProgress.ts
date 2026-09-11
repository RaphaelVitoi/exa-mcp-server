import type { AgentEvent } from "exa-js";

export const DEFAULT_PROGRESS_THROTTLE_MS = 1_000;

type ToolActivity = {
  name: string;
  started: boolean;
  finished: boolean;
};

export type AgentProgressState = {
  runId: string | null;
  startedAt: number;
  lastMeaningfulAt: number;
  sourcesFound: number;
  sourcesByCallId: Map<string, number>;
  toolsByCallId: Map<string, ToolActivity>;
  latestNarrationByCallId: Map<string, string>;
  latestNarration: string | null;
  latestPreliminaryList: { round: number; entryCount: number } | null;
  lastActivity: string;
};

export type AgentProgressUpdate = {
  state: AgentProgressState;
  kind: "immediate" | "coalesced" | "ignored";
  message?: string;
};

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventData(event: AgentEvent): RecordValue | undefined {
  return asRecord(event.data);
}

function itemCallId(item: RecordValue): string | undefined {
  return stringValue(item.call_id) ?? stringValue(item.callId);
}

function itemParentCallId(item: RecordValue): string | undefined {
  return stringValue(item.parent_call_id) ?? stringValue(item.parentCallId);
}

function addSource(state: AgentProgressState, callId: string | undefined): void {
  if (callId === undefined) {
    state.sourcesFound += 1;
    return;
  }
  const nextCount = (state.sourcesByCallId.get(callId) ?? 0) + 1;
  state.sourcesByCallId.set(callId, nextCount);
  state.sourcesFound += 1;
}

function toolActivityLabel(tool: string, suffix: "started" | "finished"): string {
  return `${tool} ${suffix}`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function createAgentProgressState(
  runId: string | null = null,
  now = Date.now(),
): AgentProgressState {
  return {
    runId,
    startedAt: now,
    lastMeaningfulAt: now,
    sourcesFound: 0,
    sourcesByCallId: new Map(),
    toolsByCallId: new Map(),
    latestNarrationByCallId: new Map(),
    latestNarration: null,
    latestPreliminaryList: null,
    lastActivity: "run started",
  };
}

type ProgressContext = {
  state: AgentProgressState;
  data: RecordValue | undefined;
  eventName: string;
  now: number;
};

type ProgressEventHandler = (ctx: ProgressContext) => AgentProgressUpdate;

function handleRunCreated({ state, now }: ProgressContext): AgentProgressUpdate {
  state.lastMeaningfulAt = now;
  state.lastActivity = "run queued";
  return {
    state,
    kind: "immediate",
    message: `run ${state.runId ?? "pending"} queued`,
  };
}

function handleRunStarted({ state, now }: ProgressContext): AgentProgressUpdate {
  state.lastMeaningfulAt = now;
  state.lastActivity = "run started";
  return {
    state,
    kind: "immediate",
    message: `run ${state.runId ?? "pending"} started`,
  };
}

function preliminaryEntryCount(list: RecordValue | undefined, answer: string): number {
  const entryKeys = list?.entryKeys;
  return Array.isArray(entryKeys)
    ? entryKeys.length
    : answer.split(";").filter((entry) => entry.trim().length > 0).length;
}

function handlePreliminaryList({ state, data, now }: ProgressContext): AgentProgressUpdate {
  const list = asRecord(data?.preliminaryList);
  const round = numberValue(list?.round);
  const answer = stringValue(list?.answer);
  if (round === undefined || answer === undefined) return { state, kind: "ignored" };
  const entryCount = preliminaryEntryCount(list, answer);
  state.latestPreliminaryList = { round, entryCount };
  state.lastMeaningfulAt = now;
  state.lastActivity = `preliminary list round ${round}`;
  return {
    state,
    kind: "immediate",
    message: `preliminary list (round ${round}): ${entryCount} entries`,
  };
}

function markToolStarted(state: AgentProgressState, callId: string, tool: string): void {
  const existing = state.toolsByCallId.get(callId) ?? {
    name: tool,
    started: true,
    finished: false,
  };
  existing.name = tool;
  existing.started = true;
  state.toolsByCallId.set(callId, existing);
}

function handleSearchTrace({ state, data, now }: ProgressContext): AgentProgressUpdate {
  const text = stringValue(data?.text);
  if (text === undefined) return { state, kind: "ignored" };
  const callId = stringValue(data?.callId);
  const tool = stringValue(data?.tool);
  if (callId !== undefined) {
    state.latestNarrationByCallId.set(callId, text);
    if (tool !== undefined) markToolStarted(state, callId, tool);
  }
  state.latestNarration = text;
  state.lastMeaningfulAt = now;
  state.lastActivity = text;
  return { state, kind: "coalesced" };
}

function handleSourceAdded({ state, data, now }: ProgressContext): AgentProgressUpdate {
  const source = asRecord(data?.source);
  if (stringValue(source?.url) === undefined) return { state, kind: "ignored" };
  addSource(state, stringValue(source?.callId) ?? stringValue(source?.parentCallId));
  state.lastMeaningfulAt = now;
  state.lastActivity = `${state.sourcesFound} sources found`;
  return { state, kind: "coalesced" };
}

function handleSourceTruncated({ state, data, now }: ProgressContext): AgentProgressUpdate {
  const callId = stringValue(data?.callId);
  state.lastMeaningfulAt = now;
  state.lastActivity =
    callId === undefined ? "source limit reached" : `source limit reached for ${callId}`;
  return { state, kind: "coalesced" };
}

type OutputItemKeys = {
  key: string | undefined;
  callId: string | undefined;
  parentCallId: string | undefined;
};

function outputItemKeys(item: RecordValue | undefined, isDone: boolean): OutputItemKeys {
  const itemId = stringValue(item?.id);
  const callId = item === undefined ? undefined : itemCallId(item);
  const parentCallId = item === undefined ? undefined : itemParentCallId(item);
  const key = isDone ? (parentCallId ?? callId ?? itemId) : (callId ?? itemId);
  return { key, callId, parentCallId };
}

// Um item ".done" pode chegar sob a chave do pai. Quando isso acontece, a
// atividade que ja estava registrada no call_id filho e adotada pela chave nova
// e a entrada antiga sai -- senao a mesma chamada apareceria duas vezes.
function adoptNestedActivity(
  state: AgentProgressState,
  keys: OutputItemKeys,
): ToolActivity | undefined {
  const { key, callId, parentCallId } = keys;
  const nested =
    parentCallId !== undefined && callId !== undefined
      ? state.toolsByCallId.get(callId)
      : undefined;
  if (nested !== undefined && callId !== undefined && key !== callId) {
    state.toolsByCallId.delete(callId);
  }
  return nested;
}

function handleOutputItem({ state, data, now, eventName }: ProgressContext): AgentProgressUpdate {
  const isDone = eventName.endsWith(".done");
  const item = asRecord(data?.item);
  const keys = outputItemKeys(item, isDone);
  if (keys.key === undefined) return { state, kind: "ignored" };

  const name = stringValue(item?.name) ?? "tool";
  const existing =
    adoptNestedActivity(state, keys) ??
    state.toolsByCallId.get(keys.key) ?? { name, started: false, finished: false };
  existing.name = name;
  if (isDone) existing.finished = true;
  else existing.started = true;
  state.toolsByCallId.set(keys.key, existing);

  const metadataSourceCount = numberValue(asRecord(item?.metadata)?.sourceCount);
  const suffix = isDone ? "finished" : "started";
  state.lastMeaningfulAt = now;
  state.lastActivity =
    isDone && metadataSourceCount !== undefined
      ? `${toolActivityLabel(name, suffix)} (${metadataSourceCount} sources)`
      : toolActivityLabel(name, suffix);
  return { state, kind: "coalesced" };
}

const PROGRESS_EVENT_HANDLERS = new Map<string, ProgressEventHandler>([
  ["agent_run.created", handleRunCreated],
  ["agent_run.started", handleRunStarted],
  ["agent_run.preliminary_list", handlePreliminaryList],
  ["agent_run.search_trace", handleSearchTrace],
  ["agent_run.source.added", handleSourceAdded],
  ["agent_run.source.truncated", handleSourceTruncated],
  ["agent_run.output_item.added", handleOutputItem],
  ["agent_run.output_item.done", handleOutputItem],
]);

export function ingestAgentEvent(
  state: AgentProgressState,
  event: AgentEvent,
  now = Date.now(),
): AgentProgressUpdate {
  const data = eventData(event);

  if (state.runId === null) {
    const eventRunId = stringValue(data?.id);
    if (eventRunId !== undefined) state.runId = eventRunId;
  }

  const handler = PROGRESS_EVENT_HANDLERS.get(event.event);
  if (handler === undefined) return { state, kind: "ignored" };
  return handler({ state, data, eventName: event.event, now });
}

function latestActivity(state: AgentProgressState): string {
  return state.latestNarration ?? state.lastActivity;
}

export function summarizeAgentProgress(state: AgentProgressState): string {
  const activeTools = [...state.toolsByCallId.values()].filter((tool) => !tool.finished).length;
  const toolCalls = state.toolsByCallId.size;
  const toolLabel = activeTools > 0 ? `working (${pluralize(activeTools, "tool")})` : "working";
  const parts = [
    toolLabel,
    pluralize(toolCalls, "tool call"),
    pluralize(state.sourcesFound, "source"),
    `latest: ${latestActivity(state)}`,
  ];
  return parts.join(" · ").slice(0, 200);
}

export function heartbeatMessage(state: AgentProgressState, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - state.startedAt) / 1_000));
  return `still working (elapsed ${elapsedSeconds}s, ${state.sourcesFound} sources) — last: ${latestActivity(state)}`.slice(
    0,
    200,
  );
}

export class AgentProgressBridge {
  private readonly state: AgentProgressState;
  private readonly emit: (message: string) => Promise<void>;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private trailingTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingTrailing = false;
  private lastCoalescedEmitAt = 0;
  private hasCoalescedEmission = false;
  private closed = false;

  constructor(options: {
    emit: (message: string) => Promise<void>;
    runId?: string | null;
    throttleMs?: number;
    now?: () => number;
  }) {
    this.emit = options.emit;
    this.state = createAgentProgressState(options.runId ?? null, options.now?.() ?? Date.now());
    this.throttleMs = options.throttleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;
    this.now = options.now ?? Date.now;
  }

  getState(): AgentProgressState {
    return this.state;
  }

  async handle(event: AgentEvent): Promise<void> {
    if (this.closed) return;
    const update = ingestAgentEvent(this.state, event, this.now());
    if (update.kind === "ignored") return;
    if (update.kind === "immediate") {
      if (update.message === undefined) return;
      await this.flushTrailing();
      await this.emit(update.message);
      return;
    }

    const current = this.now();
    if (!this.hasCoalescedEmission || current - this.lastCoalescedEmitAt >= this.throttleMs) {
      this.lastCoalescedEmitAt = current;
      this.hasCoalescedEmission = true;
      await this.emit(summarizeAgentProgress(this.state));
      return;
    }

    this.pendingTrailing = true;
    this.scheduleTrailing(this.throttleMs - (current - this.lastCoalescedEmitAt));
  }

  private scheduleTrailing(delayMs: number): void {
    if (this.trailingTimer !== undefined) return;
    this.trailingTimer = setTimeout(
      () => {
        this.trailingTimer = undefined;
        void this.flushTrailing();
      },
      Math.max(1, delayMs),
    );
  }

  private async flushTrailing(): Promise<void> {
    if (!this.pendingTrailing || this.closed) return;
    this.pendingTrailing = false;
    this.lastCoalescedEmitAt = this.now();
    this.hasCoalescedEmission = true;
    await this.emit(summarizeAgentProgress(this.state));
  }

  async cleanup(): Promise<void> {
    if (this.trailingTimer !== undefined) clearTimeout(this.trailingTimer);
    this.trailingTimer = undefined;
    await this.flushTrailing();
    this.closed = true;
  }
}
