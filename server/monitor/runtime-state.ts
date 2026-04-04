type GatewayState = {
  status: "disconnected" | "connecting" | "connected";
  reconnectAttemptCount: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastAuthSuccessAt: string | null;
  lastAuthFailureAt: string | null;
  lastAuthFailurePayload: Record<string, unknown> | null;
  lastEventAt: string | null;
  lastChallengeAt: string | null;
  lastCloseCode: number | null;
};

const state: GatewayState = {
  status: "disconnected",
  reconnectAttemptCount: 0,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastAuthSuccessAt: null,
  lastAuthFailureAt: null,
  lastAuthFailurePayload: null,
  lastEventAt: null,
  lastChallengeAt: null,
  lastCloseCode: null,
};

function nowIso(): string {
  return new Date().toISOString();
}

export function recordGatewayConnecting(): void {
  state.status = "connecting";
  state.reconnectAttemptCount += 1;
}

export function recordGatewayConnected(): void {
  state.status = "connected";
  state.lastConnectedAt = nowIso();
}

export function recordGatewayClosed(code: number | null): void {
  state.status = "disconnected";
  state.lastDisconnectedAt = nowIso();
  state.lastCloseCode = code;
}

export function recordGatewayChallenge(): void {
  state.lastChallengeAt = nowIso();
}

export function recordGatewayAuthSuccess(): void {
  state.lastAuthSuccessAt = nowIso();
  state.lastAuthFailureAt = null;
  state.lastAuthFailurePayload = null;
}

export function recordGatewayAuthFailure(payload: Record<string, unknown>): void {
  state.lastAuthFailureAt = nowIso();
  state.lastAuthFailurePayload = payload;
}

export function recordGatewayEventSeen(): void {
  state.lastEventAt = nowIso();
}

export function getGatewayState(): GatewayState {
  return { ...state };
}

export function resetGatewayState(): void {
  state.status = "disconnected";
  state.reconnectAttemptCount = 0;
  state.lastConnectedAt = null;
  state.lastDisconnectedAt = null;
  state.lastAuthSuccessAt = null;
  state.lastAuthFailureAt = null;
  state.lastAuthFailurePayload = null;
  state.lastEventAt = null;
  state.lastChallengeAt = null;
  state.lastCloseCode = null;
}
