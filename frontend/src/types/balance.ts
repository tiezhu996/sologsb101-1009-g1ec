/**
 * 气量平衡台领域模型
 * - PipeSegment：站点间有向连接（上游站 → 下游站），即损耗核算的「区段」
 * - FlowBatch / FlowSnapshot：流量包批次与各站进出口流量快照（流量包负责抄回）
 * - SegmentBalance：区段 × 日期的核算结果（含依据、待补原因、沿用批次、归档快照）
 */

/* ================================ 拓扑：区段 ================================ */

export interface PipeSegment {
  id: string
  /** 区段名，如 城东—西城连通段 */
  name: string
  /** 上游站点 id（取其出口流量） */
  upstreamStationId: string
  /** 下游站点 id（取其进口流量） */
  downstreamStationId: string
  /** 损耗率告警阈值（%），|损耗率| 超过即判超阈 */
  lossRateThresholdPct: number
  remark: string
  createdAt: number
  updatedAt: number
}

export interface SegmentDraft {
  name: string
  upstreamStationId: string
  downstreamStationId: string
  lossRateThresholdPct: number
  remark: string
}

export const EMPTY_SEGMENT_DRAFT: SegmentDraft = {
  name: '',
  upstreamStationId: '',
  downstreamStationId: '',
  lossRateThresholdPct: 3,
  remark: ''
}

/** 默认损耗率阈值（%） */
export const DEFAULT_LOSS_RATE_THRESHOLD_PCT = 3

/* ============================== 流量包：批次 ============================== */

export type FlowBatchState = '待确认' | '已确认'

export const FLOW_BATCH_STATES: FlowBatchState[] = ['待确认', '已确认']

export type BatchAuditAction = '导入' | '刷新' | '确认' | '追加修订' | '删除'

export interface BatchAuditEntry {
  /** 毫秒时间戳 */
  at: number
  action: BatchAuditAction
  /** 操作人（抄表员 / 调度员），未署名落「未署名」 */
  operator: string
  /** 现场或操作结论 */
  detail: string
}

export interface FlowBatch {
  id: string
  /** 批次号（业务幂等键）：重复导入同一批次号只刷新未确认结果 */
  batchNo: string
  /** 业务日期 YYYY-MM-DD（快照归属日，每天至多一个批次） */
  bizDate: string
  /** 抄回人 */
  collector: string
  /** 数据来源，如 SCADA 流量日报 */
  source: string
  state: FlowBatchState
  importedAt: number
  confirmedAt: number | null
  confirmedBy: string
  /** 快照条数（导入时落库，列表回显用） */
  snapshotCount: number
  /** 批次审计链：导入 / 刷新 / 确认 / 追加修订，只追加不改写 */
  auditTrail: BatchAuditEntry[]
  createdAt: number
  updatedAt: number
}

/** 站点进出口流量快照；表计未抄回时落 null（不得当作 0） */
export interface FlowSnapshot {
  id: string
  batchId: string
  stationId: string
  /** 进口流量 m³/h，缺失为 null */
  inletFlowM3h: number | null
  /** 出口流量 m³/h，缺失为 null */
  outletFlowM3h: number | null
  note: string
  createdAt: number
  updatedAt: number
}

/** 流量包导入报文中的单站快照（解析校验后落库） */
export interface FlowPackageSnapshotInput {
  stationId: string
  inletFlowM3h: number | null
  outletFlowM3h: number | null
  note?: string
}

/** 流量包导入报文：文本框粘贴 JSON 解析得到 */
export interface FlowPackageInput {
  batchNo: string
  bizDate: string
  collector?: string
  source?: string
  snapshots: FlowPackageSnapshotInput[]
}

/* ============================== 核算：区段日结果 ============================== */

export type BalanceStatus = '已核算' | '待补依据'

export const BALANCE_STATUSES: BalanceStatus[] = ['已核算', '待补依据']

/** 巡检现场结论（核算当天随结果快照留档） */
export interface BalanceEvidencePatrol {
  patrolId: string
  stationId: string
  stationName: string
  patrolman: string
  /** 生效日期：实际巡检日期优先，否则计划日期 */
  effectiveDate: string
  state: string
  /** 当天异常读数条数 */
  abnormalCount: number
  envNote: string
}

/** 泄漏处置单现场结论（核算当天随结果快照留档） */
export interface BalanceEvidenceLeak {
  leakId: string
  stationId: string
  stationName: string
  concentrationPpm: number
  foundTime: string
  state: string
  retestValuePpm: number
  measure: string
  handler: string
}

/** 上一有效批次引用（读数缺失 / 处置未复检时沿用，不把损耗算成零） */
export interface CarryRef {
  batchId: string
  batchNo: string
  bizDate: string
  lossM3h: number
  lossRatePct: number
}

/** 确认归档后追加的修订说明（只追加，不改算损耗数字） */
export interface BalanceRevision {
  at: number
  operator: string
  note: string
  batchId: string
}

export interface SegmentBalance {
  /** `${segmentId}@${bizDate}` */
  id: string
  segmentId: string
  bizDate: string
  batchId: string
  batchNo: string
  /* 拓扑快照（站点删除 / 改名后台账仍可读） */
  segmentName: string
  upstreamStationId: string
  downstreamStationId: string
  upstreamStationName: string
  downstreamStationName: string
  thresholdPct: number
  /* 流量快照依据 */
  upstreamOutletM3h: number | null
  downstreamInletM3h: number | null
  /* 核算结论：依据不全时损耗为 null，绝不写 0 */
  lossM3h: number | null
  lossRatePct: number | null
  overThreshold: boolean
  status: BalanceStatus
  /** 待补依据说明（缺读数 / 泄漏处置未复检等） */
  pendingReasons: string[]
  patrolEvidence: BalanceEvidencePatrol[]
  leakEvidence: BalanceEvidenceLeak[]
  /** 沿用上一有效批次（无有效批次时为 null） */
  carryFrom: CarryRef | null
  /** 输入签名：签名不变的未归档日期跳过重算 */
  inputSignature: string
  /** 已确认批次的日期冻结为归档，重算永不覆盖 */
  archived: boolean
  frozenAt: number | null
  revisionNotes: BalanceRevision[]
  computedAt: number
  updatedAt: number
}

export function balanceRowId(segmentId: string, bizDate: string): string {
  return `${segmentId}@${bizDate}`
}

/* ================================ 展示辅助 ================================ */

export function formatM3h(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '缺失'
  return `${value.toFixed(digits)} m³/h`
}

export function formatRatePct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(2)}%`
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
