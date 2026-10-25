import { useEffect, useState } from 'react';
import { fetchAssets } from '../api';
import { Checkbox, Input } from './ui';
import type { Asset, AssetRef } from '../types';

/**
 * 资产引用多选（M8 §11.4）：发单 / skill 发单 / 批量发单共用。
 * 勾选资产后可按分段 key 只引用部分段落（逗号分隔，留空 = 整份资产）。
 * 资产列表走 GET /api/assets 单独拉取（不在 /api/state 快照内）。
 */
export default function AssetRefPicker({
  value,
  onChange,
}: {
  value: AssetRef[];
  onChange: (refs: AssetRef[]) => void;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sectionText, setSectionText] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchAssets().then(setAssets).catch(() => setAssets([]));
  }, []);

  const checked = (id: string) => value.some((r) => r.assetId === id);

  function toggle(a: Asset, on: boolean) {
    if (!on) {
      onChange(value.filter((r) => r.assetId !== a.id));
      return;
    }
    const keys = (sectionText[a.id] ?? '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    onChange([...value, { assetId: a.id, sections: keys.length ? keys : undefined }]);
  }

  function editSections(a: Asset, text: string) {
    setSectionText((m) => ({ ...m, [a.id]: text }));
    if (!checked(a.id)) return;
    const keys = text
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    onChange(
      value.map((r) => (r.assetId === a.id ? { assetId: a.id, sections: keys.length ? keys : undefined } : r)),
    );
  }

  if (!assets.length) {
    return <p className="hint">暂无资产可引用（先到「资产库」建资产，发单时可整份或按分段引用）。</p>;
  }

  return (
    <div>
      {assets.map((a) => (
        <div key={a.id} style={{ marginBottom: 4 }}>
          <Checkbox
            checked={checked(a.id)}
            onCheckedChange={(on) => toggle(a, on)}
            label={<>{a.name} <span className="hint">（{a.typeId} · v{a.version}）</span></>}
          />
          {checked(a.id) && (
            <Input
              style={{ marginTop: 4 }}
              placeholder="只引用这些分段 key（逗号分隔，留空 = 整份）"
              value={sectionText[a.id] ?? (value.find((r) => r.assetId === a.id)?.sections ?? []).join(', ')}
              onChange={(e) => editSections(a, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
