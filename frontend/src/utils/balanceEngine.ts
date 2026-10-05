/**
 * 气量平衡核算引擎
 *
 * - recomputeBalance：拓扑或流量包更新后，只重算「受影响区段 × 受影响日期」中未归档的记录；
 *   已归档（archived）日期保留核算快照不动。
 * - importFlowPacket：整批导入在一个 Dexie 事务内完成；写入失败自动回滚，
 *   并把导入前的批次/快照恢复回库（恢复导入前状态）。
 * - 同批次号重复导入只刷新「未确认」批次；已确认批次拒绝覆盖，只能追加修订说明。
 */
import {
  ALL_TABLES,
  createId,
  db,
  ROW_REVISION,
  type BalanceRecordRow,
  type FlowBatchRow,
  type FlowSnapshotRow,
  type LeakRow,
  type PatrolRow,
  type SegmentRow,
  type StationRow
} from '@/utils/db'
import type { Segment, SegmentDraft } from '@/types/segment'
import type { FlowBatchImport, FlowBatchRevision } from '@/types/flowBatch'
import { computeBalance, type ComputedBalance } from '@/utils/balance'

export interface RecomputeScope {
  segmentIds?: string[]
  /** 受影响的起始日期（含）；不传则从最早批次日期开始 */
  fromDate?: string
  /** 受影响的截止日期（含）；不传则到最晚批次日期 */
  toDate?: string
}

export interface RecomputeResult {
  recomputed: number
  skippedArchived: number
  deleted: number
}

interface BalanceSourceData {
  segments: SegmentRow[]
  batches: FlowBatchRow[]
  snapshots: FlowSnapshotRow[]
  patrols: PatrolRow[]
  leaks: LeakRow[]
  stations: StationRow[]
}

async function loadSourceData(): Promise<BalanceSourceData> {
  const [segments, batches, snapshots, patrols, leaks, stations] = await Promise.all([
    db.segments.toArray(),
    db.flowBatches.toArray(),
    db.flowSnapshots.toArray(),
    db.patrols.toArray(),
    db.leaks.toArray(),
    db.stations.toArray()
  ])
  return { segments, batches, snapshots, patrols, leaks, stations }
}

/** 由口径结果构造可持久化的核算行（复用已有 id，保留归档信息） */
function toRecordRow(params: {
  existing: BalanceRecordRow | undefined
  segmentId: string
  date: string
  result: ComputedBalance
  now: number
}): BalanceRecordRow {
  const { existing, segmentId, date, result, now } = params
  return {
    id: existing?.id ?? createId('br'),
    segmentId,
    date,
    upstreamOutletM3: result.upstreamOutletM3,
    downstreamInletM3: result.downstreamInletM3,
    grossLossM3: result.grossLossM3,
    leakLossM3: result.leakLossM3,
    netLossM3: result.netLossM3,
    overThreshold: result.overThreshold,
    status: result.status,
    pendingReason: result.pendingReason,
    carriedForward: result.carriedForward,
    carriedBatchNo: result.carriedBatchNo,
    provisional: result.provisional,
    basis: result.basis,
    batchId: result.batchId,
    leakIds: result.leakIds,
    archived: existing?.archived ?? false,
    archivedAt: existing?.archivedAt ?? 0,
    computedAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    revision: ROW_REVISION
  }
}

/**
 * 重算受影响的未归档核算记录。
 * 在一个读写事务内完成，避免拓扑/快照更新与核算结果出现中间态。
 */
