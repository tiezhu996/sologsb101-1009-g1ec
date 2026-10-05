/**
 * 流量快照：流量包抄回的「某批次 × 某站点」进出口流量日累计读数。
 * 同一批次可包含多个站点；某个站缺失进口或出口读数时对应字段为 null，
 * 核算时不得当作 0，而应沿用上一有效批次并标记「待补依据」。
 */
export interface FlowSnapshot {
  id: string
  /** 所属流量批次 id */
  batchId: string
  stationId: string
  /** 读数日期 YYYY-MM-DD（与批次快照日期一致，冗余便于索引） */
  snapshotDate: string
  /** 进口流量日累计（m³/日）；读表缺失时为 null */
  inletFlowM3: number | null
  /** 出口流量日累计（m³/日）；读表缺失时为 null */
  outletFlowM3: number | null
  /** 抄表员（流量包负责抄回快照） */
  recorder: string
  /** 现场备注，如 进口表计故障未抄回 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 流量包导入草稿中单个站点的一行（解析 JSON/CSV 得到） */
export interface FlowSnapshotDraft {
  /** 站点 id 或站点名称（导入时按 id 优先、名称兜底匹配） */
  stationRef: string
  inletFlowM3: number | null
  outletFlowM3: number | null
  recorder?: string
  note?: string
}

export function isFlowValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
