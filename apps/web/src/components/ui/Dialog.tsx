import { useCallback, useState, type ReactNode } from 'react';
import * as RD from '@radix-ui/react-dialog';
import { Button } from './Button';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** 标题（渲染为 Radix Dialog.Title，自带无障碍关联）；不传则无标题行 */
  title?: ReactNode;
  /** 宽版弹窗（如技能/资产编辑器），对应原 .box 的 maxWidth 覆盖 */
  wide?: number;
  children: ReactNode;
}

/**
 * 统一弹窗（Radix Dialog 打底）：焦点陷阱、Esc 关闭、点遮罩关闭、打开时焦点落入弹窗。
 * 皮肤走 .ui-dialog-*（原 .modal .box 的纸面/硬阴影语言）。
 */
export function Dialog({ open, onClose, title, wide, children }: DialogProps) {
  return (
    <RD.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <RD.Portal>
        <RD.Overlay className="ui-dialog-overlay" />
        <RD.Content
          className="ui-dialog-content"
          style={wide ? { maxWidth: wide } : undefined}
          aria-describedby={undefined}
        >
          {title != null ? <RD.Title className="ui-dialog-title">{title}</RD.Title> : null}
          {children}
          <RD.Close asChild>
            <button type="button" className="ui-dialog-close" aria-label="关闭弹窗">
              ✕
            </button>
          </RD.Close>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/* ---------------- 确认弹窗（替代 window.confirm） ---------------- */

export interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}

/**
 * useConfirm：ask(req) 弹出自有确认弹窗（替代 window.confirm），返回 { ask, confirmNode }，
 * confirmNode 挂到组件 JSX 末尾即可。确认后先关弹窗再执行 onConfirm（与 confirm 同步语义一致）。
 */
export function useConfirm() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const ask = useCallback((r: ConfirmRequest) => setReq(r), []);
  const confirmNode = req ? (
    <Dialog open onClose={() => setReq(null)} title={req.title}>
      <div style={{ fontSize: 13.5, lineHeight: 1.7 }}>{req.message}</div>
      <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <Button
          onClick={() => {
            const r = req;
            setReq(null);
            void r.onConfirm();
          }}
        >
          {req.confirmLabel ?? '确认'}
        </Button>
        <Button variant="gray" onClick={() => setReq(null)}>
          取消
        </Button>
      </div>
    </Dialog>
  ) : null;
  return { ask, confirmNode };
}
