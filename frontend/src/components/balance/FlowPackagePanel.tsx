/**
 * 流量包面板：抄回进出口流量快照
 * - 粘贴 JSON 报文导入；重复批次号只刷新未确认结果；业务日期唯一
 * - 导入与核算在同一事务，写入失败回滚到导入前状态
 * - 确认后冻结为归档，只允许追加修订说明
 */
import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import BatchAuditDrawer from '@/components/balance/BatchAuditDrawer'
import { useStationStore } from '@/stores/stationStore'
import { useBalanceStore } from '@/stores/balanceStore'
import type { FlowBatch, FlowPackageInput } from '@/types/balance'
import { formatDateTime } from '@/types/balance'

function buildTemplate(stationRows: Array<{ id: string; designFlowM3h: number }>): string {
  const today = new Date().toISOString().slice(0, 10)
  const payload: FlowPackageInput = {
    batchNo: `FB${today.replace(/-/g, '')}`,
    bizDate: today,
    collector: '',
    source: 'SCADA 流量日报',
    snapshots: stationRows.map((station, index) => ({
      stationId: station.id,
      inletFlowM3h: station.designFlowM3h,
      outletFlowM3h: index === 0 ? Math.round(station.designFlowM3h * 0.97) : Math.round(station.designFlowM3h * 0.95),
      note: ''
    }))
  }
  return JSON.stringify(payload, null, 2)
}

