/**
 * 区段（管段）：两座调压站之间的上下游连接与输配方向。
 * 气量平衡以区段 × 日期为最小核算单元：上游站出口流量 − 下游站进口流量。
 */
export interface Segment {
  id: string
  /** 区段编号，如 SEC-D01 */
  code: string
  /** 区段名称，如 城东—西城中压联络管段 */
  name: string
  /** 上游调压站 id（取该站出口流量） */
  upstreamStationId: string
  /** 下游调压站 id（取该站进口流量） */
  downstreamStationId: string
  /** 流向描述，如 东 → 西 */
  direction: string
  /** 管段长度（km） */
  lengthKm: number
  /** 区段损耗超阈值（m³/日）：净损耗超过该值在台账中标「超阈」 */
  thresholdM3: number
  note: string
  createdAt: number
  updatedAt: number
}

export interface SegmentDraft {
  code: string
  name: string
  upstreamStationId: string
  downstreamStationId: string
  direction: string
  lengthKm: number
  thresholdM3: number
  note: string
}

export const EMPTY_SEGMENT_DRAFT: SegmentDraft = {
  code: '',
  name: '',
  upstreamStationId: '',
  downstreamStationId: '',
  direction: '',
  lengthKm: 0,
  thresholdM3: 300,
  note: ''
}

/** 默认超阈损耗（m³/日），新建区段时预填 */
export const DEFAULT_SEGMENT_THRESHOLD_M3 = 300

export function segmentLabel(segment: Segment): string {
  return `${segment.code} ${segment.name}`.trim()
}
