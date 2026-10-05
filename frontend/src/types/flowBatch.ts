/**
 * 流量批次（流量包）：一次抄回的全网站点进出口流量快照，按批次号唯一。
 *
 * - 批次有日期（snapshotDate），作为该批快照的核算日期。
 * - 状态机：已导入（草稿，可被同批次号重复导入刷新）→ 已确认（核算口径生效，只能追加修订说明）。
 * - 「上一有效批次」仅在已确认批次中查找，草稿批次不能作为沿用依据。
 */
import type { FlowSnapshotDraft } from './flowSnapshot'

export type FlowBatchState = '已导入' | '已确认'

export interface FlowBatch {
  id: string
  /** 批次号，业务唯一，如 FB20240612-01 */
  batchNo: string
  /** 快照日期 YYYY-MM-DD */
  snapshotDate: string
  /** 流量包抄表负责人 */
  recorder: string
  state: FlowBatchState
  /** 导入来源：json 导入 / 手工录入 */
  source: 'json' | 'manual'
  /** 已确认后追加的修订说明（只追加、不改写历史结果） */
  revisions: FlowBatchRevision[]
  /** 最近一次导入/刷新时间 */
  importedAt: number
  createdAt: number
  updatedAt: number
}

export interface FlowBatchRevision {
  /** 修订说明 */
  note: string
  /** 修订人 */
  author: string
  /** 修订时间戳 */
  at: number
}

export const FLOW_BATCH_STATES: FlowBatchState[] = ['已导入', '已确认']

/** 提交给导入动作的流量包：同批次号重复导入只刷新未确认结果 */
export interface FlowBatchImport {
  batchNo: string
  snapshotDate: string
  recorder: string
  source: 'json' | 'manual'
  rows: FlowSnapshotDraft[]
}

/** 流量包 JSON 文件结构 */
export interface FlowPacketFile {
  batchNo: string
  snapshotDate: string
  recorder?: string
  snapshots: Array<{
    station: string
    inletFlowM3?: number | null
    outletFlowM3?: number | null
    recorder?: string
    note?: string
  }>
}
