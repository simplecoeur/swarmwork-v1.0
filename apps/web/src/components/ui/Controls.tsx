import { useId, type ReactNode } from 'react';
import * as RSwitch from '@radix-ui/react-switch';
import * as RCheckbox from '@radix-ui/react-checkbox';
import * as RRadio from '@radix-ui/react-radio-group';

/* ---------------- Switch（Radix） ---------------- */

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
}

/** 自有开关（Radix Switch 打底）：轨道/滑块走 .ui-switch*，只用既有 token */
export function Switch({ checked, onCheckedChange, disabled, id, ariaLabel }: SwitchProps) {
  return (
    <RSwitch.Root
      className="ui-switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      id={id}
      aria-label={ariaLabel}
    >
      <RSwitch.Thumb className="ui-switch-thumb" />
    </RSwitch.Root>
  );
}

/* ---------------- Checkbox（Radix） ---------------- */

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** 传 label 时渲染为「框 + 文案」一行（点文案也可切换，与原 label 包裹 input 的行为一致） */
  label?: ReactNode;
  ariaLabel?: string;
}

/** 自有复选框（Radix Checkbox 打底）：皮肤走 .ui-checkbox */
export function Checkbox({ checked, onCheckedChange, disabled, label, ariaLabel }: CheckboxProps) {
  const autoId = useId();
  const box = (
    <RCheckbox.Root
      className="ui-checkbox"
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      id={autoId}
      aria-label={ariaLabel}
    >
      <RCheckbox.Indicator className="ui-checkbox-ind">✓</RCheckbox.Indicator>
    </RCheckbox.Root>
  );
  if (label == null) return box;
  return (
    <span className="ui-check-row">
      {box}
      <label htmlFor={autoId} className="ui-check-label">
        {label}
      </label>
    </span>
  );
}

/* ---------------- RadioGroup（Radix） ---------------- */

/** Radix RadioGroup 的 item value 不允许空串：内部哨兵映射业务上的 '' */
const RADIO_EMPTY = '__ui_empty__';

export function RadioGroup({
  value,
  onValueChange,
  children,
  className,
  ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <RRadio.Root
      className={['ui-radio-group', className].filter(Boolean).join(' ')}
      value={value === '' ? RADIO_EMPTY : value}
      onValueChange={(v) => onValueChange(v === RADIO_EMPTY ? '' : v)}
      aria-label={ariaLabel}
    >
      {children}
    </RRadio.Root>
  );
}

export function RadioItem({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <RRadio.Item
      className={['ui-radio-item', className].filter(Boolean).join(' ')}
      value={value === '' ? RADIO_EMPTY : value}
    >
      <span className="ui-radio-dot">
        <RRadio.Indicator className="ui-radio-ind" />
      </span>
      <span className="ui-radio-body">{children}</span>
    </RRadio.Item>
  );
}
