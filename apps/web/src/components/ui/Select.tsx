import type { CSSProperties, ReactNode } from 'react';
import * as RS from '@radix-ui/react-select';

/** Radix Select 的 item value 不允许空串：组件内部用哨兵值映射业务上的 ''（= 未选/无） */
const EMPTY = '__ui_empty__';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export function SelectItem({
  value,
  disabled,
  children,
}: {
  value: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <RS.Item className="ui-select-item" value={value === '' ? EMPTY : value} disabled={disabled}>
      <RS.ItemText>{children}</RS.ItemText>
      <RS.ItemIndicator className="ui-select-item-ind">✓</RS.ItemIndicator>
    </RS.Item>
  );
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  /** value='' 且无可选项时展示的占位文案 */
  placeholder?: string;
  /** 可选中的「空值」选项文案（如「跟随公司默认」「不挂项目」）；不传则 '' 仅作占位不可选 */
  emptyLabel?: string;
  options?: SelectOption[];
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  ariaLabel?: string;
  title?: string;
}

/**
 * 自有下拉选择（Radix Select 无头原语打底）：键盘导航/焦点管理/弹层定位由 Radix 负责，
 * 皮肤走 .ui-select-*（既有 token）。value 语义与原生 select 一致（'' = 未选）。
 */
export function Select({
  value,
  onValueChange,
  placeholder,
  emptyLabel,
  options,
  children,
  disabled,
  className,
  style,
  id,
  ariaLabel,
  title,
}: SelectProps) {
  const rootValue = value === '' ? (emptyLabel ? EMPTY : undefined) : value;
  return (
    <RS.Root
      value={rootValue}
      onValueChange={(v) => onValueChange(v === EMPTY ? '' : v)}
      disabled={disabled}
    >
      <RS.Trigger
        className={['ui-select-trigger', className].filter(Boolean).join(' ')}
        style={style}
        id={id}
        aria-label={ariaLabel}
        title={title}
      >
        <RS.Value placeholder={placeholder} />
        <RS.Icon className="ui-select-icon">▾</RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content className="ui-select-content" position="popper" sideOffset={4}>
          <RS.Viewport className="ui-select-viewport">
            {emptyLabel ? <SelectItem value="">{emptyLabel}</SelectItem> : null}
            {options?.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </SelectItem>
            ))}
            {children}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
