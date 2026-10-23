// 前端类型统一引用 @swarm/shared 契约（设计 §7 契约优先；M2 偏差 #4 留办，M3 落实）。
// 此处只做别名映射，保持各组件既有引用名不变；DTO 的唯一事实来源在 packages/shared。
import type {
  ApiDto,
  KbEntryDto,
  LedgerEntryDto,
  MemberDto,
  ParamsDto,
  ProjectDto,
  PurchaseDto,
  ReviewStandardsDto,
  StateDto,
  TaskDto,
  TeamDto,
} from '@swarm/shared';

export type ApiItem = ApiDto;
export type Team = TeamDto;
export type Member = MemberDto;
export type ReviewStandards = ReviewStandardsDto;
export type Params = ParamsDto;
export type Task = TaskDto;
export type Project = ProjectDto;
export type LedgerEntry = LedgerEntryDto;
export type Purchase = PurchaseDto;
export type KbEntry = KbEntryDto;
export type AppState = StateDto;

export type Presets = Record<string, { baseUrl: string; model: string }>;

export type TabKey = 'office' | 'cost' | 'settings' | 'kb';
