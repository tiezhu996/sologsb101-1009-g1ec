/**
 * 气量平衡台状态（Zustand）
 * - 维护站间有向区段（拓扑）、流量包批次与进出口快照、区段日核算结果
 * - 流量包导入在单事务内完成「写批次/快照 + 增量核算」，写入失败自动回滚
 * - 拓扑 / 流量 / 巡检 / 泄漏 / 读数变化后，仅重算签名变化的未归档日期
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  createId,
  db,
  deleteFlowBatchCascade,
  deleteSegmentCascade,
  type FlowBatchRow,
  type FlowSnapshotRow,
  type PipeSegmentRow,
  type ReadingRow,
  type SegmentBalanceRow
} from '@/utils/db'
import { recomputeBalances, freezeForConfirmation, type StationLike, type LeakLike } from '@/utils/balanceEngine'
import {
  DEFAULT_LOSS_RATE_THRESHOLD_PCT,
  type BalanceRevision,
  type BalanceStatus,
  type FlowBatch,
  type FlowPackageInput,
  type PipeSegment,
  type SegmentBalance,
  type SegmentDraft
} from '@/types/balance'

type ArchivedFilter = '' | 'open' | 'archived'

interface BalanceFilter {
  segmentId: string
  statusFilter: '' | BalanceStatus
  onlyOverThreshold: boolean
  archivedFilter: ArchivedFilter
}

export interface ImportResult {
  batchId: string
  batchNo: string
  refreshed: boolean
  recomputedRows: number
}

interface BalanceState {
  segments: PipeSegment[]
  batches: FlowBatch[]
  snapshots: FlowSnapshotRow[]
  balances: SegmentBalance[]
  filter: BalanceFilter
  ready: boolean
  patchFilter: (patch: Partial<BalanceFilter>) => void
  resetFilter: () => void
  createSegment: (draft: SegmentDraft) => Promise<PipeSegment>
  updateSegment: (id: string, patch: Partial<SegmentDraft>) => Promise<void>
  removeSegment: (id: string) => Promise<void>
  validateSegmentDraft: (draft: Partial<SegmentDraft>, excludeId?: string) => string | null
  importFlowPackage: (input: FlowPackageInput, operator?: string) => Promise<ImportResult>
  confirmBatch: (batchId: string, operator: string) => Promise<{ pendingRows: number }>
  appendRevision: (batchId: string, note: string, operator: string) => Promise<void>
  removeBatch: (batchId: string) => Promise<void>
  snapshotsOfBatch: (batchId: string) => FlowSnapshotRow[]
  balancesOfBatch: (batchId: string) => SegmentBalance[]
  filteredBalances: () => SegmentBalance[]
  stats: () => {
    segmentCount: number
    batchCount: number
    pendingBatchCount: number
    pendingRowCount: number
    overThresholdCount: number
    carryCount: number
    archivedCount: number
  }
}

/* ------------------------------ 数据装载 ------------------------------ */

interface EngineData {
  segments: PipeSegmentRow[]
  stations: StationLike[]
  batches: FlowBatchRow[]
  snapshots: FlowSnapshotRow[]
  patrols: Array<{
    id: string
    stationId: string
    planDate: string
    patrolDate: string
    patrolman: string
    envNote: string
    state: string
    readings: Array<{ pointId: string; isAbnormal: boolean }>
  }>
  leaks: LeakLike[]
  existing: SegmentBalanceRow[]
}

async function loadEngineData(): Promise<EngineData> {
  const [stations, segments, batches, snapshots, patrols, readings, leaks, existing] = await Promise.all([
    db.stations.toArray(),
    db.pipeSegments.toArray(),
    db.flowBatches.toArray(),
    db.flowSnapshots.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.segmentBalances.toArray()
  ])
  return {
    segments,
    stations: stations.map((station) => ({ id: station.id, name: station.name })),
    batches,
    snapshots,
    patrols: patrols.map((patrol) => ({
      id: patrol.id,
      stationId: patrol.stationId,
      planDate: patrol.planDate,
      patrolDate: patrol.patrolDate,
      patrolman: patrol.patrolman,
      envNote: patrol.envNote,
      state: patrol.state,
      readings: readings
        .filter((reading: ReadingRow) => reading.patrolId === patrol.id)
        .map((reading) => ({ pointId: reading.pointId, isAbnormal: reading.isAbnormal }))
    })),
    leaks: leaks.map((leak) => ({
      id: leak.id,
      stationId: leak.stationId,
      concentrationPpm: leak.concentrationPpm,
      foundTime: leak.foundTime,
      state: leak.state,
      retestValuePpm: leak.retestValuePpm,
      measure: leak.measure,
      handler: leak.handler
    })),
    existing
  }
}

