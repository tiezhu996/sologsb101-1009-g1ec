/**
 * <BalanceBasisList> 核算依据明细：流量包 / 巡检 / 泄漏处置 / 沿用 / 待补 / 修订。
 * 待补依据高亮，避免把缺依据的损耗误读为 0。被核算台账详情抽屉消费。
 */
import { Tag, Typography } from '@arco-design/web-react'
import type { BalanceBasis, BalanceBasisKind } from '@/types/balance'

const KIND_COLOR: Record<BalanceBasisKind, string> = {
  流量包: 'arcoblue',
  巡检: 'cyan',
  泄漏处置: 'purple',
  沿用: 'gold',
  待补: 'orange',
  修订: 'magenta'
}

export interface BalanceBasisListProps {
  basis: BalanceBasis[]
}

export function BalanceBasisList({ basis }: BalanceBasisListProps) {
  if (basis.length === 0) {
    return <Typography.Text type="secondary">暂无核算依据</Typography.Text>
  }
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {basis.map((item, index) => (
        <li
          key={`${item.kind}-${index}`}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            padding: '6px 10px',
            borderRadius: 8,
            background: item.pending ? '#fff7e8' : '#f7f8fa',
            border: `1px solid ${item.pending ? '#ffcf8b' : '#e5e6eb'}`
          }}
        >
          <Tag color={KIND_COLOR[item.kind]} size="small" style={{ flex: '0 0 auto', marginTop: 2 }}>
            {item.kind}
          </Tag>
          <span style={{ fontSize: 13, color: item.pending ? '#b85c00' : '#1d2129', lineHeight: 1.6 }}>{item.text}</span>
        </li>
      ))}
    </ul>
  )
}

export default BalanceBasisList
