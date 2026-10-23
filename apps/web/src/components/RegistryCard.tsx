import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchRegistry } from '../api';
import type { RegistryRole, RegistryTaskType } from '../types';

/** 工种来源标注：系统内置 / 行业包带入 / 本空间自定义 */
function roleSource(r: RegistryRole): string {
  if (r.isSystem) return '系统';
  if (r.packId) return '行业包';
  if (r.workspaceId) return '自定义';
  return '系统';
}

/**
 * 设置后台卡（M6）：工种与任务类型注册表。
 * 列表来自 GET /api/registry（当前空间可见集）；新增走 POST /api/registry/roles|task-types。
 */
export default function RegistryCard() {
  const { post, toast } = useApp();
  const [roles, setRoles] = useState<RegistryRole[]>([]);
  const [taskTypes, setTaskTypes] = useState<RegistryTaskType[]>([]);
  const [loaded, setLoaded] = useState(false);
  // 新增工种表单
  const [roleName, setRoleName] = useState('');
  const [rolePersona, setRolePersona] = useState('');
  const [roleColor, setRoleColor] = useState('#5b8def');
  const [roleIcon, setRoleIcon] = useState('');
  // 新增任务类型表单
  const [typeName, setTypeName] = useState('');
  const [typeRoleId, setTypeRoleId] = useState('');

  const reload = useCallback(async () => {
    try {
      const r = await fetchRegistry();
      setRoles(r.roles);
      setTaskTypes(r.taskTypes);
    } catch {
      /* 拉不到时保持空表，下方回退提示 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // 任务类型的目标工种默认选第一个工种
  useEffect(() => {
    if (roles.length && !roles.some((r) => r.roleId === typeRoleId)) {
      setTypeRoleId(roles[0].roleId);
    }
  }, [roles, typeRoleId]);

  const roleNameOf = (roleId: string) => roles.find((r) => r.roleId === roleId)?.name || roleId;

  async function addRole() {
    if (!roleName.trim()) return toast('先填工种名');
    try {
      await post('/api/registry/roles', {
        role: {
          name: roleName.trim(),
          personaTemplate: rolePersona,
          color: roleColor,
          icon: roleIcon.trim(),
        },
      });
    } catch { return; }
    setRoleName('');
    setRolePersona('');
    setRoleIcon('');
    toast('工种已新增');
    reload();
  }

  async function addTaskType() {
    if (!typeName.trim()) return toast('先填任务类型名');
    if (!typeRoleId) return toast('先选派给哪个工种');
    try {
      await post('/api/registry/task-types', {
        taskType: { name: typeName.trim(), roleId: typeRoleId },
      });
    } catch { return; }
    setTypeName('');
    toast('任务类型已新增');
    reload();
  }

  return (
    <div className="card">
      <h2>
        工种与任务类型{' '}
        <span className="tag">注册表驱动：发布任务的类型下拉、派单分工都读这里；行业包会带入专属工种/类型</span>
      </h2>
      {!loaded && <p className="hint">加载中…</p>}
      {loaded && (
        <>
          <label>工种（{roles.length}）</label>
          {roles.length === 0 && <p className="hint">暂无工种（注册表拉取失败或尚未配置）。</p>}
          {roles.map((r) => (
            <div className="task" key={r.roleId}>
              <span className="tt">
                <span style={{ color: r.color || 'inherit' }}>■</span> {r.icon ? `${r.icon} ` : ''}
                {r.name}
              </span>
              <span className="chip">{roleSource(r)}</span>
              {r.industry && <span className="chip">{r.industry}</span>}
              <div className="meta">{r.personaTemplate || '（无人设模板）'}</div>
            </div>
          ))}

          <label>任务类型（{taskTypes.length}）</label>
          {taskTypes.length === 0 && <p className="hint">暂无任务类型，发布表单会回退到默认三项。</p>}
          {taskTypes.map((t) => (
            <div className="task" key={t.typeId}>
              <span className="tt">{t.name}</span>
              <span className="chip">→ {roleNameOf(t.roleId)}</span>
              {t.packId ? (
                <span className="chip">行业包</span>
              ) : t.workspaceId ? (
                <span className="chip">自定义</span>
              ) : (
                <span className="chip">系统</span>
              )}
            </div>
          ))}

          <div className="apicard" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 4 }}>新增工种（本空间自定义）</div>
            <div className="row">
              <div>
                <label>工种名</label>
                <input value={roleName} placeholder="如：剪辑师" onChange={(e) => setRoleName(e.target.value)} />
              </div>
              <div>
                <label>图标（emoji，可空）</label>
                <input value={roleIcon} placeholder="如：✂️" onChange={(e) => setRoleIcon(e.target.value)} />
              </div>
              <div>
                <label>代表色</label>
                <input type="color" value={roleColor} onChange={(e) => setRoleColor(e.target.value)} />
              </div>
            </div>
            <label>人设模板（这个工种干活时的身份与风格指令）</label>
            <textarea
              rows={2}
              placeholder="如：你是一名短剧剪辑师，擅长卡点与高光提取……"
              value={rolePersona}
              onChange={(e) => setRolePersona(e.target.value)}
            />
            <div style={{ marginTop: 8 }}>
              <button className="btn small blue" onClick={addRole}>新增工种</button>
            </div>
          </div>

          <div className="apicard">
            <div style={{ fontWeight: 900, marginBottom: 4 }}>新增任务类型（本空间自定义）</div>
            <div className="row">
              <div>
                <label>类型名</label>
                <input value={typeName} placeholder="如：切片剪辑" onChange={(e) => setTypeName(e.target.value)} />
              </div>
              <div>
                <label>派给哪个工种</label>
                <select value={typeRoleId} onChange={(e) => setTypeRoleId(e.target.value)}>
                  {roles.map((r) => (
                    <option key={r.roleId} value={r.roleId}>{r.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn small blue" onClick={addTaskType}>新增任务类型</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
