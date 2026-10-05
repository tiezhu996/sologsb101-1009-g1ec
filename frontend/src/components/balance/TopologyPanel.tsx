/**
 * 拓扑面板：维护站点上下游连接与方向（有向区段）及损耗率阈值。
 * 区段是损耗核算单元：损耗 = 上游站出口 − 下游站进口。
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
import { useStationStore } from '@/stores/stationStore'
import { useBalanceStore } from '@/stores/balanceStore'
import { DEFAULT_LOSS_RATE_THRESHOLD_PCT, type PipeSegment, type SegmentDraft } from '@/types/balance'

export default function TopologyPanel() {
  const stationStore = useStationStore()
  const balanceStore = useBalanceStore()
  const [form] = Form.useForm<SegmentDraft>()
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const stationName = useMemo(() => {
    const map = new Map(stationStore.stations.map((station) => [station.id, station]))
    return (id: string) => map.get(id)
  }, [stationStore.stations])

  const stationOptions = stationStore.stations.map((station) => ({
    label: `${station.name}（${station.grade}）`,
    value: station.id
  }))

  const openCreate = (): void => {
    if (stationStore.stations.length < 2) {
      Message.warning('至少需要 2 座调压站才能维护上下游区段')
      return
    }
    setEditingId(null)
    form.setFieldsValue({
      name: '',
      upstreamStationId: stationStore.stations[0]?.id,
      downstreamStationId: stationStore.stations[1]?.id,
      lossRateThresholdPct: DEFAULT_LOSS_RATE_THRESHOLD_PCT,
      remark: ''
    })
    setFormOpen(true)
  }

  const openEdit = (segment: PipeSegment): void => {
    setEditingId(segment.id)
    form.setFieldsValue({
      name: segment.name,
      upstreamStationId: segment.upstreamStationId,
      downstreamStationId: segment.downstreamStationId,
      lossRateThresholdPct: segment.lossRateThresholdPct,
      remark: segment.remark
    })
    setFormOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await form.validate().catch(() => null)
    if (!values) return
    try {
      if (editingId) {
        await balanceStore.updateSegment(editingId, values)
        Message.success('区段已更新，仅受影响的未归档日期会重新核算')
      } else {
        await balanceStore.createSegment(values)
        Message.success('区段已建立，未归档日期将自动补算')
      }
      setFormOpen(false)
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '区段保存失败')
    }
  }

  const remove = async (segment: PipeSegment): Promise<void> => {
    await balanceStore.removeSegment(segment.id)
    Message.success('区段已删除，未归档核算结果同步清理；已归档台账保留快照')
  }

  const columns: TableColumnProps<PipeSegment>[] = [
    {
      title: '区段',
      dataIndex: 'name',
      width: 200,
      render: (value: string, record) => (
        <Space size={8}>
          <span style={{ fontWeight: 600 }}>{value}</span>
          <Tag size="small">阈值 {record.lossRateThresholdPct}%</Tag>
        </Space>
      )
    },
    {
      title: '流向（上游出口 → 下游进口）',
      render: (_value, record) => {
        const upstream = stationName(record.upstreamStationId)
        const downstream = stationName(record.downstreamStationId)
        return (
          <Space size={8} wrap>
            <Tag color="arcoblue">{upstream ? upstream.name : '已删除站点'}</Tag>
            <span style={{ color: '#86909c' }}>──出口计量 → 进口计量──</span>
            <Tag color="green">{downstream ? downstream.name : '已删除站点'}</Tag>
          </Space>
        )
      }
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 260,
      render: (value: string) => value || '—'
    },
    {
      title: '操作',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该区段将清除其未归档核算结果，已归档台账保留。确认删除？"
            onOk={() => remove(record)}
          >
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="panel-title" style={{ margin: 0 }}>
          站间区段与流向（{balanceStore.segments.length}）
        </h3>
        <Button type="primary" size="small" onClick={openCreate}>
          新建区段
        </Button>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        区段方向决定取数口径：损耗 = 上游站出口流量 − 下游站进口流量。同一对站点仅允许一个有向区段。
      </p>
      {balanceStore.segments.length === 0 ? (
        <EmptyPanel
          title="还没有区段"
          description="先在调压站台账登记至少 2 座站点，再维护上下游连接与方向。"
          actionText="新建区段"
          onAction={openCreate}
          compact
        />
      ) : (
        <Table<PipeSegment>
          rowKey="id"
          size="small"
          border
          data={balanceStore.segments}
          columns={columns}
          pagination={false}
        />
      )}

      <Modal
        visible={formOpen}
        title={editingId ? '编辑区段' : '新建区段（上下游连接）'}
        onCancel={() => setFormOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={form} layout="vertical">
          <Form.Item field="name" label="区段名称" rules={[{ required: true, message: '请填写区段名称' }]}>
            <Input placeholder="如 城东—西城连通段" />
          </Form.Item>
          <Form.Item field="upstreamStationId" label="上游站点（取出口流量）" rules={[{ required: true, message: '请选择上游站点' }]}>
            <Select options={stationOptions} showSearch />
          </Form.Item>
          <Form.Item field="downstreamStationId" label="下游站点（取进口流量）" rules={[{ required: true, message: '请选择下游站点' }]}>
            <Select options={stationOptions} showSearch />
          </Form.Item>
          <Form.Item field="lossRateThresholdPct" label="损耗率告警阈值（%）" rules={[{ required: true, message: '请填写阈值' }]}>
            <InputNumber min={0} max={100} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="remark" label="备注">
            <Input.TextArea placeholder="管线走向、历史损耗水平等" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
