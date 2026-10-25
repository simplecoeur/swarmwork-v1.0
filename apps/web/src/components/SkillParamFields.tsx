import { Checkbox, Input, Select, Textarea } from './ui';
import type { SkillInputField } from '../types';

export type ParamValue = string | number | boolean;

/**
 * skill 参数表单渲染（G-10 复用点）：技能页发单弹窗与定时任务新建/编辑表单共用同一渲染——
 * 按 input_schema 逐字段出控件（textarea/select/checkbox/number/text，全部组件层）。
 * values 以 ParamValue 记录保存，提交时由调用方按字段类型清洗（与发单口径一致）。
 */
export function SkillParamFields({
  fields,
  values,
  onChange,
}: {
  fields: SkillInputField[];
  values: Record<string, ParamValue>;
  onChange: (values: Record<string, ParamValue>) => void;
}) {
  const set = (key: string, v: ParamValue) => onChange({ ...values, [key]: v });
  return (
    <>
      {fields.map((f) => (
        <div key={f.key}>
          <label>
            {f.label}
            {f.required ? ' *' : ''}
          </label>
          {f.type === 'textarea' ? (
            <Textarea
              rows={3}
              placeholder={f.placeholder}
              value={String(values[f.key] ?? '')}
              onChange={(e) => set(f.key, e.target.value)}
            />
          ) : f.type === 'select' ? (
            <Select
              value={String(values[f.key] ?? '')}
              onValueChange={(v) => set(f.key, v)}
              placeholder="请选择"
              options={(f.options ?? []).map((o) => ({ value: o, label: o }))}
            />
          ) : f.type === 'checkbox' ? (
            <Checkbox
              checked={!!values[f.key]}
              onCheckedChange={(on) => set(f.key, on)}
              label="是"
            />
          ) : (
            <Input
              type={f.type === 'number' ? 'number' : 'text'}
              placeholder={f.placeholder}
              value={String(values[f.key] ?? '')}
              onChange={(e) => set(f.key, e.target.value)}
            />
          )}
        </div>
      ))}
    </>
  );
}

/** 参数初值：schema 默认值优先，其余 checkbox=false、其它空串（与技能页发单口径一致） */
export function defaultSkillParams(fields: SkillInputField[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.key] = f.default as ParamValue;
    else out[f.key] = f.type === 'checkbox' ? false : '';
  }
  return out;
}

/** 提交清洗：必填在调用方先行提示；此处剔除空值并把 number 字段转数（与技能页发单口径一致） */
export function cleanSkillParams(
  fields: SkillInputField[],
  values: Record<string, ParamValue>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v !== '' && v !== undefined) clean[f.key] = f.type === 'number' ? Number(v) : v;
  }
  return clean;
}
