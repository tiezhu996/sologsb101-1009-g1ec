/**
 * 气量平衡核算口径（纯函数，无 Dexie 依赖，便于复用与播种）。
 *
 * 毛损耗 = 上游站出口流量 − 下游站进口流量；
 * 净损耗 = 毛损耗 − 已核销泄漏损耗；
 * 读数缺失不允许算 0：找不到任何有效依据 → grossLoss=null 且 status='待补'；
 * 找到的是未确认批次 → 结果 provisional（临时，确认后自动转正）；
 * 处置单未复检 → 不核销，另列「待补依据」。
 */
import type { Segment } from '@/types/segment'
import type { FlowBatch } from '@/types/flowBatch'
import type { FlowSnapshot } from '@/types/flowSnapshot'
import type { Patrol } from '@/types/patrol'
import type { Leak } from '@/types/leak'
import type { Station } from '@/types/station'
import { leakLossOf, type BalanceBasis, type BalanceStatus } from '@/types/balance'

export interface PortSnapshot {
  /** 采用的流量值（m³/日） */
  value: number | null
  /** 采用值来自哪个批次 */
  batch: FlowBatch | null
  /** 采用值来自哪条快照 */
  snapshot: FlowSnapshot | null
  /** 是否沿用了历史有效批次（当日该端口缺失） */
  carried: boolean
  /** 当日是否有任何批次的快照行（无论确认与否） */
  hasTodayRow: boolean
  /** 当日缺失原因备注（快照行 note） */
  missingNote: string
}

export interface BalanceContext {
  segment: Segment
  date: string
  upstream: Station | null
  downstream: Station | null
  /** 全部批次（按 snapshotDate 升序时由调用方保证顺序不影响，内部自行排序） */
  batches: FlowBatch[]
  /** 全部快照 */
  snapshots: FlowSnapshot[]
  patrols: Patrol[]
  leaks: Leak[]
}

export interface ComputedBalance {
  upstreamOutletM3: number | null
  downstreamInletM3: number | null
  grossLossM3: number | null
  leakLossM3: number
  netLossM3: number | null
  overThreshold: boolean
  status: BalanceStatus
  pendingReason: string
  carriedForward: boolean
  carriedBatchNo: string
  provisional: boolean
  basis: BalanceBasis[]
  batchId: string
  leakIds: string[]
}

/**
 * 解析某站某端口（进口/出口）在指定日期应采用的流量值。
 * 1) 当日优先取「已确认」批次快照；
 * 2) 当日没有已确认值时，用未确认批次值顶班（provisional）；
 * 3) 当日读表缺失（行在、值 null）时，向更早的已确认批次沿用最近一个有效值。
 */
export function resolvePort(
  ctx: Pick<BalanceContext, 'batches' | 'snapshots'>,
  stationId: string,
  date: string,
  port: 'inletFlowM3' | 'outletFlowM3'
): PortSnapshot {
  const empty: PortSnapshot = {
    value: null,
    batch: null,
    snapshot: null,
    carried: false,
    hasTodayRow: false,
    missingNote: ''
  }
  const batchById = new Map(ctx.batches.map((batch) => [batch.id, batch]))
  const stationSnaps = ctx.snapshots.filter((snapshot) => snapshot.stationId === stationId)

  // 当日该站的全部快照行
  const today = stationSnaps.filter((snapshot) => snapshot.snapshotDate === date)
  const withValue = (snapshot: FlowSnapshot): boolean => {
    const value = snapshot[port]
    return typeof value === 'number' && Number.isFinite(value)
  }

  if (today.length > 0) {
    const confirmed = today
      .filter((snapshot) => batchById.get(snapshot.batchId)?.state === '已确认')
      .filter(withValue)
      .sort((a, b) => (batchById.get(b.batchId)?.importedAt ?? 0) - (batchById.get(a.batchId)?.importedAt ?? 0))[0]
    if (confirmed) {
      const batch = batchById.get(confirmed.batchId) ?? null
      return { ...empty, value: confirmed[port] as number, batch, snapshot: confirmed, hasTodayRow: true }
    }

    const draft = today.filter(withValue)[0]
    const draftRow = draft ?? today[0]
    const draftBatch = batchById.get(draftRow.batchId) ?? null

    // 当日值缺失（行在值空）→ 沿用上一有效（已确认）批次
    if (!draft) {
      const carried = findCarried(ctx, stationId, date, port, batchById)
      if (carried) {
        return {
          value: carried.snapshot[port] as number,
          batch: carried.batch,
          snapshot: carried.snapshot,
          carried: true,
          hasTodayRow: true,
          missingNote: draftRow.note
        }
      }
      return { ...empty, hasTodayRow: true, missingNote: draftRow.note }
    }

    // 当日只有未确认批次值 → 顶班（临时）
    return { ...empty, value: draft[port] as number, batch: draftBatch, snapshot: draft, hasTodayRow: true }
  }

  // 当日整站无快照行 → 同样尝试沿用更早的已确认批次
  const carried = findCarried(ctx, stationId, date, port, batchById)
  if (carried) {
    return {
      value: carried.snapshot[port] as number,
      batch: carried.batch,
      snapshot: carried.snapshot,
      carried: true,
      hasTodayRow: false,
      missingNote: ''
    }
  }
  return empty
}

