export interface StepperStep {
  label: string;
  description?: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** 当前步下标（0 起）；小于它的步为已完成 */
  current: number;
  onStepClick?: (index: number) => void;
}

/**
 * 自有步骤条（G-02 新手三步卡用，v1.1.0 组件层此前无 Stepper，按组件层规范补建）：
 * 纯呈现 + 可选点击跳转，皮肤走 .ui-stepper*（只用既有设计 token）。
 */
export function Stepper({ steps, current, onStepClick }: StepperProps) {
  return (
    <ol className="ui-stepper">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={i} className={`ui-stepper-item ui-stepper-item--${state}`}>
            <button
              type="button"
              className="ui-stepper-btn"
              onClick={onStepClick ? () => onStepClick(i) : undefined}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="ui-stepper-dot">{state === 'done' ? '✓' : i + 1}</span>
              <span className="ui-stepper-text">
                <span className="ui-stepper-label">{s.label}</span>
                {s.description ? <span className="ui-stepper-desc">{s.description}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
