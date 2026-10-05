/**
 * 气量平衡核算引擎（纯函数，无 Dexie / React 依赖，可单测）
 *
 * 口径：
 * 1. 区段损耗 = 上游站出口流量 − 下游站进口流量；损耗率 = 损耗 / 上游出口 × 100。
 * 2. 进口/出口读数缺失、上游出口为 0（无计算基准）→ 状态「待补依据」，损耗保持 null，绝不算成 0。
 * 3. 当天关联泄漏处置单未复检（待处置 / 已处置）→ 「待补依据」：现场结论未定案，不能把损耗归零。
 * 4. 待补依据时沿用上一有效批次（仅取「已核算」结果），并记录 carryFrom；无历史有效批次则损耗为空。
 * 5. 当天巡检与泄漏处置单结论随结果快照留档（巡检漏检/异常仅作依据提示，不阻断核算）。
 * 6. 仅返回签名变化的未归档行；已确认批次对应日期（archived）永不覆盖。
 */
import {
  balanceRowId,
  type BalanceEvidenceLeak,
  type BalanceEvidencePatrol,
  type CarryRef,
  type FlowBatch,
  type FlowSnapshot,
  type PipeSegment,
  type SegmentBalance
} from '@/types/balance'

/* ---------------- 结构化输入（避免与 IndexedDB 行类型耦合） ---------------- */

export interface StationLike {
  id: string
  name: string
}

export interface ReadingLike {
  pointId: string
  isAbnormal: boolean
}

interface PatrolEvidenceInput {
  id: string
  stationId: string
  planDate: string
  patrolDate: string
  patrolman: string
  envNote: string
  state: string
  readings: ReadingLike[]
}

export interface LeakLike {
  id: string
  stationId: string
  concentrationPpm: number
  foundTime: string
  state: string
  retestValuePpm: number
  measure: string
  handler: string
}

/** 泄漏处置单未复检的状态（现场结论未定案） */
const OPEN_LEAK_STATES = new Set(['待处置', '已处置'])

export interface EngineInput {
  segments: PipeSegment[]
  stations: StationLike[]
  batches: FlowBatch[]
  snapshots: FlowSnapshot[]
  patrols: PatrolEvidenceInput[]
  leaks: LeakLike[]
  /** 现存核算结果（未归档重算、已归档冻结、上一有效批次沿用都依赖它） */
  existing: SegmentBalance[]
  now: number
}

export interface EngineResult {
  /** 需要写入 / 更新的行（已含归档快照行，archived=true） */
  upserts: SegmentBalance[]
  /** 区段仍存在但输入签名失效、应删除的未归档行 id */
  staleDeletes: string[]
}

/* ----------------------------- 小工具 ----------------------------- */

