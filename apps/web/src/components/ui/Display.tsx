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

/** 空态：虚线墨边框 + 提示文案 + 可选操作（各页「暂无…」占位统一走这里） */
export function EmptyState({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <div>{children}</div>
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