async function persistRecompute(now: number = Date.now()): Promise<number> {
  const data = await loadEngineData()
  const result = recomputeBalances({ ...data, now })
  if (result.upserts.length === 0 && result.staleDeletes.length === 0) return 0
  await db.transaction('rw', [db.segmentBalances], async () => {
    if (result.staleDeletes.length > 0) await db.segmentBalances.bulkDelete(result.staleDeletes)
    if (result.upserts.length > 0) {
      await db.segmentBalances.bulkPut(result.upserts.map((row) => ({ ...row, revision: 3 })))
    }
  })
  return result.upserts.length
}

/* 响应式重算串行化：输入 liveQuery 每次签名变化都排队执行，签名不变则引擎跳过写入 */
let recomputeChain: Promise<unknown> = Promise.resolve()
function queueRecompute(): void {
  recomputeChain = recomputeChain.then(async () => {
    try {
      await persistRecompute()
    } catch (error) {
      console.error('气量平衡增量重算失败', error)
    }
  })
}

/* ------------------------------ 报文校验 ------------------------------ */

function asNullableFlow(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? num : Number.NaN
}

function validatePackageInput(input: Partial<FlowPackageInput>, knownStationIds: Set<string>): {
  batchNo: string
  bizDate: string
  collector: string
  source: string
  snapshots: Array<{ stationId: string; inletFlowM3h: number | null; outletFlowM3h: number | null; note: string }>
} {
  if (!input || typeof input !== 'object') throw new Error('流量包报文不是有效对象')
  const batchNo = String(input.batchNo ?? '').trim()
  if (!batchNo) throw new Error('缺少批次号 batchNo')
  const bizDate = String(input.bizDate ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bizDate)) throw new Error(`业务日期 bizDate 格式应为 YYYY-MM-DD（收到 ${bizDate || '空'}）`)
  const parsed = Date.parse(`${bizDate}T00:00:00`)
  if (!Number.isFinite(parsed)) throw new Error(`业务日期 ${bizDate} 不是有效日期`)
  if (!Array.isArray(input.snapshots) || input.snapshots.length === 0) throw new Error('流量包缺少 snapshots 快照数组')

  const seen = new Set<string>()
  const snapshots = input.snapshots.map((item) => {
    const stationId = String(item?.stationId ?? '').trim()
    if (!stationId) throw new Error('存在缺少 stationId 的快照')
    if (!knownStationIds.has(stationId)) throw new Error(`快照站点 ${stationId} 不在站点台账中`)
    if (seen.has(stationId)) throw new Error(`站点 ${stationId} 在同一批次中出现多次`)
    seen.add(stationId)
    const inlet = asNullableFlow(item.inletFlowM3h)
    const outlet = asNullableFlow(item.outletFlowM3h)
    if (Number.isNaN(inlet)) throw new Error(`站点 ${stationId} 进口流量不是有效数值（缺失请填 null）`)
    if (Number.isNaN(outlet)) throw new Error(`站点 ${stationId} 出口流量不是有效数值（缺失请填 null）`)
    return {
      stationId,
      inletFlowM3h: inlet,
      outletFlowM3h: outlet,
      note: typeof item.note === 'string' ? item.note : ''
    }
  })

  return {
    batchNo,
    bizDate,
    collector: String(input.collector ?? '').trim(),
    source: String(input.source ?? '').trim(),
    snapshots
  }
}

/* ================================ Store ================================ */

