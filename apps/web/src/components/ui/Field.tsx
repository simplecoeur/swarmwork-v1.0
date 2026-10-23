import type { ReactNode } from 'react';

export interface FieldProps {
  label: ReactNode;
  /** 错误文案（有值时红字展示在控件下方） */
  error?: ReactNode;
  /** 辅助说明文案 */
  hint?: ReactNode;
  children: ReactNode;
}

/** 表单字段封装：label + 控件 + 错误/说明文案，label 样式与全站 label 规则一致（.ui-field-label） */
export function Field({ label, error, hint, children }: FieldProps) {
  return (
    <div className="ui-field">
      <span className="ui-field-label">{label}</span>
      {children}
      {error ? <div className="ui-field-error">{error}</div> : null}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
