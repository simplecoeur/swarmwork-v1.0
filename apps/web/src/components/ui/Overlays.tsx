import type { ReactNode } from 'react';
import * as RMenu from '@radix-ui/react-dropdown-menu';
import * as RPop from '@radix-ui/react-popover';
import * as RTip from '@radix-ui/react-tooltip';

/* ---------------- DropdownMenu（Radix） ---------------- */

export interface MenuItem {
  label: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
}

export interface DropdownMenuProps {
  /** 触发器（asChild 挂载，需为单个可聚焦元素，通常是 Button） */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
  ariaLabel?: string;
}

/** 自有下拉菜单（Radix DropdownMenu 打底）：键盘导航/Esc/点外关闭由 Radix 负责，皮肤走 .ui-menu* */
export function DropdownMenu({ trigger, items, align = 'end', ariaLabel }: DropdownMenuProps) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content className="ui-menu-content" align={align} sideOffset={6} aria-label={ariaLabel}>
          {items.map((it, i) => (
            <RMenu.Item
              key={i}
              className="ui-menu-item"
              disabled={it.disabled}
              onSelect={() => it.onSelect?.()}
            >
              {it.label}
            </RMenu.Item>
          ))}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

/* ---------------- Popover（Radix） ---------------- */

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}

/** 自有弹层（Radix Popover 打底）：点外关闭/Esc 由 Radix 负责，皮肤走调用方类名 + .ui-popover 定位修正 */
export function Popover({ open, onOpenChange, trigger, children, align = 'end', className }: PopoverProps) {
  return (
    <RPop.Root open={open} onOpenChange={onOpenChange}>
      <RPop.Trigger asChild>{trigger}</RPop.Trigger>
      <RPop.Portal>
        <RPop.Content
          className={['ui-popover', className].filter(Boolean).join(' ')}
          align={align}
          sideOffset={10}
        >
          {children}
        </RPop.Content>
      </RPop.Portal>
    </RPop.Root>
  );
}

/* ---------------- Tooltip（Radix） ---------------- */

/** 自有提示（Radix Tooltip 打底）：悬停/聚焦延迟出，皮肤走 .ui-tooltip */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RTip.Provider delayDuration={300}>
      <RTip.Root>
        <RTip.Trigger asChild>{children}</RTip.Trigger>
        <RTip.Portal>
          <RTip.Content className="ui-tooltip" sideOffset={6}>
            {content}
          </RTip.Content>
        </RTip.Portal>
      </RTip.Root>
    </RTip.Provider>
  );
}