export const useBalanceStore = create<BalanceState>((set, get) => ({
  segments: [],
  batches: [],
  snapshots: [],
  balances: [],
  filter: { segmentId: '', statusFilter: '', onlyOverThreshold: false, archivedFilter: '' },
  ready: false,

  patchFilter(patch) {
    set({ filter: { ...get().filter, ...patch } })
  },

  resetFilter() {
    set({ filter: { segmentId: '', statusFilter: '', onlyOverThreshold: false, archivedFilter: '' } })
  },

  validateSegmentDraft(draft, excludeId) {
    const name = draft.name?.trim() ?? ''
    if (!name) return '请填写区段名称'
    if (!draft.upstreamStationId) return '请选择上游站点'
    if (!draft.downstreamStationId) return '请选择下游站点'
    if (draft.upstreamStationId === draft.downstreamStationId) return '上游与下游不能是同一站点'
    const threshold = Number(draft.lossRateThresholdPct)
    if (!Number.isFinite(threshold) || threshold < 0) return '损耗率阈值需为不小于 0 的百分数'
    const duplicated = get().segments.some(
      (segment) =>
        segment.id !== excludeId &&
        new Set([segment.upstreamStationId, segment.downstreamStationId]).size === 2 &&
        segment.upstreamStationId === draft.upstreamStationId &&
        segment.downstreamStationId === draft.downstreamStationId
    )
    if (duplicated) return '同一对上下游站点的区段已存在，请勿重复维护'
    return null
  },

  async createSegment(draft) {
    const error = get().validateSegmentDraft(draft)
    if (error) throw new Error(error)
    const now = Date.now()
    const row: PipeSegmentRow = {
      id: createId('sg'),
      name: draft.name.trim(),
      upstreamStationId: draft.upstreamStationId,
      downstreamStationId: draft.downstreamStationId,
      lossRateThresholdPct: Number(draft.lossRateThresholdPct) || DEFAULT_LOSS_RATE_THRESHOLD_PCT,
      remark: draft.remark.trim(),
      createdAt: now,
      updatedAt: now,
      revision: 3
    }
    await db.pipeSegments.put(row)
    return row
  },

  async updateSegment(id, patch) {
    const current = get().segments.find((segment) => segment.id === id)
    if (!current) return
    const merged = {
      name: patch.name ?? current.name,
      upstreamStationId: patch.upstreamStationId ?? current.upstreamStationId,
      downstreamStationId: patch.downstreamStationId ?? current.downstreamStationId,
      lossRateThresholdPct: patch.lossRateThresholdPct ?? current.lossRateThresholdPct,
      remark: patch.remark ?? current.remark
    }
    const error = get().validateSegmentDraft(merged, id)
    if (error) throw new Error(error)
    await db.pipeSegments.update(id, {
      name: merged.name.trim(),
      upstreamStationId: merged.upstreamStationId,
      downstreamStationId: merged.downstreamStationId,
      lossRateThresholdPct: Number(merged.lossRateThresholdPct),
      remark: merged.remark.trim(),
      updatedAt: Date.now()
    })
  },

  async removeSegment(id) {
    await deleteSegmentCascade(id)
  },

  async importFlowPackage(input, operator = '') {
    const stations = await db.stations.toArray()
    const known = new Set(stations.map((station) => station.id))
    const parsed = validatePackageInput(input, known)

    let result: ImportResult | null = null
    await db.transaction(
      'rw',
      [
        db.flowBatches,
        db.flowSnapshots,
        db.segmentBalances,
        db.pipeSegments,
        db.stations,
        db.patrols,
        db.readings,
        db.leaks
      ],
      async () => {
        const sameNo = await db.flowBatches.where('batchNo').equals(parsed.batchNo).first()
        if (sameNo && sameNo.state === '已确认') {
          throw new Error(`批次 ${parsed.batchNo} 已确认归档，不能覆盖；如需更正请追加修订说明`)
        }
        const sameDate = await db.flowBatches.where('bizDate').equals(parsed.bizDate).first()
        if (sameDate && sameDate.batchNo !== parsed.batchNo) {
          throw new Error(`业务日期 ${parsed.bizDate} 已存在批次 ${sameDate.batchNo}，每日仅允许一个流量包批次`)
        }

        const now = Date.now()
        const operatorName = operator.trim() || parsed.collector || '未署名'
        let batchId: string
        let refreshed = false

        if (sameNo) {
          // 重复导入同一批次：只刷新未确认结果（替换快照 + 追加刷新审计）
          batchId = sameNo.id
          refreshed = true
          await db.flowSnapshots.where('batchId').equals(batchId).delete()
          await db.flowBatches.update(batchId, {
            bizDate: parsed.bizDate,
            collector: parsed.collector || sameNo.collector,
            source: parsed.source || sameNo.source,
            snapshotCount: parsed.snapshots.length,
            auditTrail: [
              ...sameNo.auditTrail,
              {
                at: now,
                action: '刷新' as const,
                operator: operatorName,
                detail: `重复导入覆盖未确认快照，共 ${parsed.snapshots.length} 站`
              }
            ],
            updatedAt: now
          })
        } else {
          batchId = createId('fb')
          const batch: FlowBatchRow = {
            id: batchId,
            batchNo: parsed.batchNo,
            bizDate: parsed.bizDate,
            collector: parsed.collector,
            source: parsed.source,
            state: '待确认',
            importedAt: now,
            confirmedAt: null,
            confirmedBy: '',
            snapshotCount: parsed.snapshots.length,
            auditTrail: [
              {
                at: now,
                action: '导入',
                operator: operatorName,
                detail: `流量包导入，共 ${parsed.snapshots.length} 站快照`
              }
            ],
            createdAt: now,
            updatedAt: now,
            revision: 3
          }
          await db.flowBatches.put(batch)
        }

        const snapshotRows: FlowSnapshotRow[] = parsed.snapshots.map((snapshot) => ({
          id: createId('fs'),
          batchId,
          stationId: snapshot.stationId,
          inletFlowM3h: snapshot.inletFlowM3h,
          outletFlowM3h: snapshot.outletFlowM3h,
          note: snapshot.note,
          createdAt: now,
          updatedAt: now,
          revision: 3
        }))
        await db.flowSnapshots.bulkPut(snapshotRows)

        // 同事务内增量核算：失败则连同批次/快照一并回滚，恢复导入前状态
        const data = await loadEngineData()
        const engineResult = recomputeBalances({ ...data, now })
        if (engineResult.staleDeletes.length > 0) await db.segmentBalances.bulkDelete(engineResult.staleDeletes)
        if (engineResult.upserts.length > 0) {
          await db.segmentBalances.bulkPut(engineResult.upserts.map((row) => ({ ...row, revision: 3 })))
        }
        result = { batchId, batchNo: parsed.batchNo, refreshed, recomputedRows: engineResult.upserts.length }
      }
    )
    if (!result) throw new Error('流量包导入未完成，已回滚到导入前状态')
    return result
  },

  async confirmBatch(batchId, operator) {
    let pendingRows = 0
    await db.transaction(
      'rw',
      [db.flowBatches, db.flowSnapshots, db.segmentBalances, db.pipeSegments, db.stations, db.patrols, db.readings, db.leaks],
      async () => {
        const batch = await db.flowBatches.get(batchId)
        if (!batch) throw new Error('批次不存在或已被删除')
        if (batch.state === '已确认') throw new Error(`批次 ${batch.batchNo} 已确认，重复确认无效；如需更正请追加修订说明`)
        const now = Date.now()
        const operatorName = operator.trim() || '未署名'
        const data = await loadEngineData()
        const frozenRows = freezeForConfirmation(
          batch,
          data.segments,
          data.snapshots,
          data.patrols,
          data.leaks,
          data.stations,
          data.existing,
          now
        )
        pendingRows = frozenRows.filter((row) => row.status === '待补依据').length
        await db.segmentBalances.bulkPut(frozenRows.map((row) => ({ ...row, revision: 3 })))
        await db.flowBatches.update(batchId, {
          state: '已确认',
          confirmedAt: now,
          confirmedBy: operatorName,
          auditTrail: [
            ...batch.auditTrail,
            {
              at: now,
              action: '确认',
              operator: operatorName,
              detail:
                pendingRows > 0
                  ? `归档 ${frozenRows.length} 个区段结果，其中 ${pendingRows} 个待补依据（保留标注与上一有效批次沿用值）`
                  : `归档 ${frozenRows.length} 个区段结果，损耗口径齐全`
            }
          ],
          updatedAt: now
        })
      }
    )
    return { pendingRows }
  },

  async appendRevision(batchId, note, operator) {
    const trimmed = note.trim()
    if (!trimmed) throw new Error('修订说明不能为空')
    await db.transaction('rw', [db.flowBatches, db.segmentBalances], async () => {
      const batch = await db.flowBatches.get(batchId)
      if (!batch) throw new Error('批次不存在或已被删除')
      if (batch.state !== '已确认') throw new Error(`批次 ${batch.batchNo} 尚未确认，确认前可直接重新导入刷新`)
      const now = Date.now()
      const operatorName = operator.trim() || '未署名'
      const targets = await db.segmentBalances.where('batchId').equals(batchId).toArray()
      const revision: BalanceRevision = { at: now, operator: operatorName, note: trimmed, batchId }
      await db.segmentBalances.bulkPut(
        targets.map((row) => ({
          ...row,
          revisionNotes: [...row.revisionNotes, revision],
          updatedAt: now
        }))
      )
      await db.flowBatches.update(batchId, {
        auditTrail: [
          ...batch.auditTrail,
          { at: now, action: '追加修订', operator: operatorName, detail: trimmed }
        ],
        updatedAt: now
      })
    })
  },

  async removeBatch(batchId) {
    const batch = get().batches.find((item) => item.id === batchId)
    if (!batch) return
    if (batch.state === '已确认') {
      throw new Error(`批次 ${batch.batchNo} 已确认归档，已核算日期保留快照，不允许删除；如需更正请追加修订说明`)
    }
    await deleteFlowBatchCascade(batchId)
  },

  snapshotsOfBatch(batchId) {
    return get().snapshots.filter((snapshot) => snapshot.batchId === batchId)
  },

  balancesOfBatch(batchId) {
    return get()
      .balances.filter((balance) => balance.batchId === batchId)
      .sort((a, b) => a.segmentName.localeCompare(b.segmentName, 'zh-Hans-CN'))
  },

  filteredBalances() {
    const { balances, filter } = get()
    return balances
      .filter((balance) => {
        if (filter.segmentId && balance.segmentId !== filter.segmentId) return false
        if (filter.statusFilter && balance.status !== filter.statusFilter) return false
        if (filter.onlyOverThreshold && !balance.overThreshold) return false
        if (filter.archivedFilter === 'archived' && !balance.archived) return false
        if (filter.archivedFilter === 'open' && balance.archived) return false
        return true
      })
      .sort((a, b) => b.bizDate.localeCompare(a.bizDate) || a.segmentName.localeCompare(b.segmentName, 'zh-Hans-CN'))
  },

  stats() {
    const { segments, batches, balances } = get()
    return {
      segmentCount: segments.length,
      batchCount: batches.length,
      pendingBatchCount: batches.filter((batch) => batch.state === '待确认').length,
      pendingRowCount: balances.filter((balance) => balance.status === '待补依据' && !balance.archived).length,
      overThresholdCount: balances.filter((balance) => balance.overThreshold && !balance.archived).length,
      carryCount: balances.filter((balance) => balance.carryFrom !== null && !balance.archived).length,
      archivedCount: balances.filter((balance) => balance.archived).length
    }
  }
}))

