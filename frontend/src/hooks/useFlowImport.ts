/**
 * 流量包导入：解析 JSON 流量包 → 生成可编辑的站点快照行 → 校验后提交。
 * 读数缺失（null/空）原样保留为缺失，核算口径负责沿用上一有效批次，不在导入端补 0。
 */
import { useCallback, useMemo, useState } from 'react'
import { useBalanceStore } from '@/stores/balanceStore'
import { useStationStore } from '@/stores/stationStore'
import type { FlowBatchImport } from '@/types/flowBatch'
import type { FlowPacketFile } from '@/types/flowBatch'
import type { FlowSnapshotDraft } from '@/types/flowSnapshot'
import { download } from '@/utils/export'

export interface EditableSnapshotRow extends FlowSnapshotDraft {
  /** 解析时是否匹配到台账站点 */
  matched: boolean
}

export interface FlowImportDraft {
  batchNo: string
  snapshotDate: string
  recorder: string
  /** 导入来源：json 导入 / 手工录入 */
  source: 'json' | 'manual'
  rows: EditableSnapshotRow[]
}

export interface UseFlowImportResult {
  draft: FlowImportDraft
  parsing: boolean
  setField: (field: 'batchNo' | 'snapshotDate' | 'recorder', value: string) => void
  setRow: (index: number, patch: Partial<EditableSnapshotRow>) => void
  parseFile: (file: File) => Promise<void>
  parseText: (text: string) => void
  buildManualDraft: () => void
  reset: () => void
  validate: () => string | null
  submit: () => Promise<{ refreshed: boolean; snapshotCount: number } | null>
  downloadTemplate: () => void
}

function emptyDraft(): FlowImportDraft {
  return { batchNo: '', snapshotDate: '', recorder: '', source: 'manual', rows: [] }
}

/** 流量包 JSON 模板内容（模板下载） */
export function flowPacketTemplate(): FlowPacketFile {
  return {
    batchNo: 'FB20240620-01',
    snapshotDate: '2024-06-20',
    recorder: '王强',
    snapshots: [
      { station: '城东高中压调压站', inletFlowM3: 9000, outletFlowM3: 8200, recorder: '王强', note: '' },
      { station: '西城新区调压站', inletFlowM3: null, outletFlowM3: 6100, recorder: '王强', note: '进口表计故障未抄回，留空' }
    ]
  }
}

export function useFlowImport(onImported?: () => void): UseFlowImportResult {
  const balanceStore = useBalanceStore()
  const stationStore = useStationStore()
  const [draft, setDraft] = useState<FlowImportDraft>(emptyDraft)
  const [parsing, setParsing] = useState(false)

  const stationIds = useMemo(() => new Set(stationStore.stations.map((station) => station.id)), [stationStore.stations])
  const stationNames = useMemo(() => new Set(stationStore.stations.map((station) => station.name)), [stationStore.stations])

  const matchRows = useCallback(
    (rows: FlowSnapshotDraft[]): EditableSnapshotRow[] =>
      rows.map((row) => ({
        ...row,
        matched: stationIds.has(row.stationRef) || stationNames.has(row.stationRef)
      })),
    [stationIds, stationNames]
  )

  const applyPacket = useCallback(
    (packet: FlowPacketFile): void => {
      const rows: FlowSnapshotDraft[] = (packet.snapshots ?? []).map((snapshot) => ({
        stationRef: String(snapshot.station ?? ''),
        inletFlowM3: snapshot.inletFlowM3 === null || snapshot.inletFlowM3 === undefined ? null : Number(snapshot.inletFlowM3),
        outletFlowM3:
          snapshot.outletFlowM3 === null || snapshot.outletFlowM3 === undefined ? null : Number(snapshot.outletFlowM3),
        recorder: snapshot.recorder ?? '',
        note: snapshot.note ?? ''
      }))
      setDraft({
        batchNo: String(packet.batchNo ?? ''),
        snapshotDate: String(packet.snapshotDate ?? ''),
        recorder: String(packet.recorder ?? ''),
        source: 'json',
        rows: matchRows(rows)
      })
    },
    [matchRows]
  )

  const parseText = useCallback(
    (text: string): void => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('流量包不是合法的 JSON，请检查文件内容')
      }
      const packet = parsed as Partial<FlowPacketFile>
      if (!packet || typeof packet !== 'object' || !Array.isArray(packet.snapshots)) {
        throw new Error('流量包缺少 snapshots 站点快照数组')
      }
      applyPacket(packet as FlowPacketFile)
    },
    [applyPacket]
  )

  const parseFile = useCallback(
    async (file: File): Promise<void> => {
      setParsing(true)
      try {
        const text = await file.text()
        parseText(text)
      } finally {
        setParsing(false)
      }
    },
    [parseText]
  )

  const buildManualDraft = useCallback((): void => {
    setDraft({
      batchNo: '',
      snapshotDate: new Date().toISOString().slice(0, 10),
      recorder: '',
      source: 'manual',
      rows: stationStore.stations.map((station) => ({
        stationRef: station.id,
        inletFlowM3: null,
        outletFlowM3: null,
        recorder: '',
        note: '',
        matched: true
      }))
    })
  }, [stationStore.stations])

  const setField = useCallback((field: 'batchNo' | 'snapshotDate' | 'recorder', value: string): void => {
    setDraft((prev) => ({ ...prev, [field]: value }))
  }, [])

  const setRow = useCallback((index: number, patch: Partial<EditableSnapshotRow>): void => {
    setDraft((prev) => {
      const rows = prev.rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))
      return { ...prev, rows }
    })
  }, [])

  const reset = useCallback(() => setDraft(emptyDraft()), [])

  const validate = useCallback((): string | null => {
    if (!draft.batchNo.trim()) return '请填写批次号'
    if (!draft.snapshotDate) return '请选择快照日期'
    if (draft.rows.length === 0) return '请至少添加一个站点快照'
    if (draft.rows.some((row) => !row.matched)) return '存在无法匹配台账站点的行，请修正站点'
    return null
  }, [draft])

  const submit = useCallback(async (): Promise<{ refreshed: boolean; snapshotCount: number } | null> => {
    const error = validate()
    if (error) throw new Error(error)
    const packet: FlowBatchImport = {
      batchNo: draft.batchNo.trim(),
      snapshotDate: draft.snapshotDate,
      recorder: draft.recorder.trim(),
      source: draft.source,
      rows: draft.rows.map((row) => ({
        stationRef: row.stationRef,
        inletFlowM3: row.inletFlowM3,
        outletFlowM3: row.outletFlowM3,
        recorder: row.recorder,
        note: row.note
      }))
    }
    const result = await balanceStore.importPacket(packet)
    onImported?.()
    return { refreshed: result.refreshed, snapshotCount: result.snapshotCount }
  }, [draft, validate, balanceStore, onImported])

  const downloadTemplate = useCallback((): void => {
    download(
      '流量包导入模板.json',
      JSON.stringify(flowPacketTemplate(), null, 2),
      'application/json;charset=utf-8'
    )
  }, [])

  return {
    draft,
    parsing,
    setField,
    setRow,
    parseFile,
    parseText,
    buildManualDraft,
    reset,
    validate,
    submit,
    downloadTemplate
  }
}
