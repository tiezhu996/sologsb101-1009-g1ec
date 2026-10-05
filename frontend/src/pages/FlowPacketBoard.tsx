/**
 * /balance/flows 气量平衡 · 流量包快照
 * 导入进出口流量快照（JSON / 手工录入）→ 同批次重复导入只刷新未确认结果 → 确认后只能追加修订说明。
 * 写入失败自动恢复导入前状态。消费 FlowBatch、FlowSnapshot、Station；复用 <BalanceSubNav>、<StatBadge>。
 */
import { useState } from 'react'
import {
  Button,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Upload
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import StatBadge from '@/components/common/StatBadge'
import EmptyPanel from '@/components/common/EmptyPanel'
import BalanceSubNav from '@/components/common/BalanceSubNav'
import { useStationStore } from '@/stores/stationStore'
import { useBalanceStore } from '@/stores/balanceStore'
import { useFlowImport, type EditableSnapshotRow } from '@/hooks/useFlowImport'
import { ConfirmedBatchError } from '@/utils/balanceEngine'
import type { FlowBatch } from '@/types/flowBatch'
import { formatM3 } from '@/utils/balance'

export default function FlowPacketBoard() {
  const stationStore = useStationStore()
  const balanceStore = useBalanceStore()
  const [importOpen, setImportOpen] = useState(false)
  const [auditTarget, setAuditTarget] = useState<FlowBatch | null>(null)
  const [reviseTarget, setReviseTarget] = useState<FlowBatch | null>(null)
  const [reviseForm] = Form.useForm<{ note: string; author: string }>()

  const flowImport = useFlowImport(() => {
    /* 导入成功后由返回值提示，弹窗关闭由调用方处理 */
  })

  const stationName = (id: string): string => stationStore.stations.find((station) => station.id === id)?.name ?? '未知站点'

  const openImport = (): void => {
    flowImport.reset()
    setImportOpen(true)
  }

  const submitImport = async (): Promise<void> => {
    try {
      const result = await flowImport.submit()
      if (result) {
        Message.success(
          `${result.refreshed ? '已刷新未确认批次' : '流量包已导入'}：${result.snapshotCount} 个站点快照，受影响未归档日期已重算`
        )
        setImportOpen(false)
      }
    } catch (error) {
      if (error instanceof ConfirmedBatchError) {
        Message.warning(error.message)
      } else {
        Message.error(error instanceof Error ? `导入失败，已恢复导入前状态：${error.message}` : '导入失败，已恢复导入前状态')
      }
    }
  }

  const confirmBatch = async (batch: FlowBatch): Promise<void> => {
    await balanceStore.confirmBatch(batch.id)
    Message.success(`批次 ${batch.batchNo} 已确认，当日起的沿用/临时核算结果已转正`)
  }

  const openRevise = (batch: FlowBatch): void => {
    setReviseTarget(batch)
    reviseForm.setFieldsValue({ note: '', author: '' })
  }

  const submitRevise = async (): Promise<void> => {
    if (!reviseTarget) return
    const values = await reviseForm.validate().catch(() => null)
    if (!values) return
    await balanceStore.reviseBatch(reviseTarget.id, { note: values.note, author: values.author })
    Message.success('修订说明已追加（历史核算结果不改写）')
    setReviseTarget(null)
  }

  const removeBatch = async (batch: FlowBatch): Promise<void> => {
    try {
      await balanceStore.removeBatch(batch.id)
      Message.success('未确认批次及其快照已删除')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  const columns: TableColumnProps<FlowBatch>[] = [
    { title: '批次号', dataIndex: 'batchNo', width: 160, render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: '快照日期', dataIndex: 'snapshotDate', width: 120 },
    { title: '抄表负责人', dataIndex: 'recorder', width: 110, render: (v: string) => v || '—' },
    {
      title: '站点快照',
      width: 100,
      render: (_v, record) => <Tag>{balanceStore.snapshotsOfBatch(record.id).length} 站</Tag>
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 100,
      render: (v: FlowBatch['source']) => (v === 'json' ? 'JSON 导入' : '手工录入')
    },
    {
      title: '状态',
      width: 110,
      render: (_v, record) => (
        <Tag color={record.state === '已确认' ? 'green' : 'orange'}>
          {record.state}
          {record.revisions.length > 0 ? ` · 修订 ${record.revisions.length}` : ''}
        </Tag>
      )
    },
    {
      title: '操作',
      width: 300,
      render: (_v, record) => (
        <Space size={4} wrap>
          <Button type="text" size="small" onClick={() => setAuditTarget(record)}>
            批次审计
          </Button>
          {record.state === '已导入' ? (
            <>
              <Button type="text" size="small" status="success" onClick={() => confirmBatch(record)}>
                确认
              </Button>
              <Popconfirm title="仅未确认批次可删除，确认删除该批次及其快照？" onOk={() => removeBatch(record)}>
                <Button type="text" size="small" status="danger">
                  删除
                </Button>
              </Popconfirm>
            </>
          ) : (
            <Button type="text" size="small" onClick={() => openRevise(record)}>
              追加修订
            </Button>
          )}
        </Space>
      )
    }
  ]

  const confirmedCount = balanceStore.batches.filter((batch) => batch.state === '已确认').length
  const draftCount = balanceStore.batches.length - confirmedCount

  const renderEditableRow = (row: EditableSnapshotRow, index: number): React.ReactNode => (
    <Space key={`${row.stationRef}-${index}`} size={8} style={{ display: 'flex', marginBottom: 8 }} align="start">
      <Form.Item style={{ flex: 1, marginBottom: 0 }}>
        <Select
          value={row.matched ? row.stationRef : undefined}
          status={row.matched ? undefined : 'error'}
          placeholder={row.matched ? '' : `未匹配站点：${row.stationRef || '空'}`}
          showSearch
          allowCreate
          options={stationStore.stations.map((station) => ({ label: station.name, value: station.id }))}
          onChange={(value: string) => {
            const matched = stationStore.stations.some((station) => station.id === value || station.name === value)
            flowImport.setRow(index, { stationRef: value, matched })
          }}
        />
      </Form.Item>
      <Form.Item style={{ width: 150, marginBottom: 0 }}>
        <InputNumber
          value={row.inletFlowM3 ?? undefined}
          placeholder="进口(空=缺失)"
          onChange={(value) => flowImport.setRow(index, { inletFlowM3: value === undefined ? null : Number(value) })}
          style={{ width: '100%' }}
        />
      </Form.Item>
      <Form.Item style={{ width: 150, marginBottom: 0 }}>
        <InputNumber
          value={row.outletFlowM3 ?? undefined}
          placeholder="出口(空=缺失)"
          onChange={(value) => flowImport.setRow(index, { outletFlowM3: value === undefined ? null : Number(value) })}
          style={{ width: '100%' }}
        />
      </Form.Item>
    </Space>
  )

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">流量包快照（进出口流量抄回）</h2>
          <p className="page-head__desc">
            流量包负责抄回各站进出口流量。读数留空即「缺失」，核算时沿用上一有效批次并标记待补，绝不算 0。
            重复导入同一批次只刷新未确认结果；确认后只能追加修订说明。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={flowImport.downloadTemplate}>下载流量包模板</Button>
          <Button type="primary" onClick={openImport}>
            导入流量包
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="流量批次" value={balanceStore.batches.length} suffix="批" tone="primary" />
        <StatBadge label="已确认" value={confirmedCount} suffix="批" tone="success" />
        <StatBadge label="未确认" value={draftCount} suffix="批" tone="warning" />
        <StatBadge label="站点快照" value={balanceStore.snapshots.length} suffix="条" tone="info" />
      </div>

      <BalanceSubNav active="/balance/flows" />

      <div className="panel">
        {balanceStore.batches.length === 0 ? (
          <EmptyPanel
            title="还没有流量包"
            description="导入 JSON 流量包或手工录入各站当日进出口流量快照。"
            actionText="导入流量包"
            onAction={openImport}
            compact
          />
        ) : (
          <Table<FlowBatch> rowKey="id" size="small" border data={balanceStore.batches} columns={columns} pagination={false} />
        )}
      </div>

      {/* 导入弹窗 */}
      <Modal
        visible={importOpen}
        title="导入流量包快照"
        style={{ width: 860 }}
        onCancel={() => setImportOpen(false)}
        onOk={submitImport}
        okText="导入并重算"
        cancelText="取消"
        unmountOnExit
      >
        <Space size={12} wrap style={{ marginBottom: 12 }}>
          <Upload
            accept="application/json,.json"
            showUploadList={false}
            beforeUpload={(file: File) => {
              void file
                .text()
                .then((text) => flowImport.parseText(text))
                .catch((error: unknown) => Message.error(error instanceof Error ? error.message : '流量包解析失败'))
              return false
            }}
          >
            <Button type="outline">选择 JSON 流量包</Button>
          </Upload>
          <Button
            onClick={() => {
              flowImport.buildManualDraft()
              Message.info('已按台账站点生成空快照行，缺失读数请留空')
            }}
          >
            手工录入
          </Button>
          <Button onClick={flowImport.downloadTemplate}>下载模板</Button>
        </Space>

        <Form layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item label="批次号" style={{ flex: 1 }}>
              <Input placeholder="如 FB20240620-01" value={flowImport.draft.batchNo} onChange={(v) => flowImport.setField('batchNo', v)} />
            </Form.Item>
            <Form.Item label="快照日期" style={{ flex: 1 }}>
              <Input placeholder="YYYY-MM-DD" value={flowImport.draft.snapshotDate} onChange={(v) => flowImport.setField('snapshotDate', v)} />
            </Form.Item>
            <Form.Item label="抄表负责人" style={{ flex: 1 }}>
              <Input value={flowImport.draft.recorder} onChange={(v) => flowImport.setField('recorder', v)} />
            </Form.Item>
          </Space>
        </Form>

        {flowImport.draft.rows.length === 0 ? (
          <EmptyPanel title="尚未载入快照" description="选择 JSON 流量包，或点击「手工录入」生成各站空行。" compact />
        ) : (
          <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid #e5e6eb', borderRadius: 8, padding: 12 }}>
            <Space style={{ fontSize: 12, color: '#86909c', marginBottom: 8 }}>
              <span style={{ width: 260 }}>站点（编号或名称）</span>
              <span style={{ width: 150 }}>进口流量 m³/日</span>
              <span style={{ width: 150 }}>出口流量 m³/日</span>
            </Space>
            {flowImport.draft.rows.map(renderEditableRow)}
            <p className="muted" style={{ fontSize: 12 }}>
              读数留空表示当日未抄回，将沿用上一有效批次并在台账标记「待补依据」。
            </p>
          </div>
        )}
      </Modal>

      {/* 批次审计弹窗 */}
      <Modal
        visible={auditTarget !== null}
        title={auditTarget ? `批次审计 · ${auditTarget.batchNo}` : ''}
        style={{ width: 760 }}
        footer={null}
        onCancel={() => setAuditTarget(null)}
        unmountOnExit
      >
        {auditTarget ? (
          <div>
            <Space wrap style={{ marginBottom: 12 }}>
              <Tag color={auditTarget.state === '已确认' ? 'green' : 'orange'}>{auditTarget.state}</Tag>
              <Tag>快照日期 {auditTarget.snapshotDate}</Tag>
              <Tag>抄表 {auditTarget.recorder || '—'}</Tag>
              <Tag>{auditTarget.source === 'json' ? 'JSON 导入' : '手工录入'}</Tag>
            </Space>
            <Table
              size="small"
              border
              pagination={false}
              rowKey="id"
              data={balanceStore.snapshotsOfBatch(auditTarget.id)}
              columns={[
                { title: '站点', render: (_v, r) => stationName(r.stationId) },
                {
                  title: '进口流量',
                  dataIndex: 'inletFlowM3',
                  render: (v: number | null) => (v === null ? <Tag color="orange">缺失</Tag> : formatM3(v))
                },
                {
                  title: '出口流量',
                  dataIndex: 'outletFlowM3',
                  render: (v: number | null) => (v === null ? <Tag color="orange">缺失</Tag> : formatM3(v))
                },
                { title: '备注', dataIndex: 'note', render: (v: string) => v || '—' }
              ]}
            />
            <h4 style={{ margin: '16px 0 8px' }}>修订与审计记录</h4>
            {auditTarget.revisions.length === 0 ? (
              <p className="muted">无修订。确认后如需更正只能在此追加修订说明，不改写历史核算。</p>
            ) : (
              <Timeline>
                {auditTarget.revisions.map((revision, index) => (
                  <Timeline.Item key={index} label={new Date(revision.at).toLocaleString('zh-CN')}>
                    <strong>{revision.author || '未署名'}</strong>：{revision.note}
                  </Timeline.Item>
                ))}
              </Timeline>
            )}
          </div>
        ) : null}
      </Modal>

      {/* 追加修订弹窗 */}
      <Modal
        visible={reviseTarget !== null}
        title={reviseTarget ? `追加修订说明 · ${reviseTarget.batchNo}` : ''}
        onCancel={() => setReviseTarget(null)}
        onOk={submitRevise}
        okText="追加修订"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={reviseForm} layout="vertical">
          <Form.Item field="note" label="修订说明（只追加，不改写已确认结果）" rules={[{ required: true, message: '请填写修订说明' }]}>
            <Input.TextArea placeholder="如 出口流量计冻结，当日值改用调度 SCADA 日累计复核" autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
          <Form.Item field="author" label="修订人" rules={[{ required: true, message: '请填写修订人' }]}>
            <Input placeholder="如 王强" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