/* ------------------------------ 响应式订阅 ------------------------------ */

liveQuery(async () => (await db.pipeSegments.toArray()).sort((a, b) => a.createdAt - b.createdAt)).subscribe({
  next: (rows) => useBalanceStore.setState({ segments: rows, ready: true }),
  error: () => useBalanceStore.setState({ ready: true })
})

liveQuery(async () => (await db.flowBatches.toArray()).sort((a, b) => b.bizDate.localeCompare(a.bizDate))).subscribe({
  next: (rows) => useBalanceStore.setState({ batches: rows, ready: true }),
  error: () => useBalanceStore.setState({ ready: true })
})

liveQuery(async () => await db.flowSnapshots.toArray()).subscribe({
  next: (rows) => useBalanceStore.setState({ snapshots: rows })
})

liveQuery(async () =>
  (await db.segmentBalances.toArray()).sort((a, b) => b.bizDate.localeCompare(a.bizDate))
).subscribe({
  next: (rows) => useBalanceStore.setState({ balances: rows })
})

/**
 * 核算输入签名：拓扑 / 流量包 / 快照 / 站点 / 巡检 / 读数 / 泄漏任一变化即排队重算。
 * 已确认批次对应日期在引擎内冻结，segmentBalances 自身不参与签名，避免回环。
 */
