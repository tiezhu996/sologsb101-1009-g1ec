/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import type { FlowBatch, FlowSnapshot, PipeSegment, SegmentBalance } from '@/types/balance'
import { deviationPctOf, judgeReading } from '@/utils/range'
import { freezeForConfirmation } from '@/utils/balanceEngine'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyAbnormal: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyAbnormal: false }

export interface BackupPayload {
  app: 'gbgaspress'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  devices: Device[]
  points: Point[]
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  pipeSegments: PipeSegment[]
  flowBatches: FlowBatch[]
  flowSnapshots: FlowSnapshot[]
  segmentBalances: SegmentBalance[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned
export type PipeSegmentRow = PipeSegment & Revisioned
export type FlowBatchRow = FlowBatch & Revisioned
export type FlowSnapshotRow = FlowSnapshot & Revisioned
export type SegmentBalanceRow = SegmentBalance & Revisioned

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  pipeSegments!: Table<PipeSegmentRow, string>
  flowBatches!: Table<FlowBatchRow, string>
  flowSnapshots!: Table<FlowSnapshotRow, string>
  segmentBalances!: Table<SegmentBalanceRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })

    // v2：点位/泄漏补 stationId 冗余列（按站点筛选免联表）；读数补 revision 与 note
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        // 迁移：点位缺少 stationId 时用所属设备回填
        const devices = (await tx.table('devices').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfDevice = new Map(devices.map((device) => [device.id, device.stationId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.stationId !== 'string' || point.stationId.length === 0) {
              point.stationId = stationOfDevice.get(String(point.deviceId)) ?? ''
            }
            if (typeof point.isCritical !== 'boolean') point.isCritical = false
          })

        // 迁移：泄漏处置补 stationId、复检值与病态状态
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.stationId !== 'string' || leak.stationId.length === 0) {
              leak.stationId = stationOfDevice.get(String(leak.deviceId)) ?? ''
            }
            if (typeof leak.retestValuePpm !== 'number' || !Number.isFinite(leak.retestValuePpm)) {
              leak.retestValuePpm = 0
            }
            if (leak.state !== '待处置' && leak.state !== '已处置' && leak.state !== '已复检') {
              leak.state = '待处置'
            }
          })

        // 迁移：读数补 note，并按偏差率重算 isAbnormal / deviationPct
        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
          isCritical: boolean
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const point = pointMap.get(String(reading.pointId))
            const value = Number(reading.value)
            if (point && Number.isFinite(value)) {
              const judgement = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
            } else {
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
            }
          })
      })

    // v3：气量平衡台 —— 站间有向区段、流量包批次/快照、区段日核算结果
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt',
        pipeSegments: 'id, upstreamStationId, downstreamStationId, updatedAt',
        flowBatches: 'id, batchNo, bizDate, state, importedAt, updatedAt',
        flowSnapshots: 'id, batchId, stationId',
        segmentBalances: 'id, segmentId, bizDate, batchId, status, archived, overThreshold, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['pipeSegments', 'flowBatches', 'flowSnapshots', 'segmentBalances']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '城东高中压调压站', location: '城东工业园区 A 区', designFlowM3h: 8000, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '2016-05-20', createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '西城新区调压站', location: '西城新区纬三路', designFlowM3h: 5000, inletPressureMpa: 0.2, grade: '中中压', commissionDate: '2019-08-12', createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_DEVICES: DeviceRow[] = [
  { id: 'dv-1', stationId: 'st-1', type: '调压器', model: 'RTZ-80/0.4', serialNo: 'SN20160520-01', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-2', stationId: 'st-1', type: '过滤器', model: 'GL-80', serialNo: 'SN20160520-02', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-3', stationId: 'st-1', type: '切断阀', model: 'QT-80', serialNo: 'SN20160520-03', installDate: '2016-05-20', state: '检修', createdAt: stamp(-289), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'dv-4', stationId: 'st-2', type: '调压器', model: 'RTZ-50/0.2', serialNo: 'SN20190812-01', installDate: '2019-08-12', state: '运行', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'dv-5', stationId: 'st-2', type: '放散阀', model: 'FS-50', serialNo: 'SN20190812-02', installDate: '2019-08-12', state: '运行', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_PATROLS: PatrolRow[] = [
  { id: 'pa-1', stationId: 'st-1', planDate: '2024-06-05', patrolDate: '2024-06-05', patrolman: '张伟', envNote: '晴，气温 26℃', state: '已完成', createdAt: stamp(-15), updatedAt: stamp(-15), revision: ROW_REVISION },
  { id: 'pa-2', stationId: 'st-1', planDate: '2024-06-12', patrolDate: '2024-06-12', patrolman: '张伟', envNote: '多云，风力 3 级', state: '已完成', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'pa-3', stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pa-4', stationId: 'st-2', planDate: '2024-06-06', patrolDate: '2024-06-08', patrolman: '李娜', envNote: '中雨，到场延迟 2 天', state: '已完成', createdAt: stamp(-14), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'pa-5', stationId: 'st-2', planDate: '2024-06-13', patrolDate: '', patrolman: '李娜', envNote: '计划未执行，人员调休', state: '漏检', createdAt: stamp(-7), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'pa-6', stationId: 'st-2', planDate: '2024-06-20', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的读数原始行：[巡检, 点位, 读数, 备注] */
const SEED_READING_ROWS: Array<[string, string, number, string]> = [
  ['pa-1', 'pt-1', 0.41, ''],
  ['pa-1', 'pt-2', 0.23, ''],
  ['pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味'],
  ['pa-2', 'pt-1', 0.38, ''],
  ['pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度'],
  ['pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹'],
  ['pa-2', 'pt-5', 55, '法兰处检出微量泄漏'],
  ['pa-4', 'pt-7', 0.21, ''],
  ['pa-4', 'pt-8', 0.145, ''],
  ['pa-4', 'pt-9', 12, ''],
  ['pa-4', 'pt-10', 88, '阀体密封处浓度偏高']
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION }
]

/* ======================== 气量平衡演示数据（v3） ======================== */

const SEED_SEGMENT: PipeSegmentRow = {
  id: 'sg-1',
  name: '城东—西城连通段',
  upstreamStationId: 'st-1',
  downstreamStationId: 'st-2',
  lossRateThresholdPct: 3,
  remark: '高中压出站至西城新区方向，历史日均损耗约 1%~2%',
  createdAt: stamp(-200),
  updatedAt: stamp(-200),
  revision: ROW_REVISION
}

/** 批次种子：[批次号, 业务日期, 状态, 抄回人, 说明, 上游出口, 下游进口] */
const SEED_BATCH_ROWS: Array<[string, string, FlowBatch['state'], string, string, number | null, number | null]> = [
  ['FB20240603', '2024-06-03', '已确认', '王强', 'SCADA 流量日报，计量班复核', 7650, 7576],
  ['FB20240605', '2024-06-05', '已确认', '王强', '城东阀体漏点当日，处置单复检合格闭环', 7600, 7340],
  ['FB20240612', '2024-06-12', '待确认', '王强', '法兰漏点处置单尚未复检，损耗口径待现场结论', 7400, 7150],
  ['FB20240619', '2024-06-19', '待确认', '刘洋', '城东出口表计远传缺失，现场表待抄', null, 6900]
]

function buildSeedFlowData(): {
  batches: FlowBatchRow[]
  snapshots: FlowSnapshotRow[]
} {
  const batches: FlowBatchRow[] = []
  const snapshots: FlowSnapshotRow[] = []
  SEED_BATCH_ROWS.forEach(([batchNo, bizDate, state, collector, detail, st1Outlet, st2Inlet], index) => {
    const batchTs = stamp(-17 + index)
    const batch: FlowBatchRow = {
      id: `fb-${index + 1}`,
      batchNo,
      bizDate,
      collector,
      source: 'SCADA 流量日报',
      state,
      importedAt: batchTs,
      confirmedAt: state === '已确认' ? batchTs + 3600000 : null,
      confirmedBy: state === '已确认' ? '调度值班长' : '',
      snapshotCount: 2,
      auditTrail: [
        { at: batchTs, action: '导入', operator: collector, detail },
        ...(state === '已确认'
          ? [{ at: batchTs + 3600000, action: '确认' as const, operator: '调度值班长', detail: '当日损耗核算无误，归档台账' }]
          : [])
      ],
      createdAt: batchTs,
      updatedAt: batchTs,
      revision: ROW_REVISION
    }
    batches.push(batch)
    snapshots.push(
      {
        id: `fs-${index + 1}a`,
        batchId: batch.id,
        stationId: 'st-1',
        inletFlowM3h: 7700,
        outletFlowM3h: st1Outlet,
        note: st1Outlet === null ? '出口表计未抄回' : '',
        createdAt: batchTs,
        updatedAt: batchTs,
        revision: ROW_REVISION
      },
      {
        id: `fs-${index + 1}b`,
        batchId: batch.id,
        stationId: 'st-2',
        inletFlowM3h: st2Inlet,
        outletFlowM3h: st2Inlet === null ? null : Math.round(st2Inlet * 0.96),
        note: st2Inlet === null ? '进口远传缺失，待现场抄表' : '',
        createdAt: batchTs,
        updatedAt: batchTs,
        revision: ROW_REVISION
      }
    )
  })
  return { batches, snapshots }
}

/** 由原始行派生偏差率与异常标记 */
function buildSeedReadings(): ReadingRow[] {  return SEED_READING_ROWS.map(([patrolId, pointId, value, note], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const judgement = point
      ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
      : { isAbnormal: false, deviationPct: deviationPctOf(value, 0, 1) }
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  const { batches, snapshots } = buildSeedFlowData()
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.pipeSegments,
        db.flowBatches,
        db.flowSnapshots,
        db.segmentBalances
      ],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.readings.bulkPut(buildSeedReadings())
    await db.leaks.bulkPut(SEED_LEAKS)
    await db.pipeSegments.put(SEED_SEGMENT)
    await db.flowBatches.bulkPut(batches)
    await db.flowSnapshots.bulkPut(snapshots)

    // 已确认批次在播种时即生成冻结核算快照，作为「上一有效批次」沿用来源
    const patrolInputs = SEED_PATROLS.map((patrol) => ({
      id: patrol.id,
      stationId: patrol.stationId,
      planDate: patrol.planDate,
      patrolDate: patrol.patrolDate,
      patrolman: patrol.patrolman,
      envNote: patrol.envNote,
      state: patrol.state,
      readings: buildSeedReadings().filter((reading) => reading.patrolId === patrol.id)
    }))
    const seedBalances: SegmentBalanceRow[] = []
    batches
      .filter((batch) => batch.state === '已确认')
      .forEach((batch) => {
        const rows = freezeForConfirmation(
          batch,
          [SEED_SEGMENT],
          snapshots,
          patrolInputs,
          SEED_LEAKS,
          SEED_STATIONS,
          seedBalances,
          batch.confirmedAt ?? batch.createdAt
        )
        rows.forEach((row) => seedBalances.push({ ...row, revision: ROW_REVISION }))
      })
    await db.segmentBalances.bulkPut(seedBalances)
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.pipeSegments,
        db.flowBatches,
        db.flowSnapshots,
        db.segmentBalances
      ],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()

    // 拓扑：删除与该站相连的区段及其未归档核算结果（归档台账保留快照）
    const linkedSegments = await db.pipeSegments
      .filter((segment) => segment.upstreamStationId === stationId || segment.downstreamStationId === stationId)
      .toArray()
    if (linkedSegments.length > 0) {
      const segmentIds = [...new Set(linkedSegments.map((segment) => segment.id))]
      await db.pipeSegments.bulkDelete(segmentIds)
      await db.segmentBalances
        .where('segmentId')
        .anyOf(segmentIds)
        .filter((row) => !row.archived)
        .delete()
    }

    // 快照：清理该站快照；变空的流量包批次一并删除（未归档核算结果随后清）
    const stationSnapshots = await db.flowSnapshots.where('stationId').equals(stationId).toArray()
    if (stationSnapshots.length > 0) {
      const batchIds = [...new Set(stationSnapshots.map((snapshot) => snapshot.batchId))]
      await db.flowSnapshots.bulkDelete(stationSnapshots.map((snapshot) => snapshot.id))
      const emptyBatches: string[] = []
      await Promise.all(
        batchIds.map(async (batchId) => {
          if ((await db.flowSnapshots.where('batchId').equals(batchId).count()) === 0) emptyBatches.push(batchId)
        })
      )
      if (emptyBatches.length > 0) {
        await db.segmentBalances
          .where('batchId')
          .anyOf(emptyBatches)
          .filter((row) => !row.archived)
          .delete()
        await db.flowBatches.bulkDelete(emptyBatches)
      }
    }

    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.pipeSegments,
        db.flowBatches,
        db.flowSnapshots,
        db.segmentBalances
      ],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.pipeSegments,
        db.flowBatches,
        db.flowSnapshots,
        db.segmentBalances
      ],
      async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.pipeSegments,
        db.flowBatches,
        db.flowSnapshots,
        db.segmentBalances
      ],
      async () => {
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

/** 删除区段：连该区段的未归档核算结果一并清除（归档台账保留快照） */
export async function deleteSegmentCascade(segmentId: string): Promise<void> {
  await db.transaction('rw', [db.pipeSegments, db.segmentBalances], async () => {
    await db.segmentBalances.where('segmentId').equals(segmentId).filter((row) => !row.archived).delete()
    await db.pipeSegments.delete(segmentId)
  })
}

/** 删除流量包：批次、快照与其未归档核算结果同事务清除（归档台账保留快照） */
export async function deleteFlowBatchCascade(batchId: string): Promise<void> {
  await db.transaction('rw', [db.flowBatches, db.flowSnapshots, db.segmentBalances], async () => {
    await db.flowSnapshots.where('batchId').equals(batchId).delete()
    await db.segmentBalances
      .where('batchId')
      .equals(batchId)
      .filter((row) => !row.archived)
      .delete()
    await db.flowBatches.delete(batchId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入 ============================ */

/** 写入读数：自动与标准区间比对并落 isAbnormal / deviationPct */
export async function putReading(row: {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  createdAt: number
  updatedAt: number
}): Promise<ReadingRow> {
  const point = await db.points.get(row.pointId)
  const judgement = point
    ? judgeReading(row.value, point.standardMin, point.standardMax, point.isCritical)
    : { isAbnormal: false, deviationPct: 0 }
  const next: ReadingRow = {
    ...row,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/** 重算某点位全部读数的偏差率（标准值变更后调用） */
export async function recalculateReadingsOfPoint(pointId: string): Promise<void> {
  const point = await db.points.get(pointId)
  if (!point) return
  const rows = await db.readings.where('pointId').equals(pointId).toArray()
  if (rows.length === 0) return
  await db.readings.bulkPut(
    rows.map((row) => {
      const judgement = judgeReading(row.value, point.standardMin, point.standardMax, point.isCritical)
      return {
        ...row,
        isAbnormal: judgement.isAbnormal,
        deviationPct: judgement.deviationPct,
        updatedAt: Date.now()
      }
    })
  )
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, pipeSegments, flowBatches, flowSnapshots, segmentBalances] =
    await Promise.all([
      db.stations.count(),
      db.devices.count(),
      db.points.count(),
      db.patrols.count(),
      db.readings.count(),
      db.leaks.count(),
      db.pipeSegments.count(),
      db.flowBatches.count(),
      db.flowSnapshots.count(),
      db.segmentBalances.count()
    ])
  return { stations, devices, points, patrols, readings, leaks, pipeSegments, flowBatches, flowSnapshots, segmentBalances }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, pipeSegments, flowBatches, flowSnapshots, segmentBalances] =
    await Promise.all([
      db.stations.toArray(),
      db.devices.toArray(),
      db.points.toArray(),
      db.patrols.toArray(),
      db.readings.toArray(),
      db.leaks.toArray(),
      db.pipeSegments.toArray(),
      db.flowBatches.toArray(),
      db.flowSnapshots.toArray(),
      db.segmentBalances.toArray()
    ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbgaspress',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    devices: devices.map(strip),
    points: points.map(strip),
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip),
    pipeSegments: pipeSegments.map(strip),
    flowBatches: flowBatches.map(strip),
    flowSnapshots: flowSnapshots.map(strip),
    segmentBalances: segmentBalances.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.pipeSegments,
        db.flowBatches,
        db.flowSnapshots,
        db.segmentBalances
      ],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.pipeSegments.clear(),
      db.flowBatches.clear(),
      db.flowSnapshots.clear(),
      db.segmentBalances.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut((payload.readings ?? []).map(rev))
    await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
    await db.pipeSegments.bulkPut((payload.pipeSegments ?? []).map(rev))
    await db.flowBatches.bulkPut((payload.flowBatches ?? []).map(rev))
    await db.flowSnapshots.bulkPut((payload.flowSnapshots ?? []).map(rev))
    await db.segmentBalances.bulkPut((payload.segmentBalances ?? []).map(rev))
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [
        db.stations,
        db.devices,
        db.points,
        db.patrols,
        db.readings,
        db.leaks,
        db.pipeSegments,
        db.flowBatches,
        db.flowSnapshots,
        db.segmentBalances
      ],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.pipeSegments.clear(),
      db.flowBatches.clear(),
      db.flowSnapshots.clear(),
      db.segmentBalances.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyAbnormal: parsed.onlyAbnormal === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
