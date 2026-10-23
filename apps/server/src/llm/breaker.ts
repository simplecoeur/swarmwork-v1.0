import { LLM_GUARD } from '@swarm/shared';

export class CircuitOpenError extends Error {
  constructor(apiId: string) {
    super(`API ${apiId} 熔断中`);
    this.name = 'CircuitOpenError';
  }
}

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number | null;
  probeInFlight: boolean;
}

/**
 * 熔断器（§8/§15.1）：同一 API 连续失败 ≥3 次熔断 5 分钟；
 * 期满半开——先放行 1 单试探，成功恢复、失败再熔断 5 分钟。
 */
export class CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();

  private state(apiId: string): BreakerState {
    let s = this.states.get(apiId);
    if (!s) {
      s = { consecutiveFailures: 0, openUntil: null, probeInFlight: false };
      this.states.set(apiId, s);
    }
    return s;
  }

  /** 调用前检查；返回是否为半开试探调用。熔断中抛 CircuitOpenError */
  beforeCall(apiId: string): { probe: boolean } {
    const s = this.state(apiId);
    if (s.openUntil !== null) {
      if (Date.now() < s.openUntil) throw new CircuitOpenError(apiId);
      // 半开：只放行 1 单试探
      if (s.probeInFlight) throw new CircuitOpenError(apiId);
      s.probeInFlight = true;
      return { probe: true };
    }
    return { probe: false };
  }

  onSuccess(apiId: string): void {
    const s = this.state(apiId);
    s.consecutiveFailures = 0;
    s.openUntil = null;
    s.probeInFlight = false;
  }

  onFailure(apiId: string, wasProbe: boolean): void {
    const s = this.state(apiId);
    s.probeInFlight = false;
    s.consecutiveFailures += 1;
    if (wasProbe || s.consecutiveFailures >= LLM_GUARD.CIRCUIT_FAILURE_THRESHOLD) {
      s.openUntil = Date.now() + LLM_GUARD.CIRCUIT_OPEN_MS;
    }
  }

  isOpen(apiId: string): boolean {
    const s = this.state(apiId);
    return s.openUntil !== null && Date.now() < s.openUntil;
  }
}