export default function FlowPackagePanel() {
  const stationStore = useStationStore()
  const balanceStore = useBalanceStore()
  const [importOpen, setImportOpen] = useState(false)
  const [rawText, setRawText] = useState('')
  const [parseError, setParseError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [auditTarget, setAuditTarget] = useState<FlowBatch | null>(null)
  const [confirmForm] = Form.useForm<{ operator: string }>()
  const [revisionForm] = Form.useForm<{ operator: string; note: string }>()

  const template = useMemo(
    () =>
      buildTemplate(
        stationStore.stations.map((station) => ({ id: station.id, designFlowM3h: station.designFlowM3h }))
      ),
    [stationStore.stations]
  )

  const openImport = (): void => {
    if (balanceStore.segments.length === 0) {
      Message.warning('请先在「区段拓扑」页签维护上下游区段')
      return
    }
    setRawText(template)
    setParseError('')
    setImportOpen(true)
  }

  const submitImport = async (): Promise<void> => {
    let parsed: FlowPackageInput
    try {
      parsed = JSON.parse(rawText) as FlowPackageInput
    } catch {
      setParseError('JSON 解析失败，请检查报文格式')
      return
    }
    try {
      const result = await balanceStore.importFlowPackage(parsed)
      Message.success(
        result.refreshed
          ? `批次 ${result.batchNo} 为重复导入，已刷新未确认快照并重算 ${result.recomputedRows} 个区段结果`
          : `流量包 ${result.batchNo} 导入成功，已核算 ${result.recomputedRows} 个区段结果`
      )
      setImportOpen(false)
    } catch (error) {
      setParseError(error instanceof Error ? error.message : '导入失败，已回滚到导入前状态')
    }
  }

  const submitConfirm = async (): Promise<void> => {
    if (!confirmTarget) return
    const target = confirmTarget
    const values = await confirmForm.validate().catch(() => null)
    if (!values) return
    try {
      const { pendingRows } = await balanceStore.confirmBatch(target.id, values.operator)
      if (pendingRows > 0) {
        Message.warning(`批次已归档，其中 ${pendingRows} 个区段待补依据，损耗已沿用上一有效批次并保留标注`)
      } else {
        Message.success(`批次 ${target.batchNo} 已确认归档，核算结果冻结为快照`)
      }
      setConfirmOpen(false)
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '确认失败')
    }
  }

  const [confirmTarget, setConfirmTarget] = useState<FlowBatch | null>(null)
  const openConfirm = (batch: FlowBatch): void => {
    setConfirmTarget(batch)
    confirmForm.setFieldsValue({ operator: '' })
    setConfirmOpen(true)
  }

  const openRevision = (batch: FlowBatch): void => {
    setAuditTarget(batch)
    revisionForm.setFieldsValue({ operator: '', note: '' })
    setRevisionOpen(true)
  }

  const submitRevision = async (): Promise<void> => {
    if (!auditTarget) return
    const values = await revisionForm.validate().catch(() => null)
    if (!values) return
    try {
      await balanceStore.appendRevision(auditTarget.id, values.note, values.operator)
      Message.success('修订说明已追加到批次审计链，已核算数字保持不变')
      setRevisionOpen(false)
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '追加修订失败')
    }
  }

  const remove = async (batch: FlowBatch): Promise<void> => {
    try {
      await balanceStore.removeBatch(batch.id)
      Message.success('未确认批次已删除，相关未归档核算结果同步清理')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  const columns: TableColumnProps<FlowBatch>[] = [
    { title: '批次号', dataIndex: 'batchNo', width: 150, render: (value: string) => <strong>{value}</strong> },
    { title: '业务日期', dataIndex: 'bizDate', width: 110 },
    {
      title: '状态',
      width: 100,
      render: (_value, record) => <Tag color={record.state === '已确认' ? 'green' : 'orange'}>{record.state}</Tag>
    },
    { title: '抄回人', dataIndex: 'collector', width: 90, render: (value: string) => value || '—' },
    { title: '来源', dataIndex: 'source', width: 150, render: (value: string) => value || '—' },
    { title: '快照', dataIndex: 'snapshotCount', width: 70, render: (value: number) => `${value} 站` },
    {
      title: '当日核算',
      width: 180,
      render: (_value, record) => {
        const rows = balanceStore.balancesOfBatch(record.id)
        const pending = rows.filter((row) => row.status === '待补依据').length
        const over = rows.filter((row) => row.overThreshold).length
        return (
          <Space size={4} wrap>
            <Tag size="small">{rows.length} 区段</Tag>
            {pending > 0 ? <Tag color="red" size="small">待补 {pending}</Tag> : null}
            {over > 0 ? <Tag color="orange" size="small">超阈 {over}</Tag> : null}
            {pending === 0 && over === 0 && rows.length > 0 ? <Tag color="green" size="small">正常</Tag> : null}
          </Space>
        )
      }
    },
    { title: '导入时间', width: 150, render: (_value, record) => formatDateTime(record.importedAt) },
    {
      title: '操作',
      width: 290,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button type="text" size="small" onClick={() => setAuditTarget(record)}>
            批次审计
          </Button>
          {record.state === '待确认' ? (
            <>
              <Button type="text" size="small" onClick={() => openConfirm(record)}>
                确认归档
              </Button>
              <Popconfirm title="删除未确认批次将同步清理其未归档核算结果，确认？" onOk={() => remove(record)}>
                <Button type="text" size="small" status="danger">
                  删除
                </Button>
              </Popconfirm>
            </>
          ) : (
            <Button type="text" size="small" onClick={() => openRevision(record)}>
              追加修订
            </Button>
          )}
        </Space>
      )
    }
  ]

  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="panel-title" style={{ margin: 0 }}>
          流量包批次（{balanceStore.batches.length}）
        </h3>
        <Button type="primary" size="small" onClick={openImport}>
          导入流量包
        </Button>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        流量包只负责抄回进出口快照；表计缺失填 <code>null</code>，核算时标注「待补依据」并沿用上一有效批次，绝不把损耗算成零。
      </p>
      {balanceStore.batches.length === 0 ? (
        <EmptyPanel
          title="还没有流量包"
          description="粘贴 JSON 报文导入当日各站进出口流量快照，导入后自动按区段核算损耗。"
          actionText="导入流量包"
          onAction={openImport}
          compact
        />
      ) : (
        <Table<FlowBatch>
          rowKey="id"
          size="small"
          border
          data={balanceStore.batches}
          columns={columns}
          pagination={false}
          scroll={{ x: 1300 }}
        />
      )}

      <Modal
        visible={importOpen}
        title="导入流量包（进出口流量快照）"
        onCancel={() => setImportOpen(false)}
        onOk={submitImport}
        okText="导入并核算"
        cancelText="取消"
        unmountOnExit
        style={{ width: 720 }}
      >
        <Alert
          type="info"
          content={
            <div>
              报文按 <code>batchNo + bizDate</code> 幂等：重复导入同一批次号仅刷新<b>未确认</b>结果；已确认批次只能追加修订。
              每日仅允许一个批次，写入失败会自动回滚到导入前状态。
            </div>
          }
          style={{ marginBottom: 10 }}
        />
        {parseError ? <Alert type="error" content={parseError} style={{ marginBottom: 10 }} /> : null}
        <Input.TextArea
          value={rawText}
          onChange={setRawText}
          autoSize={{ minRows: 12, maxRows: 20 }}
          style={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: 12 }}
        />
        <Space style={{ marginTop: 8 }}>
          <Button size="mini" onClick={() => setRawText(template)}>
            重新生成模板
          </Button>
          <span className="muted">模板已按站点台账预填设计流量，缺失表计请把数值改为 null</span>
        </Space>
      </Modal>

      <Modal
        visible={confirmOpen}
        title={`确认归档批次 ${confirmTarget?.batchNo ?? ''}`}
        onCancel={() => setConfirmOpen(false)}
        onOk={submitConfirm}
        okText="确认并冻结"
        cancelText="取消"
        unmountOnExit
      >
        <Alert
          type="warning"
          content="确认后该业务日期的核算结果冻结为台账快照，后续拓扑或流量变化不再重算当日；待补依据区段会保留标注与上一有效批次沿用值。"
          style={{ marginBottom: 12 }}
        />
        <Form form={confirmForm} layout="vertical">
          <Form.Item field="operator" label="确认人" rules={[{ required: true, message: '请填写确认人' }]}>
            <Input placeholder="如 调度值班长" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={revisionOpen}
        title={`追加修订说明 · ${auditTarget?.batchNo ?? ''}`}
        onCancel={() => setRevisionOpen(false)}
        onOk={submitRevision}
        okText="追加修订"
        cancelText="取消"
        unmountOnExit
      >
        <Alert type="info" content="已确认批次的损耗数字与依据快照不可改写，修订仅追加留痕。" style={{ marginBottom: 12 }} />
        <Form form={revisionForm} layout="vertical">
          <Form.Item field="note" label="修订说明" rules={[{ required: true, message: '请填写修订说明' }]}>
            <Input.TextArea placeholder="如 经复核 06-05 损耗含站场自用气 80m³/h，修正口径说明（数字不变）" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
          <Form.Item field="operator" label="修订人" rules={[{ required: true, message: '请填写修订人' }]}>
            <Input placeholder="如 调度值班长" />
          </Form.Item>
        </Form>
      </Modal>

      <BatchAuditDrawer batch={auditTarget} visible={auditTarget !== null} onClose={() => setAuditTarget(null)} />
    </div>
  )
}
