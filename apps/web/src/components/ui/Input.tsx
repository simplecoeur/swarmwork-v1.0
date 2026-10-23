import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** 自有文本输入：透传原生 input 全部属性（type=email/password/number/color/month 等），皮肤走 .ui-input */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={['ui-input', className].filter(Boolean).join(' ')} {...rest} />;
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** 自有多行文本：透传原生 textarea 全部属性（含 ref 回填逻辑），皮肤走 .ui-textarea */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea ref={ref} className={['ui-textarea', className].filter(Boolean).join(' ')} {...rest} />
  );
});
