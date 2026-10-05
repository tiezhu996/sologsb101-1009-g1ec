/**
 * /balance/segments 气量平衡 · 区段拓扑
 * 维护站点上下游连接与方向、区段超阈值；保存后只重算受影响区段的未归档日期。
 * 消费 Segment、Station、BalanceRecord；复用 <StatBadge>、<EmptyPanel>、<BalanceSubNav>。
 */
import { useMemo, useState } from 'react'
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
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import StatBadge from '@/components/common/StatBadge'
import BalanceSubNav from '@/components/common/BalanceSubNav'
import { useStationStore } from '@/stores/stationStore'
import { useBalanceStore } from '@/stores/balanceStore'
import {
  DEFAULT_SEGMENT_THRESHOLD_M3,
  EMPTY_SEGMENT_DRAFT,
  type Segment,
  type SegmentDraft
} from '@/types/segment'

export default function SegmentList() {
  const stationStore = useStationStore()
  const balanceStore = useBalanceStore()
  const [form] = Form.useForm<SegmentDraft>()
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const stationName = (id: string): string => stationStore.stations.find((station) => station.id === id)?.name ?? '未知站点'

  const openCreate = (): void => {
    if (stationStore.stations.length < 2) {
      Message.warning('至少需要两座调压站才能建立区段连接')
      return
    }
    setEditingId(null)
    form.setFieldsValue({
      ...EMPTY_SEGMENT_DRAFT,
      upstreamStationId: stationStore.stations[0].id,
      downstreamStationId: stationStore.stations[1]?.id ?? stationStore.stations[0].id,
      direction: `${stationStore.stations[0].name} → ${stationStore.stations[1]?.name ?? ''}`
    })
    setFormOpen(true)
  }

  const openEdit = (segment: Segment): void => {
    setEditingId(segment.id)
    form.setFieldsValue({
      code: segment.code,
      name: segment.name,
      upstreamStationId: segment.upstreamStationId,
      downstreamStationId: segment.downstreamStationId,
      direction: segment.direction,
      lengthKm: segment.lengthKm,
      thresholdM3: segment.thresholdM3,
      note: segment.note
    })
    setFormOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await form.validate().catch(() => null)
    if (!values) return
    try {
      if (editingId) {
        await balanceStore.updateSegment(editingId, values)
        Message.success('区段拓扑已更新，已重算受影响的未归档日期')
      } else {
        await balanceStore.createSegment(values)
        Message.success('区段已建立，已按流量包日期核算未归档结果')
      }
      setFormOpen(false)
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '区段保存失败')
    }
  }

  const remove = async (segment: Segment): Promise<void> => {
    await balanceStore.removeSegment(segment.id)
    Message.success('区段及其核算记录已删除')
  }

  const stationOptions = useMemo(
    () => stationStore.stations.map((station) => ({ label: station.name, value: station.id })),
    [stationStore.stations]
  )

  const columns: TableColumnProps<Segment>[] = [
    { title: '编号', dataIndex: 'code', width: 120 },
    { title: '区段名称', dataIndex: 'name', width: 200 },
    {
      title: '上游（出口）',
      width: 180,
      render: (_v, record) => <Tag color="arcoblue">{stationName(record.upstreamStationId)}</Tag>
    },
    {
      title: '方向',
      width: 160,
      render: (_v, record) => <span style={{ color: '#165dff' }}>{record.direction || '→'}</span>
    },
    {
      title: '下游（进口）',
      width: 180,
      render: (_v, record) => <Tag color="green">{stationName(record.downstreamStationId)}</Tag>
    },
    { title: '长度(km)', dataIndex: 'lengthKm', width: 100, render: (v: number) => v || '—' },
    {
      title: '超阈值(m³/日)',
      dataIndex: 'thresholdM3',
      width: 130,
      render: (v: number) => <span style={{ fontWeight: 600 }}>{v}</span>
    },
    {
      title: '未归档核算',
      width: 110,
      render: (_v, record) => {
        const count = balanceStore.recordsOfSegment(record.id).filter((item) => !item.archived).length
        return <Tag>{count} 日</Tag>
      }
    },
    {
      title: '操作',
      width: 160,
      render: (_v, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="删除区段会同时删除其核算记录，确认？" onOk={() => remove(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">区段拓扑（上下游连接与方向）</h2>
          <p className="page-head__desc">
            按「上游站出口 → 下游站进口」维护管段方向与超阈值。拓扑更新后只重算受影响的未归档日期，已归档日期保留快照。
          </p>
        </div>
        <div className="page-head__actions">
          <Button type="primary" onClick={openCreate}>
            新建区段
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="区段总数" value={balanceStore.segments.length} suffix="段" tone="primary" />
        <StatBadge label="台账站点" value={stationStore.stations.length} suffix="座" tone="info" />
        <StatBadge label="超阈区段/日" value={balanceStore.overThresholdCount()} suffix="日" tone="danger" />
        <StatBadge label="待补依据" value={balanceStore.pendingCount()} suffix="日" tone="warning" />
      </div>

      <BalanceSubNav active="/balance/segments" />

      <div className="panel">
        {balanceStore.segments.length === 0 ? (
          <EmptyPanel
            title="还没有区段连接"
            description="先建立两座站点之间的上下游管段，才能按区段核算气量损耗。"
            actionText="新建区段"
            onAction={openCreate}
            compact
          />
        ) : (
          <Table<Segment> rowKey="id" size="small" border data={balanceStore.segments} columns={columns} pagination={false} scroll={{ x: 1300 }} />
        )}
      </div>

      <Modal
        visible={formOpen}
        title={editingId ? '编辑区段拓扑' : '新建区段'}
        onCancel={() => setFormOpen(false)}
        onOk={submit}
        okText="保存并重算"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={form} layout="vertical" initialValues={EMPTY_SEGMENT_DRAFT}>
          <Form.Item field="code" label="区段编号" rules={[{ required: true, message: '请填写区段编号' }]}>
            <Input placeholder="如 SEC-D01" />
          </Form.Item>
          <Form.Item field="name" label="区段名称">
            <Input placeholder="如 城东—西城中压联络管段" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              field="upstreamStationId"
              label="上游站点（取出口流量）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请选择上游站点' }]}
            >
              <Select options={stationOptions} showSearch />
            </Form.Item>
            <Form.Item
              field="downstreamStationId"
              label="下游站点（取进口流量）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请选择下游站点' }]}
            >
              <Select options={stationOptions} showSearch />
            </Form.Item>
          </Space>
          <Form.Item field="direction" label="流向描述">
            <Input placeholder="如 城东 → 西城" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item field="lengthKm" label="管段长度(km)" style={{ flex: 1 }}>
              <InputNumber min={0} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item field="thresholdM3" label="损耗超阈值(m³/日)" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: '100%' }} placeholder={`默认 ${DEFAULT_SEGMENT_THRESHOLD_M3}`} />
            </Form.Item>
          </Space>
          <Form.Item field="note" label="备注">
            <Input.TextArea placeholder="阀井、管线材质等" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
