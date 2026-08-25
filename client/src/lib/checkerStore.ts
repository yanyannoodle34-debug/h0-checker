type CheckerState = {
  isRunning: boolean;
  cards: string;
  selectedGate: string;
  progress: { current: number; total: number; lives: number; deads: number; errors: number };
  logs: string[];
  currentResults: any[];
  runId: number;
};

const defaultState: CheckerState = {
  isRunning: false,
  cards: "",
  selectedGate: "auto",
  progress: { current: 0, total: 0, lives: 0, deads: 0, errors: 0 },
  logs: [
    "H@0 OS v8.0 initialization complete.",
    "Proxy pool connected.",
    "> READY FOR OPERATION_"
  ],
  currentResults: [],
  runId: 0,
};

let abortController: AbortController | null = null;
let abortFlag = false;

export function getAbortController(): AbortController | null {
  return abortController;
}

export function setAbortController(ctrl: AbortController | null): void {
  abortController = ctrl;
}

export function getAbortFlag(): boolean {
  return abortFlag;
}

export function setAbortFlag(val: boolean): void {
  abortFlag = val;
}

export function abortCurrentRun(): void {
  abortFlag = true;
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

export function startNewRun(): number {
  abortFlag = false;
  abortController = new AbortController();
  const newRunId = state.runId + 1;
  state = { ...state, runId: newRunId };
  return newRunId;
}

let state: CheckerState = { ...defaultState };
const listeners = new Set<() => void>();

export function getCheckerState(): CheckerState {
  return state;
}

export function updateCheckerState(partial: Partial<CheckerState>): void {
  state = { ...state, ...partial };
  listeners.forEach(fn => fn());
}

export function appendLogs(newLogs: string[]): void {
  state = { ...state, logs: [...state.logs, ...newLogs] };
  listeners.forEach(fn => fn());
}

export function appendResults(results: any[]): void {
  state = { ...state, currentResults: [...state.currentResults, ...results] };
  listeners.forEach(fn => fn());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetCheckerState(): void {
  state = { ...defaultState, logs: [...defaultState.logs] };
  listeners.forEach(fn => fn());
}