export async function recomputeBalance(scope: RecomputeScope = {}): Promise<RecomputeResult> {
  const summary: RecomputeResult = { recomputed: 0, skippedArchived: 0, deleted: 0 }

  await db.transaction(
    'rw',
    [db.segments, db.flowBatches, db.flowSnapshots, db.balanceRecords, db.patrols, db.leaks, db.stations],
    async () => {
      const data = await loadSourceData()
      if (data.segments.length === 0) {
        return
      }

      // 候选日期：所有批次快照日期（巡检/泄漏只在这些日期被核算引用）
      const dates = Array.from(new Set(data.batches.map((batch) => batch.snapshotDate))).sort()
      let targetDates = dates
      if (scope.fromDate) targetDates = targetDates.filter((date) => date >= scope.fromDate!)
      if (scope.toDate) targetDates = targetDates.filter((date) => date <= scope.toDate!)

      const targetSegments = scope.segmentIds
        ? data.segments.filter((segment) => scope.segmentIds!.includes(segment.id))
        : data.segments

      for (const segment of targetSegments) {
        const existing = await db.balanceRecords.where('segmentId').equals(segment.id).toArray()
        const existingByDate = new Map(existing.map((record) => [record.date, record]))
        const rows: BalanceRecordRow[] = []
        const now = Date.now()

        for (const date of targetDates) {
          const current = existingByDate.get(date)
          if (current?.archived) {
            // 已核算日期保留快照，不参与重算
            summary.skippedArchived += 1
            rows.push(current)
            continue
          }
          const result = computeBalance({
            segment,
            date,
            upstream: data.stations.find((station) => station.id === segment.upstreamStationId) ?? null,
            downstream: data.stations.find((station) => station.id === segment.downstreamStationId) ?? null,
            batches: data.batches,
            snapshots: data.snapshots,
            patrols: data.patrols,
            leaks: data.leaks
          })
          rows.push(toRecordRow({ existing: current, segmentId: segment.id, date, result, now }))
          summary.recomputed += 1
        }

        // 删除窗口内未保留的未归档旧记录（如批次删除后该日期已无任何快照）
        const keepIds = new Set(rows.map((row) => row.id))
        const removable = existing.filter(
          (record) =>
            !record.archived &&
            targetDates.includes(record.date) &&
            !keepIds.has(record.id)
        )
        if (removable.length > 0) {
          await db.balanceRecords.bulkDelete(removable.map((record) => record.id))
          summary.deleted += removable.length
        }
        if (rows.length > 0) await db.balanceRecords.bulkPut(rows)
      }
    }
  )

  return summary
}

/* ============================ 区段拓扑写入 ============================ */

function validateSegmentDraft(draft: SegmentDraft, segments: Segment[], selfId?: string): string | null {
  if (!draft.upstreamStationId || !draft.downstreamStationId) return '请选择上、下游站点'
  if (draft.upstreamStationId === draft.downstreamStationId) return '上下游站点不能相同'
  const code = draft.code.trim()
  if (!code) return '请填写区段编号'
  const duplicated = segments.some((segment) => segment.code === code && segment.id !== selfId)
  if (duplicated) return `区段编号 ${code} 已存在`
  return null
}

export async function createSegment(draft: SegmentDraft): Promise<SegmentRow> {
  const segments = await db.segments.toArray()
  const error = validateSegmentDraft(draft, segments)
  if (error) throw new Error(error)
  const now = Date.now()
  const row: SegmentRow = {
    id: createId('seg'),
    code: draft.code.trim(),
    name: draft.name.trim() || draft.code.trim(),
    upstreamStationId: draft.upstreamStationId,
    downstreamStationId: draft.downstreamStationId,
    direction: draft.direction.trim(),
    lengthKm: Number(draft.lengthKm) || 0,
    thresholdM3: Number(draft.thresholdM3) || 0,
    note: draft.note.trim(),
    createdAt: now,
    updatedAt: now,
    revision: ROW_REVISION
  }
  await db.transaction('rw', [db.segments], async () => {
    await db.segments.put(row)
  })
  // 新区段：重算其全部未归档日期
  await recomputeBalance({ segmentIds: [row.id] })
  return row
}

export async function updateSegment(id: string, patch: Partial<SegmentDraft>): Promise<void> {
  await db.transaction('rw', [db.segments], async () => {
    await db.segments.update(id, { ...patch, updatedAt: Date.now() })
  })
  // 拓扑更新：只重算受影响区段的未归档日期
  await recomputeBalance({ segmentIds: [id] })
}

export async function deleteSegmentCascadeBalance(segmentId: string): Promise<void> {
  await db.transaction('rw', [db.segments, db.balanceRecords], async () => {
    await db.balanceRecords.where('segmentId').equals(segmentId).delete()
    await db.segments.delete(segmentId)
  })
}

/* ============================ 流量包导入（带回滚恢复） ============================ */

export interface FlowPacketBackup {
  batches: FlowBatchRow[]
  snapshots: FlowSnapshotRow[]
}

export class ConfirmedBatchError extends Error {
  constructor(batchNo: string) {
    super(`批次 ${batchNo} 已确认，不能重复导入覆盖；请改用「追加修订说明」`)
    this.name = 'ConfirmedBatchError'
  }
}

/** 导入前备份该批次号相关数据，用于写入失败后恢复导入前状态 */
async function backupBeforeImport(batchNo: string): Promise<FlowPacketBackup> {
  const existingBatch = await db.flowBatches.where('batchNo').equals(batchNo).first()
  if (!existingBatch) return { batches: [], snapshots: [] }
  const snapshots = await db.flowSnapshots.where('batchId').equals(existingBatch.id).toArray()
  return { batches: [existingBatch], snapshots }
}

