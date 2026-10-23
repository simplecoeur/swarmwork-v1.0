import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'gray' | 'blue' | 'green' | 'mini' | 'nav';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'small';
}

/**
 * 自有按钮：皮肤只用既有 token（.ui-btn 系列，见 styles.css 组件区段）。
 * variant=mini / nav 时不挂 .ui-btn 基础类，分别由 .ui-btn--mini（原 .mini-btn 语言）
 * 与 header 的 `nav button` 结构规则接管，避免与 .ui-btn 的底色/边框冲突。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size, className, type, ...rest },
  ref,
) {
  const cls =
    variant === 'mini'
      ? ['ui-btn--mini', className]
      : variant === 'nav'
        ? ['ui-btn--nav', className]
        : [
            'ui-btn',
            variant !== 'primary' ? `ui-btn--${variant}` : '',
            size === 'small' ? 'ui-btn--sm' : '',
            className,
          ];
  return (
    <button ref={ref} type={type ?? 'button'} className={cls.filter(Boolean).join(' ')} {...rest} />
  );
});