function findCarried(
  ctx: Pick<BalanceContext, 'batches' | 'snapshots'>,
  stationId: string,
  date: string,
  port: 'inletFlowM3' | 'outletFlowM3',
  batchById: Map<string, FlowBatch>
): { snapshot: FlowSnapshot; batch: FlowBatch } | null {
  const candidates = ctx.snapshots
    .filter((snapshot) => snapshot.stationId === stationId && snapshot.snapshotDate < date)
    .filter((snapshot) => {
      const batch = batchById.get(snapshot.batchId)
      return batch?.state === '已确认' && typeof snapshot[port] === 'number' && Number.isFinite(snapshot[port])
    })
    .sort((a, b) => {
      const batchA = batchById.get(a.batchId)
      const batchB = batchById.get(b.batchId)
      const dateCmp = b.snapshotDate.localeCompare(a.snapshotDate)
      if (dateCmp !== 0) return dateCmp
      return (batchB?.importedAt ?? 0) - (batchA?.importedAt ?? 0)
    })
  const snapshot = candidates[0]
  if (!snapshot) return null
  const batch = batchById.get(snapshot.batchId)
  return batch ? { snapshot, batch } : null
}

/** 当日区段两端站点是否都有「已完成」巡检（现场结论齐备） */
export function patrolEvidenceOf(patrols: Patrol[], stationId: string, date: string): Patrol | undefined {
  return patrols.find(
    (patrol) => patrol.stationId === stationId && patrol.state === '已完成' && (patrol.patrolDate || patrol.planDate) === date
  )
}

/** 当日某站相关的泄漏处置单 */
export function leakEvidenceOf(leaks: Leak[], stationId: string, date: string): Leak[] {
  return leaks.filter((leak) => leak.stationId === stationId && leak.foundTime === date)
}

interface ResolvedBatch {
  batch: FlowBatch | null
  provisional: boolean
}

