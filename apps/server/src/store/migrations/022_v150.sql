-- 022_v150.sql —— v1.5.0：三库归一 + 平台知识补齐 + 同步自动化一期 + 管理端技能下发 + 管理端沟通运营（L）。
-- agent_templates 增列：risk_flags（自动预筛标记 JSON 数组）、pub_at（最近一次过审上架时间，「本月上新」口径）。
ALTER TABLE agent_templates ADD COLUMN risk_flags TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_templates ADD COLUMN pub_at TEXT;

-- 同步 run 记录（C 流水线看板）：手动/月度自动共用一张表，failed_details 存 JSON 明细。
CREATE TABLE agent_sync_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL DEFAULT '',
  source_repo TEXT NOT NULL DEFAULT '',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'success',
  source_commit TEXT NOT NULL DEFAULT '',
  fetched INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  failed_details TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_agent_sync_runs_source ON agent_sync_runs(source_id, created_at DESC);

-- 招募事件（C 热度榜「有效招募」口径：招募后 7 天未删除才计数，按事件逐条核成员存亡）。
CREATE TABLE agent_recruit_events (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_recruit_events_tpl ON agent_recruit_events(template_id, created_at);

-- 热度榜月度快照（C）：榜单分按月重算留档，页面公示口径与更新时间。
CREATE TABLE agent_heat_snapshots (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  template_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  source_stars INTEGER NOT NULL DEFAULT 0,
  effective_recruits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(month, template_id)
);
CREATE INDEX idx_agent_heat_month ON agent_heat_snapshots(month, score DESC);

-- skills 增列（K GitHub 导入来源署名；仅导入的平台行有值）。
ALTER TABLE skills ADD COLUMN source_repo TEXT;
ALTER TABLE skills ADD COLUMN source_author TEXT;
ALTER TABLE skills ADD COLUMN source_license TEXT;

-- K 技能导入记录（含许可证拒绝留痕）。
CREATE TABLE skill_source_imports (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  license_ok INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'failed',
  detail TEXT NOT NULL DEFAULT '',
  imported_by TEXT,
  created_at TEXT NOT NULL
);

-- K 推送下发记录（幂等键 skill+空间+版本；用户端「平台下发」徽标按 copy_skill_id 反查）。
CREATE TABLE skill_pushes (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  copy_skill_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  pushed_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, workspace_id, version)
);
CREATE INDEX idx_skill_pushes_copy ON skill_pushes(copy_skill_id);

-- L 平台公告（scope=all 全部空间 / selected 选定空间，workspace_ids 存 JSON 数组）。
CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'all',
  workspace_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'published',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX idx_announcements_status ON announcements(status, created_at DESC);

-- L 管理员↔空间所有者消息线程（一空间一线程，收件人恒为空间所有者账号）。
CREATE TABLE message_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sender_type TEXT NOT NULL DEFAULT 'admin',
  sender_user_id TEXT,
  body TEXT NOT NULL DEFAULT '',
  team_id TEXT,
  kind TEXT NOT NULL DEFAULT 'chat',
  admin_read INTEGER NOT NULL DEFAULT 0,
  owner_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_messages_ws ON messages(workspace_id, created_at);
