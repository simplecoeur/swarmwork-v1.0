import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { fetchAgentTemplates, fetchKb, fetchSkills } from '../api';
import { Button, Spinner } from './ui';

/**
 * v1.5.0 B 资源中心：三库（知识库/技能库/人才库）统一入口壳。
 * 统一口径——卡片四要素：标题 / 一句话用途 / 来源与分层 / 状态计数；
 * 动词归一：知识「引用」（干活时自动注入）、技能「安装」、人才「招募」；
 * 分层术语全站归一：平台 / 公司 / 小组 / 成员。
 */
export default function ResourceCenter() {
  const { openDialog } = useApp();
  const [counts, setCounts] = useState<{ kb: number; skills: number; talents: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchKb(), fetchSkills(), fetchAgentTemplates()])
      .then(([kb, skills, talents]) => {
        if (!cancelled) setCounts({ kb: kb.length, skills: skills.length, talents: talents.length });
      })
      .catch(() => {
        if (!cancelled) setCounts({ kb: 0, skills: 0, talents: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const libs = [
    {
      icon: '📚',
      title: '知识库',
      verb: '引用',
      desc: '公司标准与平台公共知识，干活时按 平台 > 公司 > 小组 > 成员 的顺序自动注入参考。',
      meta: '分层：平台 / 公司 / 小组 / 成员',
      count: counts?.kb,
      go: () => openDialog('kb'),
      goLabel: '打开知识库',
    },
    {
      icon: '🧩',
      title: '技能库',
      verb: '安装',
      desc: '可复用的提示词技能：本空间自建、平台官方与 GitHub 导入技能，安装后发单时一键套用。',
      meta: '来源：本空间 / 平台库（含平台下发）',
      count: counts?.skills,
      go: () => openDialog('skills'),
      goLabel: '打开技能库',
    },
    {
      icon: '🧑‍💼',
      title: '人才库',
      verb: '招募',
      desc: '平台从开源仓库同步、管理员审核上架的智能体模板，招募即生成一名真成员进你的小组。',
      meta: '来源：GitHub 开源仓库（带仓库·作者·许可证署名）',
      count: counts?.talents,
      go: () => openDialog('talents'),
      goLabel: '打开人才库',
    },
  ];

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        三个库，一个入口：知识被「引用」、技能被「安装」、人才被「招募」。全局搜索（顶栏）也可直接搜到三库资源。
      </p>
      {!counts && (
        <p>
          <Spinner label="加载中…" />
        </p>
      )}
      <div className="resource-grid">
        {libs.map((l) => (
          <div className="task res-card" key={l.title}>
            <span className="tt">
              {l.icon} {l.title}
            </span>
            <div style={{ fontSize: 13.5, margin: '4px 0' }}>{l.desc}</div>
            <div className="meta">
              {l.meta}
              <br />
              当前可见 {l.count ?? '…'} 条
            </div>
            <Button size="small" variant="blue" onClick={l.go}>
              {l.goLabel}（{l.verb}）
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