liveQuery(async () => {
  const [segments, stations, batches, snapshots, patrols, readings, leaks] = await Promise.all([
    db.pipeSegments.toArray(),
    db.stations.toArray(),
    db.flowBatches.toArray(),
    db.flowSnapshots.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray()
  ])
  return JSON.stringify({
    s: segments.map((x) => [x.id, x.name, x.upstreamStationId, x.downstreamStationId, x.lossRateThresholdPct]),
    st: stations.map((x) => [x.id, x.name]),
    b: batches.map((x) => [x.id, x.batchNo, x.bizDate, x.state, x.confirmedAt]),
    f: snapshots.map((x) => [x.batchId, x.stationId, x.inletFlowM3h, x.outletFlowM3h]),
    p: patrols.map((x) => [x.id, x.stationId, x.planDate, x.patrolDate, x.patrolman, x.envNote, x.state]),
    r: readings.map((x) => [x.patrolId, x.pointId, x.isAbnormal]),
    l: leaks.map((x) => [x.id, x.stationId, x.foundTime, x.state, x.retestValuePpm, x.measure, x.handler, x.concentrationPpm])
  })
}).subscribe({
  next: () => queueRecompute(),
  error: (error) => console.error('气量平衡输入订阅失败', error)
})

export { persistRecompute, queueRecompute }
