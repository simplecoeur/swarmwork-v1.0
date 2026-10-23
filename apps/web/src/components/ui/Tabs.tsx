import type { ReactNode } from 'react';
import * as RTabs from '@radix-ui/react-tabs';

export interface TabDef {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  tabs: TabDef[];
  className?: string;
  ariaLabel?: string;
}

/**
 * 自有页签（Radix Tabs 打底）：方向键导航/焦点管理由 Radix 负责，
 * 触发器皮肤复用 .btn 的纸面语言（.ui-tabs-trigger，选中态 = 品牌红，与原模式按钮一致）。
 * 非激活页签内容不挂载（与原条件渲染行为一致，表单状态由父组件持有不受影响）。
 */
export function Tabs({ value, onValueChange, tabs, className, ariaLabel }: TabsProps) {
  return (
    <RTabs.Root
      className={className}
      value={value}
      onValueChange={onValueChange}
      aria-label={ariaLabel}
    >
      <RTabs.List className="ui-tabs-list">
        {tabs.map((t) => (
          <RTabs.Trigger key={t.value} className="ui-tabs-trigger" value={t.value}>
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {tabs.map((t) => (
        <RTabs.Content key={t.value} className="ui-tabs-content" value={t.value}>
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}
