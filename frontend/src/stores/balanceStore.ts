/**
 * 气量平衡状态（Zustand）
 * 维护区段拓扑、流量批次/快照、核算记录列表与筛选；写入动作收敛到 balanceEngine。
 * 模块级 liveQuery 订阅 Dexie，拓扑/快照/核算更新后自动回流。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db } from '@/utils/db'
import type { Segment, SegmentDraft } from '@/types/segment'
import type { FlowBatch, FlowBatchImport, FlowBatchRevision } from '@/types/flowBatch'
import type { FlowSnapshot } from '@/types/flowSnapshot'
import type { BalanceRecord, BalanceStatus } from '@/types/balance'
import {
  appendBatchRevision,
  archiveBalanceRecord,
  confirmFlowBatch,
  createSegment,
  deleteFlowBatch,
  deleteSegmentCascadeBalance,
  importFlowPacket,
  unarchiveBalanceRecord,
  updateSegment,
  type ImportFlowPacketResult
} from '@/utils/balanceEngine'

export type BalanceRecordFilterStatus = BalanceStatus | '超阈' | '已归档'

export interface BalanceFilter {
  segmentId: string
  status: BalanceRecordFilterStatus | ''
  onlyPending: boolean
  onlyOverThreshold: boolean
}

interface BalanceState {
  segments: Segment[]
  batches: FlowBatch[]
  snapshots: FlowSnapshot[]
  records: BalanceRecord[]
  ready: boolean
  filter: BalanceFilter
  patchFilter: (patch: Partial<BalanceFilter>) => void
  resetFilter: () => void
  createSegment: (draft: SegmentDraft) => Promise<Segment>
  updateSegment: (id: string, patch: Partial<SegmentDraft>) => Promise<void>
  removeSegment: (id: string) => Promise<void>
  importPacket: (packet: FlowBatchImport) => Promise<ImportFlowPacketResult>
  confirmBatch: (batchId: string) => Promise<void>
  reviseBatch: (batchId: string, revision: Omit<FlowBatchRevision, 'at'>) => Promise<void>
  removeBatch: (batchId: string) => Promise<void>
  archiveRecord: (recordId: string) => Promise<void>
  unarchiveRecord: (recordId: string) => Promise<void>
  snapshotsOfBatch: (batchId: string) => FlowSnapshot[]
  recordsOfSegment: (segmentId: string) => BalanceRecord[]
  filteredRecords: () => BalanceRecord[]
  overThresholdCount: () => number
  pendingCount: () => number
}

function createEmptyFilter(): BalanceFilter {
  return { segmentId: '', status: '', onlyPending: false, onlyOverThreshold: false }
}

export const useBalanceStore = create<BalanceState>((set, get) => ({
  segments: [],
  batches: [],
  snapshots: [],
  records: [],
  ready: false,
  filter: createEmptyFilter(),

  patchFilter(patch) {
    set({ filter: { ...get().filter, ...patch } })
  },

  resetFilter() {
    set({ filter: createEmptyFilter() })
  },

  async createSegment(draft) {
    return createSegment(draft)
  },

  async updateSegment(id, patch) {
    await updateSegment(id, patch)
  },

  async removeSegment(id) {
    await deleteSegmentCascadeBalance(id)
  },

  async importPacket(packet) {
    return importFlowPacket(packet)
  },

  async confirmBatch(batchId) {
    await confirmFlowBatch(batchId)
  },

  async reviseBatch(batchId, revision) {
    await appendBatchRevision(batchId, revision)
  },

  async removeBatch(batchId) {
    await deleteFlowBatch(batchId)
  },

  async archiveRecord(recordId) {
    await archiveBalanceRecord(recordId)
  },

  async unarchiveRecord(recordId) {
    await unarchiveBalanceRecord(recordId)
  },

  snapshotsOfBatch(batchId) {
    return get().snapshots.filter((snapshot) => snapshot.batchId === batchId)
  },

  recordsOfSegment(segmentId) {
    return get().records.filter((record) => record.segmentId === segmentId)
  },

  filteredRecords() {
    const { records, filter } = get()
    return records
      .filter((record) => {
        if (filter.segmentId && record.segmentId !== filter.segmentId) return false
        if (filter.onlyPending && record.status !== '待补') return false
        if (filter.onlyOverThreshold && !record.overThreshold) return false
        if (filter.status === '待补' && record.status !== '待补') return false
        if (filter.status === '已核算' && record.status !== '已核算') return false
        if (filter.status === '超阈' && !record.overThreshold) return false
        if (filter.status === '已归档' && !record.archived) return false
        return true
      })
      .sort((a, b) => b.date.localeCompare(a.date) || a.segmentId.localeCompare(b.segmentId))
  },

  overThresholdCount() {
    return get().records.filter((record) => record.overThreshold && !record.archived).length
  },

  pendingCount() {
    return get().records.filter((record) => record.status === '待补' && !record.archived).length
  }
}))

liveQuery(async () => (await db.segments.toArray()).sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))).subscribe({
  next: (rows) => useBalanceStore.setState({ segments: rows, ready: true }),
  error: () => useBalanceStore.setState({ ready: true })
})

liveQuery(async () =>
  (await db.flowBatches.toArray()).sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate) || b.importedAt - a.importedAt)
).subscribe({
  next: (rows) => useBalanceStore.setState({ batches: rows })
})

liveQuery(async () => (await db.flowSnapshots.toArray()).sort((a, b) => a.stationId.localeCompare(b.stationId))).subscribe({
  next: (rows) => useBalanceStore.setState({ snapshots: rows })
})

liveQuery(async () =>
  (await db.balanceRecords.toArray()).sort((a, b) => b.date.localeCompare(a.date) || a.segmentId.localeCompare(b.segmentId))
).subscribe({
  next: (rows) => useBalanceStore.setState({ records: rows })
})