async function restoreImportBackup(backup: FlowPacketBackup): Promise<void> {
  await db.transaction('rw', [db.flowBatches, db.flowSnapshots], async () => {
    if (backup.batches.length > 0) {
      const batchId = backup.batches[0].id
      await db.flowSnapshots.where('batchId').equals(batchId).delete()
      await db.flowBatches.delete(batchId)
      await db.flowBatches.bulkPut(backup.batches)
      await db.flowSnapshots.bulkPut(backup.snapshots)
    }
  })
}

export interface ImportFlowPacketResult {
  batchId: string
  batchNo: string
  snapshotDate: string
  /** 是否为同批次号重复导入（刷新未确认结果） */
  refreshed: boolean
  snapshotCount: number
  recompute: Awaited<ReturnType<typeof recomputeBalance>>
}

/**
 * 导入流量包：
 * - 已确认批次 → 抛 ConfirmedBatchError，不允许覆盖；
 * - 同批次号未确认 → 删除旧快照并整批刷新；
 * - 任一步骤失败 → 事务回滚并恢复导入前批次/快照状态。
 */
export async function importFlowPacket(packet: FlowBatchImport): Promise<ImportFlowPacketResult> {
  if (!packet.batchNo.trim()) throw new Error('批次号不能为空')
  if (!packet.snapshotDate) throw new Error('快照日期不能为空')
  if (packet.rows.length === 0) throw new Error('流量包内没有任何站点快照')

  const stations = await db.stations.toArray()
  const stationByName = new Map(stations.map((station) => [station.name, station.id]))
  const resolved = packet.rows.map((row) => {
    const stationId = stations.some((station) => station.id === row.stationRef)
      ? row.stationRef
      : stationByName.get(row.stationRef) ?? ''
    return { ...row, stationId }
  })
  const unmatched = resolved.filter((row) => !row.stationId)
  if (unmatched.length > 0) {
    throw new Error(`以下站点在台账中不存在：${unmatched.map((row) => row.stationRef).join('、')}`)
  }

  // 导入前状态备份（恢复用）
  const backup = await backupBeforeImport(packet.batchNo)
  const existingBatch = backup.batches[0]
  if (existingBatch?.state === '已确认') {
    throw new ConfirmedBatchError(packet.batchNo)
  }

  const now = Date.now()
  const batchId = existingBatch?.id ?? createId('fb')
  let snapshotCount = 0
  const snapshotResult: RecomputeResult = { recomputed: 0, skippedArchived: 0, deleted: 0 }

  try {
    await db.transaction('rw', [...ALL_TABLES], async () => {
      const batchRow: FlowBatchRow = {
        id: batchId,
        batchNo: packet.batchNo.trim(),
        snapshotDate: packet.snapshotDate,
        recorder: packet.recorder.trim(),
        state: '已导入',
        source: packet.source,
        // 重复导入未确认批次：保留既有修订说明（历史记录不丢）
        revisions: existingBatch?.revisions ?? [],
        importedAt: now,
        createdAt: existingBatch?.createdAt ?? now,
        updatedAt: now,
        revision: ROW_REVISION
      }
      if (existingBatch) {
        await db.flowSnapshots.where('batchId').equals(batchId).delete()
      }
      await db.flowBatches.put(batchRow)

      const snapshotRows: FlowSnapshotRow[] = resolved.map((row) => ({
        id: createId('fs'),
        batchId,
        stationId: row.stationId,
        snapshotDate: packet.snapshotDate,
        inletFlowM3: typeof row.inletFlowM3 === 'number' && Number.isFinite(row.inletFlowM3) ? row.inletFlowM3 : null,
        outletFlowM3: typeof row.outletFlowM3 === 'number' && Number.isFinite(row.outletFlowM3) ? row.outletFlowM3 : null,
        recorder: row.recorder?.trim() || packet.recorder.trim(),
        note: row.note?.trim() ?? '',
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      }))
      // 幂等：同站多行只保留最后一行
      const dedup = new Map<string, FlowSnapshotRow>()
      snapshotRows.forEach((row) => dedup.set(row.stationId, row))
      const uniqueRows = Array.from(dedup.values())
      await db.flowSnapshots.bulkPut(uniqueRows)
      snapshotCount = uniqueRows.length

      // 同事务内重算该日期起受影响的未归档记录（沿用上一有效批次会波及更晚日期）
      const innerSummary = await recomputeWithinTransaction(packet.snapshotDate)
      snapshotResult.skippedArchived = innerSummary.skippedArchived
      snapshotResult.recomputed = innerSummary.recomputed
    })
  } catch (error) {
    // 写入失败：恢复导入前状态（Dexie 已回滚事务，这里再幂等兜底恢复旧批次/快照）
    await restoreImportBackup(backup).catch((restoreError) => {
      console.error('恢复导入前状态失败', restoreError)
    })
    throw error
  }

  return {
    batchId,
    batchNo: packet.batchNo,
    snapshotDate: packet.snapshotDate,
    refreshed: Boolean(existingBatch),
    snapshotCount,
    recompute: snapshotResult
  }
}

