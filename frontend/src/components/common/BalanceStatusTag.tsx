/**
 * <BalanceStatusTag> 核算状态标签：已核算 / 待补依据 / 已归档 / 临时值。
 * 被区段台账、流量包页、核算台账消费。
 */
import { Tag, Tooltip } from '@arco-design/web-react'
import type { BalanceRecord } from '@/types/balance'

export interface BalanceStatusTagProps {
  record: Pick<BalanceRecord, 'status' | 'pendingReason' | 'archived' | 'provisional' | 'carriedForward'>
  size?: 'small' | 'default'
}

export function BalanceStatusTag({ record, size = 'small' }: BalanceStatusTagProps) {
  const tags = []
  if (record.archived) {
    tags.push(
      <Tag key="archived" color="gray" size={size}>
        已归档
      </Tag>
    )
  } else if (record.status === '待补') {
    tags.push(
      <Tooltip key="pending" content={record.pendingReason || '存在待补依据'}>
        <Tag color="orange" size={size}>
          待补依据
        </Tag>
      </Tooltip>
    )
  } else {
    tags.push(
      <Tag key="ok" color="green" size={size}>
        已核算
      </Tag>
    )
  }
  if (record.provisional && !record.archived) {
    tags.push(
      <Tooltip key="prov" content="引用了未确认流量批次，批次确认后自动转正">
        <Tag color="arcoblue" size={size}>
          临时值
        </Tag>
      </Tooltip>
    )
  }
  if (record.carriedForward && !record.archived) {
    tags.push(
      <Tooltip key="carry" content={record.pendingReason || '当日读数缺失，沿用上一有效批次'}>
        <Tag color="gold" size={size}>
          沿用
        </Tag>
      </Tooltip>
    )
  }
  return <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{tags}</span>
}

export default BalanceStatusTag