/** 稳定的输入签名：输入不变则结果不变 */
export function signatureOf(parts: Array<unknown>): string {
  const json = JSON.stringify(parts)
  let hash = 5381
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash * 33) ^ json.charCodeAt(i)
  }
  return `sig_${(hash >>> 0).toString(36)}_${json.length}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/* ----------------------------- 依据收集 ----------------------------- */

/** 该业务日期关联的巡检：实际/计划日期等于业务日期（实际优先） */
function patrolsOnDate(patrols: PatrolEvidenceInput[], stationIds: Set<string>, bizDate: string): PatrolEvidenceInput[] {
  return patrols.filter((patrol) => {
    if (!stationIds.has(patrol.stationId)) return false
    const effective = patrol.patrolDate || patrol.planDate
    return effective === bizDate
  })
}

/** 该业务日期关联的泄漏处置单：发现日期等于业务日期 */
function leaksOnDate(leaks: LeakLike[], stationIds: Set<string>, bizDate: string): LeakLike[] {
  return leaks.filter((leak) => stationIds.has(leak.stationId) && leak.foundTime === bizDate)
}

function buildPatrolEvidence(list: PatrolEvidenceInput[], nameOf: (id: string) => string): BalanceEvidencePatrol[] {
  return list.map((patrol) => ({
    patrolId: patrol.id,
    stationId: patrol.stationId,
    stationName: nameOf(patrol.stationId),
    patrolman: patrol.patrolman,
    effectiveDate: patrol.patrolDate || patrol.planDate,
    state: patrol.state,
    abnormalCount: patrol.readings.filter((reading) => reading.isAbnormal).length,
    envNote: patrol.envNote
  }))
}

function buildLeakEvidence(list: LeakLike[], nameOf: (id: string) => string): BalanceEvidenceLeak[] {
  return list.map((leak) => ({
    leakId: leak.id,
    stationId: leak.stationId,
    stationName: nameOf(leak.stationId),
    concentrationPpm: leak.concentrationPpm,
    foundTime: leak.foundTime,
    state: leak.state,
    retestValuePpm: leak.retestValuePpm,
    measure: leak.measure,
    handler: leak.handler
  }))
}

/** 上一有效批次：严格早于当前日期、状态「已核算」、同区段最近的一条 */
export function findCarry(validBefore: SegmentBalance[], bizDate: string): SegmentBalance | null {
  const earlier = validBefore
    .filter((row) => row.status === '已核算' && row.bizDate < bizDate && row.lossM3h !== null)
    .sort((a, b) => b.bizDate.localeCompare(a.bizDate))
  return earlier[0] ?? null
}

function toCarryRef(row: SegmentBalance | null): CarryRef | null {
  if (!row || row.lossM3h === null || row.lossRatePct === null) return null
  return {
    batchId: row.batchId,
    batchNo: row.batchNo,
    bizDate: row.bizDate,
    lossM3h: row.lossM3h,
    lossRatePct: row.lossRatePct
  }
}

/* ----------------------------- 单行核算 ----------------------------- */

export interface BalanceContext {
  segment: PipeSegment
  batch: FlowBatch
  snapshotOf: Map<string, FlowSnapshot>
  patrols: PatrolEvidenceInput[]
  leaks: LeakLike[]
  existing: SegmentBalance | undefined
  carry: SegmentBalance | null
  nameOf: (id: string) => string
  now: number
}

/** 计算单个区段 × 日期（已冻结日期除外），保留既有修订说明与归档标记 */
export function buildBalanceRow(ctx: BalanceContext): SegmentBalance {
  const { segment, batch, snapshotOf, patrols, leaks, existing, carry, now } = ctx
  // 站点已删除时保留上一次台账里的名称快照，便于归档/沿用记录可读
  const nameOf = (id: string): string => {
    const current = ctx.nameOf(id)
    if (current !== '已删除站点') return current
    if (existing && id === existing.upstreamStationId) return existing.upstreamStationName
    if (existing && id === existing.downstreamStationId) return existing.downstreamStationName
    return '已删除站点'
  }
  const upstream = snapshotOf.get(segment.upstreamStationId)
  const downstream = snapshotOf.get(segment.downstreamStationId)
  const upstreamOutlet = upstream?.outletFlowM3h ?? null
  const downstreamInlet = downstream?.inletFlowM3h ?? null

  const stationIds = new Set([segment.upstreamStationId, segment.downstreamStationId])
  const patrolEvidence = buildPatrolEvidence(patrolsOnDate(patrols, stationIds, batch.bizDate), nameOf)
  const leakEvidence = buildLeakEvidence(leaksOnDate(leaks, stationIds, batch.bizDate), nameOf)

  const pendingReasons: string[] = []

  // 读数缺失：不能把损耗算成零
  if (!isFiniteNumber(upstreamOutlet)) {
    pendingReasons.push(`上游站「${nameOf(segment.upstreamStationId)}」出口流量缺失，待补抄表快照`)
  }
  if (!isFiniteNumber(downstreamInlet)) {
    pendingReasons.push(`下游站「${nameOf(segment.downstreamStationId)}」进口流量缺失，待补抄表快照`)
  }
  if (isFiniteNumber(upstreamOutlet) && upstreamOutlet === 0) {
    pendingReasons.push('上游站出口流量为 0，缺少损耗率计算基准')
  }
  if (isFiniteNumber(upstreamOutlet) && isFiniteNumber(downstreamInlet) && downstreamInlet > upstreamOutlet + 1e-6) {
    pendingReasons.push('下游进口流量大于上游出口，表计方向或快照需复核')
  }

  // 处置未复检：现场结论未定案
  leakEvidence.forEach((leak) => {
    if (OPEN_LEAK_STATES.has(leak.state)) {
      pendingReasons.push(
        `泄漏处置单「${leak.stationName} ${leak.concentrationPpm} ppm」状态为${leak.state}，尚未复检闭环，损耗口径待现场结论`
      )
    }
  })

  // 巡检提示（不阻断核算，仅作为依据）
  patrolEvidence.forEach((patrol) => {
    if (patrol.state === '漏检') {
      pendingReasons.push(`「${patrol.stationName}」当日巡检漏检，现场结论缺失，建议补检`)
    }
  })

  const signature = signatureOf([
    segment.id,
    segment.name,
    segment.upstreamStationId,
    segment.downstreamStationId,
    nameOf(segment.upstreamStationId),
    nameOf(segment.downstreamStationId),
    segment.lossRateThresholdPct,
    batch.id,
    batch.batchNo,
    upstreamOutlet,
    downstreamInlet,
    patrolEvidence,
    leakEvidence
  ])

  const rowId = balanceRowId(segment.id, batch.bizDate)
  const base: SegmentBalance = {
    id: rowId,
    segmentId: segment.id,
    bizDate: batch.bizDate,
    batchId: batch.id,
    batchNo: batch.batchNo,
    segmentName: segment.name,
    upstreamStationId: segment.upstreamStationId,
    downstreamStationId: segment.downstreamStationId,
    upstreamStationName: nameOf(segment.upstreamStationId),
    downstreamStationName: nameOf(segment.downstreamStationId),
    thresholdPct: segment.lossRateThresholdPct,
    upstreamOutletM3h: upstreamOutlet,
    downstreamInletM3h: downstreamInlet,
    lossM3h: null,
    lossRatePct: null,
    overThreshold: false,
    status: '已核算',
    pendingReasons: [],
    patrolEvidence,
    leakEvidence,
    carryFrom: null,
    inputSignature: signature,
    archived: existing?.archived ?? false,
    frozenAt: existing?.frozenAt ?? null,
    revisionNotes: existing?.revisionNotes ?? [],
    computedAt: existing?.computedAt ?? now,
    updatedAt: now
  }

  if (pendingReasons.length === 0) {
    const loss = round2((upstreamOutlet as number) - (downstreamInlet as number))
    const rate = round2((loss / (upstreamOutlet as number)) * 100)
    base.lossM3h = loss
    base.lossRatePct = rate
    base.overThreshold = Math.abs(rate) > segment.lossRateThresholdPct
    base.status = '已核算'
    return base
  }

  // 待补依据：损耗绝不算零，沿用上一有效批次（冻结时保留既有沿用，不回退为 null）
  base.status = '待补依据'
  base.pendingReasons = pendingReasons
  const carryRef = toCarryRef(carry) ?? existing?.carryFrom ?? null
  base.carryFrom = carryRef
  if (carryRef) {
    base.overThreshold = Math.abs(carryRef.lossRatePct) > segment.lossRateThresholdPct
  }
  return base
}

/* ----------------------------- 全量增量重算 ----------------------------- */

/**
 * 以「全部批次 × 全部现存区段」为核算空间：
 * - 已确认批次的日期：只补齐冻结快照行（播种 / 整库导入场景），已有行原样保留；
 * - 未确认日期：按业务日期升序逐日计算，保证「上一有效批次」可沿用到更早的已核算结果；
 * - 签名未变的行不写入，输入失效的未归档行删除。
 */
export function recomputeBalances(input: EngineInput): EngineResult {
  const { segments, stations, batches, snapshots, patrols, leaks, existing, now } = input
  const nameOf = (id: string): string => stations.find((station) => station.id === id)?.name ?? '已删除站点'

  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const existingById = new Map(existing.map((row) => [row.id, row]))
  const confirmedDates = new Set(batches.filter((batch) => batch.state === '已确认').map((batch) => batch.bizDate))

  // 冻结快照：播种 / 整库导入后库里缺已确认日期的行时补齐；已有归档行完全保留
  const frozenUpserts: SegmentBalance[] = []
  batches
    .filter((batch) => batch.state === '已确认')
    .forEach((batch) => {
      segments.forEach((segment) => {
        const id = balanceRowId(segment.id, batch.bizDate)
        if (existingById.has(id)) return
        const snapshotOf = new Map(
          snapshots.filter((snapshot) => snapshot.batchId === batch.id).map((snapshot) => [snapshot.stationId, snapshot])
        )
        frozenUpserts.push(
          Object.assign(
            buildBalanceRow({
              segment,
              batch,
              snapshotOf,
              patrols,
              leaks,
              existing: undefined,
              carry: null,
              nameOf,
              now
            }),
            { archived: true, frozenAt: batch.confirmedAt ?? now }
          )
        )
      })
    })

  // 未确认日期升序处理，同日期内顺序无关（沿用只看更早日期）
  const openBatches = batches.filter((batch) => batch.state !== '已确认').sort((a, b) => a.bizDate.localeCompare(b.bizDate))

  // 沿用索引：每区段维护严格早于当前日期的有效结果（含既有与本次新算）
  const validBySegment = new Map<string, SegmentBalance[]>()
  const pushValid = (row: SegmentBalance): void => {
    if (row.status !== '已核算' || row.lossM3h === null) return
    if (!validBySegment.has(row.segmentId)) validBySegment.set(row.segmentId, [])
    validBySegment.get(row.segmentId)!.push(row)
  }
  existing.forEach(pushValid)
  frozenUpserts.forEach(pushValid)

  const dirtyUpserts: SegmentBalance[] = []
  const keptIds = new Set<string>()

  openBatches.forEach((batch) => {
    const snapshotOf = new Map(
      snapshots.filter((snapshot) => snapshot.batchId === batch.id).map((snapshot) => [snapshot.stationId, snapshot])
    )
    segments.forEach((segment) => {
      const id = balanceRowId(segment.id, batch.bizDate)
      keptIds.add(id)
      const prev = existingById.get(id)

      // 先取上一有效批次（严格更早日期），再计算
      const carry = findCarry(validBySegment.get(segment.id) ?? [], batch.bizDate)
      const row = buildBalanceRow({ segment, batch, snapshotOf, patrols, leaks, existing: prev, carry, nameOf, now })

      if (prev && prev.inputSignature === row.inputSignature) {
        // 输入未变：保留原行（有效结果已在沿用索引中）
        return
      }
      dirtyUpserts.push(row)
      pushValid(row)
    })
  })

  // 失效清理：区段已删 / 批次已删 / 批次仍在但日期已确认归档的未归档行
  const liveBatchIds = new Set(batches.map((batch) => batch.id))
  const staleDeletes = existing
    .filter((row) => {
      if (row.archived) return false
      if (!segmentById.has(row.segmentId)) return true
      if (!liveBatchIds.has(row.batchId)) return true
      if (confirmedDates.has(row.bizDate)) return true
      if (!keptIds.has(row.id)) return true
      return false
    })
    .map((row) => row.id)

  return { upserts: [...frozenUpserts, ...dirtyUpserts], staleDeletes }
}

/** 批量确认批次时构造冻结行：保留已算结果，仅打归档标记；缺失的行补齐并冻结 */
export function buildBatchBalances(
  batch: FlowBatch,
  segments: PipeSegment[],
  snapshots: FlowSnapshot[],
  patrols: PatrolEvidenceInput[],
  leaks: LeakLike[],
  stations: StationLike[],
  existing: SegmentBalance[],
  now: number
): SegmentBalance[] {
  const nameOf = (id: string): string => stations.find((station) => station.id === id)?.name ?? '已删除站点'
  const snapshotOf = new Map(
    snapshots.filter((snapshot) => snapshot.batchId === batch.id).map((snapshot) => [snapshot.stationId, snapshot])
  )
  const existingById = new Map(existing.map((row) => [row.id, row]))
  const validBySegment = new Map<string, SegmentBalance[]>()
  existing
    .filter((row) => row.status === '已核算' && row.lossM3h !== null && row.bizDate < batch.bizDate)
    .forEach((row) => {
      if (!validBySegment.has(row.segmentId)) validBySegment.set(row.segmentId, [])
      validBySegment.get(row.segmentId)!.push(row)
    })

  return segments.map((segment) => {
    const carry = findCarry(validBySegment.get(segment.id) ?? [], batch.bizDate)
    return buildBalanceRow({
      segment,
      batch,
      snapshotOf,
      patrols,
      leaks,
      existing: existingById.get(balanceRowId(segment.id, batch.bizDate)),
      carry,
      nameOf,
      now
    })
  })
}

/** 批量确认批次时构造冻结行：保留已算结果，仅打归档标记；缺失的行补齐并冻结 */
export function freezeForConfirmation(
  batch: FlowBatch,
  segments: PipeSegment[],
  snapshots: FlowSnapshot[],
  patrols: PatrolEvidenceInput[],
  leaks: LeakLike[],
  stations: StationLike[],
  existing: SegmentBalance[],
  now: number
): SegmentBalance[] {
  const nameOf = (id: string): string => stations.find((station) => station.id === id)?.name ?? '已删除站点'
  const snapshotOf = new Map(
    snapshots.filter((snapshot) => snapshot.batchId === batch.id).map((snapshot) => [snapshot.stationId, snapshot])
  )
  const existingById = new Map(existing.map((row) => [row.id, row]))
  // 沿用历史有效批次（确认动作只冻结，不重新判定待补口径）
  const validEarlier = existing.filter(
    (row) => row.status === '已核算' && row.lossM3h !== null && row.bizDate < batch.bizDate
  )

  return segments.map((segment) => {
    const id = balanceRowId(segment.id, batch.bizDate)
    const prev = existingById.get(id)
    const row = buildBalanceRow({
      segment,
      batch,
      snapshotOf,
      patrols,
      leaks,
      existing: prev ? { ...prev, archived: true, frozenAt: now } : undefined,
      carry: findCarry(validEarlier.filter((item) => item.segmentId === segment.id), batch.bizDate),
      nameOf,
      now
    })
    return { ...row, archived: true, frozenAt: now }
  })
}