/** 当日命中的流量批次：已确认优先，否则取未确认（顶班） */
export function batchOfDate(batches: FlowBatch[], date: string): ResolvedBatch {
  const today = batches.filter((batch) => batch.snapshotDate === date)
  const confirmed = today
    .filter((batch) => batch.state === '已确认')
    .sort((a, b) => b.importedAt - a.importedAt)[0]
  if (confirmed) return { batch: confirmed, provisional: false }
  const draft = today.sort((a, b) => b.importedAt - a.importedAt)[0]
  return draft ? { batch: draft, provisional: true } : { batch: null, provisional: false }
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 核算单个区段 × 日期 */
export function computeBalance(ctx: BalanceContext): ComputedBalance {
  const { segment, date, upstream, downstream, patrols, leaks } = ctx
  const basis: BalanceBasis[] = []
  const pendingReasons: string[] = []

  const { batch, provisional } = batchOfDate(ctx.batches, date)
  const upPort = resolvePort(ctx, segment.upstreamStationId, date, 'outletFlowM3')
  const downPort = resolvePort(ctx, segment.downstreamStationId, date, 'inletFlowM3')

  const upName = upstream?.name ?? '上游站'
  const downName = downstream?.name ?? '下游站'

  // ---------- 流量依据 ----------
  const describePort = (port: PortSnapshot, stationName: string, portLabel: string): void => {
    if (port.value === null) {
      pendingReasons.push(`${stationName}${portLabel}读数缺失且无上一有效批次可沿用`)
      basis.push({
        kind: '待补',
        pending: true,
        text: `${stationName}${portLabel}读数缺失${port.hasTodayRow ? `（${port.missingNote || '流量包未抄回'}）` : '（当日无流量包）'}，无上一有效批次可沿用`,
        refId: port.batch?.id
      })
      return
    }
    if (port.carried) {
      basis.push({
        kind: '沿用',
        pending: true,
        text: `${stationName}${portLabel}当日读数缺失，沿用上一有效批次 ${port.batch?.batchNo ?? '—'}（${port.snapshot?.snapshotDate ?? '—'}）${port.value} m³`,
        refId: port.batch?.id
      })
      pendingReasons.push(`${stationName}${portLabel}读数缺失，沿用上一有效批次 ${port.batch?.batchNo ?? ''}，待补当日抄表`)
    } else {
      basis.push({
        kind: '流量包',
        text: `流量包 ${port.batch?.batchNo ?? '—'} · ${stationName}${portLabel} ${port.value} m³${
          port.batch?.state === '已确认' ? '' : '（批次未确认，临时值）'
        }`,
        refId: port.batch?.id
      })
    }
  }
  describePort(upPort, upName, '出口')
  describePort(downPort, downName, '进口')

  // ---------- 巡检依据（当天两端巡检现场结论） ----------
  const upPatrol = patrolEvidenceOf(patrols, segment.upstreamStationId, date)
  const downPatrol = patrolEvidenceOf(patrols, segment.downstreamStationId, date)
  if (upPatrol) {
    basis.push({
      kind: '巡检',
      text: `${upName}当日巡检已完成 · ${upPatrol.patrolman || '未署名'}${upPatrol.envNote ? ` · ${upPatrol.envNote}` : ''}`,
      refId: upPatrol.id
    })
  } else {
    pendingReasons.push(`${upName}当日巡检缺失（现场结论未回传）`)
    basis.push({ kind: '待补', pending: true, text: `${upName}当日无已完成巡检，现场结论缺失`, refId: undefined })
  }
  if (downPatrol) {
    basis.push({
      kind: '巡检',
      text: `${downName}当日巡检已完成 · ${downPatrol.patrolman || '未署名'}${downPatrol.envNote ? ` · ${downPatrol.envNote}` : ''}`,
      refId: downPatrol.id
    })
  } else {
    pendingReasons.push(`${downName}当日巡检缺失（现场结论未回传）`)
    basis.push({ kind: '待补', pending: true, text: `${downName}当日无已完成巡检，现场结论缺失` })
  }

  // ---------- 泄漏处置依据（仅已复检合格才核销） ----------
  const dayLeaks = [...leakEvidenceOf(leaks, segment.upstreamStationId, date), ...leakEvidenceOf(leaks, segment.downstreamStationId, date)]
  let leakLossM3 = 0
  const leakIds: string[] = []
  dayLeaks.forEach((leak) => {
    const stationName = leak.stationId === segment.upstreamStationId ? upName : downName
    if (leak.state === '已复检' && leak.retestValuePpm > 0 && leak.retestValuePpm <= 50) {
      const loss = leakLossOf(leak.concentrationPpm)
      leakLossM3 += loss
      leakIds.push(leak.id)
      basis.push({
        kind: '泄漏处置',
        text: `${stationName}处置单 ${leak.id} 已复检合格（${leak.concentrationPpm}→${leak.retestValuePpm} ppm），核销泄漏损耗 ${loss} m³`,
        refId: leak.id
      })
    } else if (leak.state === '已复检') {
      pendingReasons.push(`${stationName}处置单 ${leak.id} 复检不合格，未予核销`)
      basis.push({
        kind: '待补',
        pending: true,
        text: `${stationName}处置单 ${leak.id} 已复检但 ${leak.retestValuePpm} ppm 仍超标，不予核销`,
        refId: leak.id
      })
    } else {
      // 待处置 / 已处置（未复检）：不能核销，保留现场结论
      pendingReasons.push(`${stationName}处置单 ${leak.id} 尚未复检，泄漏损耗暂不核销`)
      basis.push({
        kind: '待补',
        pending: true,
        text: `${stationName}处置单 ${leak.id} ${leak.state}（${leak.concentrationPpm} ppm），处置未复检，损耗暂不核销`,
        refId: leak.id
      })
    }
  })
  leakLossM3 = round2(leakLossM3)

  // ---------- 损耗核算 ----------
  let grossLossM3: number | null = null
  let netLossM3: number | null = null
  if (upPort.value !== null && downPort.value !== null) {
    grossLossM3 = round2(upPort.value - downPort.value)
    netLossM3 = round2(grossLossM3 - leakLossM3)
  } else {
    pendingReasons.push('端口流量无有效依据，毛损耗/净损耗暂不计算（不得记为 0）')
  }

  const carriedForward = upPort.carried || downPort.carried
  const carriedBatchNo = [upPort.carried ? upPort.batch?.batchNo : '', downPort.carried ? downPort.batch?.batchNo : '']
    .filter(Boolean)
    .join('、')

  const overThreshold = netLossM3 !== null && netLossM3 > segment.thresholdM3
  const status: BalanceStatus = pendingReasons.length > 0 ? '待补' : '已核算'

  // 批次修订说明作为核算依据追加
  batch?.revisions.forEach((revision) => {
    basis.push({
      kind: '修订',
      text: `批次 ${batch.batchNo} 修订（${revision.author || '未署名'}）：${revision.note}`,
      refId: batch.id
    })
  })

  return {
    upstreamOutletM3: upPort.value,
    downstreamInletM3: downPort.value,
    grossLossM3,
    leakLossM3,
    netLossM3,
    overThreshold,
    status,
    pendingReason: pendingReasons.join('；'),
    carriedForward,
    carriedBatchNo,
    provisional,
    basis,
    batchId: batch?.id ?? '',
    leakIds
  }
}

export function formatM3(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '待补'
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} m³`
}