/** 事务内重算（供 importFlowPacket 的事务复用） */
async function recomputeWithinTransaction(fromDate: string): Promise<RecomputeResult> {
  const summary: RecomputeResult = { recomputed: 0, skippedArchived: 0, deleted: 0 }
  const [segments, batches, snapshots, patrols, leaks, stations, existingAll] = await Promise.all([
    db.segments.toArray(),
    db.flowBatches.toArray(),
    db.flowSnapshots.toArray(),
    db.patrols.toArray(),
    db.leaks.toArray(),
    db.stations.toArray(),
    db.balanceRecords.toArray()
  ])
  const dates = Array.from(new Set(batches.map((batch) => batch.snapshotDate)))
    .filter((date) => date >= fromDate)
    .sort()
  const existingByKey = new Map(existingAll.map((record) => [`${record.segmentId}:${record.date}`, record]))
  const now = Date.now()
  for (const segment of segments) {
    const rows: BalanceRecordRow[] = []
    for (const date of dates) {
      const key = `${segment.id}:${date}`
      const current = existingByKey.get(key)
      if (current?.archived) {
        rows.push(current)
        summary.skippedArchived += 1
        continue
      }
      const result = computeBalance({
        segment,
        date,
        upstream: stations.find((station) => station.id === segment.upstreamStationId) ?? null,
        downstream: stations.find((station) => station.id === segment.downstreamStationId) ?? null,
        batches,
        snapshots,
        patrols,
        leaks
      })
      rows.push(toRecordRow({ existing: current, segmentId: segment.id, date, result, now }))
      summary.recomputed += 1
    }
    if (rows.length > 0) await db.balanceRecords.bulkPut(rows)
  }
  return summary
}

/* ============================ 批次确认 / 修订 / 删除 ============================ */

/** 确认批次：核算口径生效，并转正该日期起所有沿用/临时结果 */
export async function confirmFlowBatch(batchId: string): Promise<void> {
  const batch = await db.flowBatches.get(batchId)
  if (!batch) throw new Error('流量批次不存在')
  if (batch.state === '已确认') return
  await db.transaction('rw', [db.flowBatches], async () => {
    await db.flowBatches.update(batchId, { state: '已确认', updatedAt: Date.now() })
  })
  // 确认会影响「当日及更晚日期」的沿用/顶班解析
  await recomputeBalance({ fromDate: batch.snapshotDate })
}

/** 已确认批次只能追加修订说明（不改写历史结果，修订作为核算依据展示） */
export async function appendBatchRevision(batchId: string, revision: Omit<FlowBatchRevision, 'at'>): Promise<void> {
  const batch = await db.flowBatches.get(batchId)
  if (!batch) throw new Error('流量批次不存在')
  const note = revision.note.trim()
  if (!note) throw new Error('修订说明不能为空')
  const entry: FlowBatchRevision = { note, author: revision.author.trim() || '未署名', at: Date.now() }
  await db.transaction('rw', [db.flowBatches], async () => {
    await db.flowBatches.update(batchId, {
      revisions: [...(batch.revisions ?? []), entry],
      updatedAt: Date.now()
    })
  })
  // 修订依据追加到该日期起未归档核算记录
  await recomputeBalance({ fromDate: batch.snapshotDate })
}

/** 删除未确认批次及其快照（已确认批次禁止删除，保证审计链完整） */
export async function deleteFlowBatch(batchId: string): Promise<void> {
  const batch = await db.flowBatches.get(batchId)
  if (!batch) return
  if (batch.state === '已确认') throw new Error('已确认批次不能删除，只能追加修订说明')
  const fromDate = batch.snapshotDate
  await db.transaction('rw', [...ALL_TABLES], async () => {
    await db.flowSnapshots.where('batchId').equals(batchId).delete()
    await db.flowBatches.delete(batchId)
  })
  await recomputeBalance({ fromDate })
}

/* ============================ 核算记录归档 ============================ */

/** 归档：保留核算快照，后续拓扑/流量包更新不再重算该日期 */
export async function archiveBalanceRecord(recordId: string): Promise<void> {
  const now = Date.now()
  await db.balanceRecords.update(recordId, { archived: true, archivedAt: now, updatedAt: now })
}

export async function unarchiveBalanceRecord(recordId: string): Promise<void> {
  const record = await db.balanceRecords.get(recordId)
  await db.balanceRecords.update(recordId, { archived: false, archivedAt: 0, updatedAt: Date.now() })
  if (record) await recomputeBalance({ segmentIds: [record.segmentId], fromDate: record.date, toDate: record.date })
}
