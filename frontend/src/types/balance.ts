/**
 * 气量平衡核算记录：区段 × 日期 的损耗核算结果与依据。
 *
 * 关键口径：
 * - 读数缺失或处置单未复检时，损耗绝不能算成 0；缺依据则 status='待补' 并沿用上一有效批次。
 * - 归档后（archived=true）保留核算快照，拓扑或流量包更新只重算未归档日期。
 */
export type BalanceStatus = '已核算' | '待补'

export type BalanceBasisKind =
  | '流量包'
  | '巡检'
  | '泄漏处置'
  | '沿用'
  | '待补'
  | '修订'

export interface BalanceBasis {
  kind: BalanceBasisKind
  /** 依据说明，如「流量包 FB20240605-01 · 城东站出口 8200 m³」 */
  text: string
  /** 关联业务 id（批次/巡检/处置单），便于台账跳转核对 */
  refId?: string
  /** 是否为待补依据（读数缺失、巡检缺失、处置未复检） */
  pending?: boolean
}

export interface BalanceRecord {
  id: string
  segmentId: string
  /** 核算日期 YYYY-MM-DD */
  date: string
  /** 上游站出口流量（m³/日，快照或沿用值）；无任何有效依据时为 null */
  upstreamOutletM3: number | null
  /** 下游站进口流量（m³/日，快照或沿用值）；无任何有效依据时为 null */
  downstreamInletM3: number | null
  /** 毛损耗 = 上游出口 − 下游进口；无有效依据时为 null */
  grossLossM3: number | null
  /** 已核销泄漏损耗（仅计当日已复检合格的处置单） */
  leakLossM3: number
  /** 净损耗 = 毛损耗 − 已核销泄漏损耗 */
  netLossM3: number | null
  /** 是否超区段阈值 */
  overThreshold: boolean
  status: BalanceStatus
  /** 待补原因（status='待补' 时） */
  pendingReason: string
  /** 是否沿用上一有效批次读数 */
  carriedForward: boolean
  /** 沿用自哪个批次（沿用时记录来源批次号） */
  carriedBatchNo: string
  /** 是否引用了未确认（草稿）批次的快照 */
  provisional: boolean
  /** 核算依据明细 */
  basis: BalanceBasis[]
  /** 引用的流量批次 id（当日） */
  batchId: string
  /** 引用的已复检泄漏处置单 id 列表 */
  leakIds: string[]
  /** 归档后保留核算快照，不参与后续重算 */
  archived: boolean
  archivedAt: number
  /** 最近核算时间 */
  computedAt: number
  createdAt: number
  updatedAt: number
}

export const BALANCE_STATUS_LABEL: Record<BalanceStatus, string> = {
  已核算: '已核算',
  待补: '待补依据'
}

/** 泄漏损耗估算系数：浓度 ppm × 系数 = m³/日（现场经验系数） */
export const LEAK_LOSS_FACTOR_M3_PER_PPM = 0.5

/** 仅当处置单当日已复检合格才核销泄漏损耗 */
export function leakLossOf(concentrationPpm: number): number {
  if (!Number.isFinite(concentrationPpm) || concentrationPpm <= 0) return 0
  return Math.round(concentrationPpm * LEAK_LOSS_FACTOR_M3_PER_PPM * 100) / 100
}
