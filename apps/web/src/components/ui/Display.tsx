import type { CSSProperties, ReactNode } from 'react';

export type BadgeVariant = 'default' | 'done' | 'run' | 'rev' | 'rej' | 'adj' | 'can';

/** 自有徽标：对应原 .chip 及其状态色（done/run/rev/rej/adj/can），皮肤走 .ui-badge */
export function Badge({
  variant = 'default',
  className,
  children,
}: {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={['ui-badge', variant !== 'default' ? `ui-badge--${variant}` : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}

/** 自有卡片容器：对应原 .card（纸面底 + 3px 墨边 + 硬阴影） */
export function Card({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={['ui-card', className].filter(Boolean).join(' ')} style={style}>
      {children}
    </div>
  );
}

/**
 * 空态三件套（G-02 统一口径）：说明文案（children）+ 示例预览（example，可选）+ CTA 按钮（action）。
 * 虚线墨边框 + 提示文案；旧用法（仅 children/action）保持兼容。
 */
export function EmptyState({
  children,
  example,
  action,
}: {
  children: ReactNode;
  /** 示例预览：一小段「长这样」的示意内容（假数据卡片/示例行），让用户知道填完是什么样 */
  example?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <div>{children}</div>
      {example ? <div className="ui-empty-example">{example}</div> : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

/** 加载态：墨边圆环旋转（只用既有 token），可带文案 */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="ui-spinner-wrap" role="status">
      <span className="ui-spinner" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}
